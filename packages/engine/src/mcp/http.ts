import { EngineError } from '@moodcode/contracts';
import type { CredentialBroker, CredentialReference } from '../credentials/index.js';
import { SseDataParser } from '../provider/sse.js';
import { encodeMessage, markMcpDispatchTransport, MCP_LIMITS, parseMessage, type JsonRpcMessage, type McpProtocolVersion, type McpTransport, type McpTransportSendObservation } from './protocol.js';
export interface HttpMcpOptions { url: string; protocolVersion?: McpProtocolVersion; credential?: { broker: CredentialBroker; reference: CredentialReference }; fetch?: typeof fetch }
function cleanupFailure(message: string): EngineError { return new EngineError('MCP_TRANSPORT_CLEANUP_UNCERTAIN', message, { cleanupUncertain: true, transportCleanupConfirmed: false }); }
async function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> { try { await body?.cancel(); } catch { throw cleanupFailure('MCP HTTP response body did not confirm local cleanup'); } }
const messageLimit = () => new EngineError('MCP_MESSAGE_LIMIT', 'MCP HTTP response exceeds its total byte budget');
const sseErrors = { frameLimit: messageLimit, malformed: () => new EngineError('MCP_HTTP_FAILED', 'MCP HTTP transport failed') };
export function headerValue(value: string): string { return /^[\x20-\x7e]*$/.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?=')) ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`; }
/** POST JSON/SSE transport. Legacy sessions are supported only under the explicit 2025 pin. */
export class HttpMcpTransport implements McpTransport {
  readonly kind = 'http' as const; readonly url: string; private started = false; private closed = false; private sessionId?: string; private version: McpProtocolVersion;
  private receive?: (message: JsonRpcMessage) => void; private disconnected?: (error?: EngineError) => void; private active = new Map<number | string, AbortController>(); private notifications = new Set<AbortController>(); private closePromise?: Promise<void>;
  constructor(private readonly options: HttpMcpOptions) {
    let url: URL; try { url = new URL(options.url); } catch { throw new EngineError('INVALID_MCP_HTTP', 'MCP endpoint must be an absolute URL'); }
    if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new EngineError('INVALID_MCP_HTTP', 'MCP endpoint requires HTTPS or explicit loopback HTTP, without URL credentials/query/fragment');
    this.url = url.href; this.version = options.protocolVersion ?? '2026-07-28';
    if (!['2026-07-28', '2025-11-25'].includes(this.version)) throw new EngineError('MCP_VERSION_UNSUPPORTED', 'MCP transport protocol version is unsupported');
    markMcpDispatchTransport(this, HttpMcpTransport.prototype.send);
  }
  async start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: EngineError) => void): Promise<void> { if (this.started || this.closed) throw new EngineError('MCP_TRANSPORT_STATE', 'MCP HTTP transport can start only once'); this.started = true; this.receive = onMessage; this.disconnected = onClose; }
  private headers(message?: JsonRpcMessage, authorization?: string): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.version });
    if (this.sessionId && this.version === '2025-11-25') headers.set('Mcp-Session-Id', this.sessionId);
    if (authorization) headers.set('Authorization', authorization);
    if (this.version === '2026-07-28' && message && 'method' in message) {
      headers.set('Mcp-Method', message.method);
      const field = message.method === 'resources/read' ? message.params?.uri : message.method === 'tools/call' || message.method === 'prompts/get' ? message.params?.name : undefined;
      if (typeof field === 'string') headers.set('Mcp-Name', headerValue(field));
      const meta = message.params?._meta; if (meta && typeof meta === 'object' && !Array.isArray(meta) && meta['io.modelcontextprotocol/protocolVersion'] !== this.version) throw new EngineError('MCP_VERSION_MISMATCH', 'MCP body/header protocol versions must match');
    }
    return headers;
  }
  async send(message: JsonRpcMessage, signal?: AbortSignal, extraHeaders: Readonly<Record<string, string>> = {}, observation?: McpTransportSendObservation): Promise<void> {
    if (!this.started || this.closed) throw new EngineError('MCP_DISCONNECTED', 'MCP HTTP transport is disconnected'); if (signal?.aborted) throw new EngineError('MCP_CANCELLED', 'MCP HTTP request cancelled');
    const body = encodeMessage(message); const controller = new AbortController(); const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const id = 'id' in message ? message.id : undefined; if (id === undefined) this.notifications.add(controller); else { if (this.active.size >= MCP_LIMITS.maxPending) throw new EngineError('MCP_PENDING_LIMIT', 'MCP HTTP request limit reached'); this.active.set(id, controller); }
    const operation = async (authorization?: string) => {
      const headers = this.headers(message, authorization);
      for (const [name, value] of Object.entries(extraHeaders)) { if (!/^Mcp-Param-[!#$%&'*+.^_`|~A-Za-z0-9-]{1,128}$/.test(name) || typeof value !== 'string' || Buffer.byteLength(value) > 16_384) throw new EngineError('MCP_INVALID_HEADER', 'MCP custom parameter header is invalid'); headers.set(name, value); }
      if (this.closed || combined.aborted) throw new EngineError('MCP_CANCELLED', 'MCP HTTP request cancelled before dispatch');
      observation?.beforeSend();
      const response = await (this.options.fetch ?? fetch)(this.url, { method: 'POST', redirect: 'error', headers, body, signal: combined });
      if (this.version === '2025-11-25' && 'method' in message && message.method === 'initialize') { const session = response.headers.get('Mcp-Session-Id'); if (session !== null) { if (!/^[\x21-\x7e]{1,1024}$/.test(session)) throw new EngineError('MCP_INVALID_SESSION', 'MCP server returned an invalid session identity'); this.sessionId = session; } }
      if (this.version === '2025-11-25' && response.status === 404 && this.sessionId) { await cancelBody(response.body); throw new EngineError('MCP_SESSION_EXPIRED', 'MCP session expired; reconnect explicitly before issuing new calls'); }
      if (id === undefined) { await cancelBody(response.body); if (response.status !== 202 && response.status !== 204) throw new EngineError('MCP_HTTP_STATUS', 'MCP server rejected notification'); return; }
      if (!response.body) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP HTTP response has no body');
      const type = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/json' && type !== 'text/event-stream') { await cancelBody(response.body); throw new EngineError('MCP_HTTP_STATUS', 'MCP server returned unsupported response content type'); }
      const reader = (() => { try { return response.body!.getReader(); } catch { throw cleanupFailure('MCP HTTP response reader could not be acquired for local cleanup'); } })();
      let total = 0; let json = ''; const decoder = new TextDecoder('utf-8', { fatal: true }); const sse = type === 'text/event-stream' ? new SseDataParser(MCP_LIMITS.maxMessageBytes, sseErrors) : undefined;
      try {
        const receive = (raw: string) => { const value = parseMessage(raw); if ('id' in value && !('method' in value) && value.id !== id) throw new EngineError('MCP_RESPONSE_ID_MISMATCH', 'MCP response belongs to a different request'); this.receive?.(value); return 'id' in value && !('method' in value); };
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > MCP_LIMITS.maxMessageBytes) throw messageLimit();
          if (!sse) json += decoder.decode(chunk.value, { stream: true });
          else for (const data of sse.push(chunk.value)) if (data && receive(data)) return;
        }
        if (!sse) { receive(json + decoder.decode()); return; }
        const data = sse.end(); if (data && receive(data)) return;
        throw new EngineError('MCP_DISCONNECTED', 'MCP SSE response ended before its correlated result');
      } finally {
        try { await reader.cancel(); }
        catch { throw cleanupFailure('MCP HTTP response reader did not confirm local cleanup'); }
        finally { try { reader.releaseLock(); } catch { throw cleanupFailure('MCP HTTP response reader lock did not confirm release'); } }
      }
    };
    try { if (this.options.credential) await this.options.credential.broker.withAuthorization(this.options.credential.reference, this.url, combined, auth => operation(auth)); else await operation(); }
    catch (error) {
      const safe = error instanceof EngineError ? error : new EngineError('MCP_HTTP_FAILED', 'MCP HTTP transport failed');
      if (combined.aborted && safe.details?.cleanupUncertain !== true) throw new EngineError('MCP_CANCELLED', 'MCP HTTP request cancelled');
      if (['MCP_SESSION_EXPIRED', 'MCP_DISCONNECTED', 'MCP_INVALID_MESSAGE', 'MCP_MESSAGE_LIMIT', 'MCP_RESPONSE_ID_MISMATCH'].includes(safe.code)) await this.fail(safe);
      throw safe;
    } finally { if (id === undefined) this.notifications.delete(controller); else this.active.delete(id); }
  }
  async cancel(requestId: number): Promise<void> { this.active.get(requestId)?.abort(); if (this.version === '2025-11-25' && !this.closed) await this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }).catch(() => {}); }
  private async fail(error: EngineError): Promise<void> { if (this.closed) return; this.closed = true; for (const controller of this.active.values()) controller.abort(); for (const controller of this.notifications) controller.abort(); this.disconnected?.(error); }
  close(): Promise<void> { return this.closePromise ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.closed) return; this.closed = true; for (const controller of this.active.values()) controller.abort(); for (const controller of this.notifications) controller.abort(); this.disconnected?.();
    if (this.version === '2025-11-25' && this.sessionId) {
      const signal = AbortSignal.timeout(1000); const operation = async (authorization?: string) => { const response = await (this.options.fetch ?? fetch)(this.url, { method: 'DELETE', redirect: 'error', headers: this.headers(undefined, authorization), signal }); await cancelBody(response.body); };
      try { if (this.options.credential) await this.options.credential.broker.withAuthorization(this.options.credential.reference, this.url, signal, auth => operation(auth)); else await operation(); } catch (error) { if (error instanceof EngineError && error.details?.cleanupUncertain === true) throw error; /* Remote termination failures cannot confirm or deny an operation outcome. */ }
    }
  }
}
