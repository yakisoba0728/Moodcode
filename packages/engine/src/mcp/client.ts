import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { cappedJson, MCP_LIMITS, object, type JsonRpcMessage, type JsonRpcRequest, type McpProtocolVersion, type McpTransport } from './protocol.js';
import { schemaHeaders, projectHeaders, type HeaderProjection } from './schema-headers.js';
export interface McpClientOptions { id: string; transport: McpTransport; protocolVersion?: McpProtocolVersion; requestTimeoutMs?: number }
export interface McpTool { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject }
export interface McpResource { uri: string; name: string; description?: string; mimeType?: string }
interface Pending { resolve(value: JsonObject): void; reject(error: EngineError): void; detach(): void }
/** No provider, sampling or filesystem authority is given to the remote server. */
export class McpClient {
  readonly id: string; readonly protocolVersion: McpProtocolVersion;
  private state: 'new' | 'connecting' | 'connected' | 'closed' = 'new'; private current = 0; private nextId = 1;
  private pending = new Map<number, Pending>(); private closedListeners = new Set<() => void>(); private changedListeners = new Set<() => void>();
  private capabilities: JsonObject = {}; private tools = new Map<string, McpTool>(); private headers = new Map<string, HeaderProjection[]>(); private resources = new Map<string, McpResource>();
  constructor(private readonly options: McpClientOptions) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(options.id)) throw new EngineError('INVALID_MCP_ID', 'MCP connection id must be a bounded stable identifier');
    this.id = options.id; this.protocolVersion = options.protocolVersion ?? '2026-07-28';
    if (!['2026-07-28', '2025-11-25'].includes(this.protocolVersion) || !Number.isSafeInteger(options.requestTimeoutMs ?? MCP_LIMITS.requestTimeoutMs) || (options.requestTimeoutMs ?? MCP_LIMITS.requestTimeoutMs) < 1 || (options.requestTimeoutMs ?? MCP_LIMITS.requestTimeoutMs) > 60_000) throw new EngineError('INVALID_MCP_OPTIONS', 'MCP version or request timeout is unsupported');
  }
  get revision(): number { return this.current; }
  get connected(): boolean { return this.state === 'connected'; }
  onClose(listener: () => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener); }
  onCatalogChanged(listener: () => void): () => void { this.changedListeners.add(listener); return () => this.changedListeners.delete(listener); }
  private meta(params: JsonObject): JsonObject { return this.protocolVersion === '2026-07-28' ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': this.protocolVersion, 'io.modelcontextprotocol/clientInfo': { name: 'Moodcode', version: '0.1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : params; }
  async connect(signal: AbortSignal): Promise<void> {
    if (this.state !== 'new') throw new EngineError('MCP_CONNECTION_STATE', 'MCP connection can initialize only once'); this.state = 'connecting';
    try {
      await this.options.transport.start(message => this.receive(message), error => this.disconnected(error));
      const result = this.protocolVersion === '2026-07-28' ? await this.request('server/discover', {}, signal, true) : await this.request('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'Moodcode', version: '0.1.0' } }, signal, true);
      if (this.protocolVersion === '2026-07-28' ? !Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(this.protocolVersion) : result.protocolVersion !== this.protocolVersion) throw new EngineError('MCP_VERSION_UNSUPPORTED', 'MCP server does not support the explicitly selected protocol version');
      if (!object(result.capabilities)) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP server capabilities must be an object'); this.capabilities = result.capabilities;
      if (this.protocolVersion === '2025-11-25') await this.options.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
      if (signal.aborted || String(this.state) === 'closed') throw new EngineError('MCP_CANCELLED', 'MCP initialization was interrupted'); this.state = 'connected'; this.current++;
    } catch (error) { await this.close(); throw error; }
  }
  private receive(message: JsonRpcMessage): void {
    if (this.state === 'closed') return;
    if ('method' in message) {
      if (message.id !== undefined) {
        if (this.protocolVersion === '2025-11-25') void this.options.transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Host capabilities are unavailable' } }).catch(() => {});
        else this.disconnected(new EngineError('MCP_UNSUPPORTED_SERVER_REQUEST', 'Modern MCP servers cannot issue independent client requests'));
        return;
      }
      if (message.method === 'notifications/tools/list_changed' || message.method === 'notifications/resources/list_changed') { this.current++; this.tools.clear(); this.headers.clear(); this.resources.clear(); for (const listener of this.changedListeners) { try { listener(); } catch {} } }
      return;
    }
    if (typeof message.id !== 'number') return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); pending.detach();
    if ('error' in message) { pending.reject(new EngineError('MCP_REMOTE_ERROR', 'MCP server reported an operation error', { rpcCode: message.error.code })); return; }
    if (!object(message.result)) { pending.reject(new EngineError('MCP_INVALID_MESSAGE', 'MCP operation result must be an object')); return; }
    if (this.protocolVersion === '2026-07-28' && message.result.resultType === 'input_required') { pending.reject(new EngineError('MCP_INPUT_REQUIRED_UNSUPPORTED', 'MCP server requires a host interaction that this adapter has not enabled')); return; }
    pending.resolve(message.result);
  }
  private disconnected(error?: EngineError): void {
    if (this.state === 'closed') return; this.state = 'closed'; this.current++; this.tools.clear(); this.headers.clear(); this.resources.clear();
    for (const pending of this.pending.values()) { pending.detach(); pending.reject(error ?? new EngineError('MCP_DISCONNECTED', 'MCP connection closed')); } this.pending.clear();
    for (const listener of this.closedListeners) { try { listener(); } catch {} }
    this.closedListeners.clear(); this.changedListeners.clear();
    void this.options.transport.close().catch(() => {});
  }
  private request(method: string, params: JsonObject, signal: AbortSignal, initializing = false, headers?: Readonly<Record<string, string>>): Promise<JsonObject> {
    if (signal.aborted) return Promise.reject(new EngineError('MCP_CANCELLED', 'MCP request cancelled'));
    if (this.state !== 'connected' && !(initializing && this.state === 'connecting')) return Promise.reject(new EngineError('MCP_DISCONNECTED', 'MCP connection is unavailable'));
    if (this.pending.size >= MCP_LIMITS.maxPending) return Promise.reject(new EngineError('MCP_PENDING_LIMIT', 'MCP pending request limit exceeded'));
    const id = this.nextId++; const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: this.meta(cappedJson(params) as JsonObject) };
    return new Promise((resolve, reject) => {
      const finish = (error: EngineError) => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); pending.detach(); void this.options.transport.cancel(id).catch(() => {}); reject(error); };
      const timer = setTimeout(() => finish(new EngineError('MCP_REQUEST_TIMEOUT', 'MCP request exceeded its time limit')), this.options.requestTimeoutMs ?? MCP_LIMITS.requestTimeoutMs);
      const abort = () => finish(new EngineError('MCP_CANCELLED', 'MCP request cancelled'));
      this.pending.set(id, { resolve, reject, detach: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } }); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
      void this.options.transport.send(message, signal, headers).catch(error => finish(error instanceof EngineError ? error : new EngineError('MCP_TRANSPORT_FAILED', 'MCP request transport failed')));
    });
  }
  async listTools(signal: AbortSignal): Promise<McpTool[]> {
    if (!Object.hasOwn(this.capabilities, 'tools')) return []; const tools = new Map<string, McpTool>(); const headers = new Map<string, HeaderProjection[]>(); let cursor: string | undefined; const revision = this.current;
    for (let page = 0; page < MCP_LIMITS.maxPages; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal); if (!Array.isArray(result.tools)) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP tool catalogue is invalid');
      for (const raw of result.tools) {
        if (!object(raw) || typeof raw.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(raw.name) || typeof raw.description !== 'string' && raw.description !== undefined || !object(raw.inputSchema) || tools.has(raw.name)) throw new EngineError('MCP_INVALID_TOOL', 'MCP tool definition or identity is invalid');
        if (tools.size >= MCP_LIMITS.maxTools) throw new EngineError('MCP_CATALOGUE_LIMIT', 'MCP tool catalogue exceeds registration limit');
        const schema = cappedJson(raw.inputSchema, 64 * 1024) as JsonObject; let projected: HeaderProjection[] = [];
        if (this.protocolVersion === '2026-07-28' && this.options.transport.kind === 'http') { try { projected = schemaHeaders(schema); } catch { continue; } }
        tools.set(raw.name, { name: raw.name, description: typeof raw.description === 'string' ? raw.description : 'MCP remote tool', inputSchema: schema, ...(object(raw.annotations) ? { annotations: raw.annotations } : {}) }); headers.set(raw.name, projected);
      }
      if (result.nextCursor === undefined) { if (!this.connected || this.current !== revision) throw new EngineError('MCP_CATALOGUE_STALE', 'MCP catalogue changed during discovery'); this.tools = tools; this.headers = headers; this.current++; return structuredClone([...tools.values()]); }
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || Buffer.byteLength(result.nextCursor) > 2048 || result.nextCursor === cursor) throw new EngineError('MCP_INVALID_CURSOR', 'MCP catalogue cursor is invalid'); cursor = result.nextCursor;
    }
    throw new EngineError('MCP_CATALOGUE_LIMIT', 'MCP tool pagination exceeds its page limit');
  }
  async callTool(name: string, input: JsonObject, expectedRevision: number, signal: AbortSignal): Promise<JsonObject> {
    if (!this.connected || expectedRevision !== this.current || !this.tools.has(name)) throw new EngineError('MCP_CATALOGUE_STALE', 'MCP tool catalogue changed or disconnected; rediscover and approve again');
    return this.request('tools/call', { name, arguments: cappedJson(input, 256 * 1024) }, signal, false, projectHeaders(this.headers.get(name) ?? [], input));
  }
  async listResources(signal: AbortSignal): Promise<McpResource[]> {
    if (!Object.hasOwn(this.capabilities, 'resources')) return []; const resources = new Map<string, McpResource>(); let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.maxPages; page++) { const result = await this.request('resources/list', cursor ? { cursor } : {}, signal); if (!Array.isArray(result.resources)) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP resource catalogue is invalid');
      for (const raw of result.resources) { if (!object(raw) || typeof raw.uri !== 'string' || !raw.uri || Buffer.byteLength(raw.uri) > 4096 || typeof raw.name !== 'string' || Buffer.byteLength(raw.name) > 512 || resources.has(raw.uri)) throw new EngineError('MCP_INVALID_RESOURCE', 'MCP resource identity is invalid'); if (resources.size >= MCP_LIMITS.maxResources) throw new EngineError('MCP_CATALOGUE_LIMIT', 'MCP resource limit exceeded'); resources.set(raw.uri, { uri: raw.uri, name: raw.name, ...(typeof raw.description === 'string' ? { description: raw.description } : {}), ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}) }); }
      if (result.nextCursor === undefined) { this.resources = resources; return structuredClone([...resources.values()]); } if (typeof result.nextCursor !== 'string' || !result.nextCursor || Buffer.byteLength(result.nextCursor) > 2048 || result.nextCursor === cursor) throw new EngineError('MCP_INVALID_CURSOR', 'MCP resource cursor is invalid'); cursor = result.nextCursor;
    } throw new EngineError('MCP_CATALOGUE_LIMIT', 'MCP resource pagination exceeds page limit');
  }
  async readResource(uri: string, signal: AbortSignal): Promise<JsonObject> { if (!this.resources.has(uri)) throw new EngineError('MCP_RESOURCE_UNAVAILABLE', 'Resource URI must come from this connected server catalogue'); const result = await this.request('resources/read', { uri }, signal); if (!Array.isArray(result.contents) || result.contents.length > 64 || result.contents.some(content => !object(content) || typeof content.uri !== 'string' || typeof content.text !== 'string' && typeof content.blob !== 'string')) throw new EngineError('MCP_INVALID_RESOURCE', 'MCP resource contents are invalid'); return result; }
  async close(): Promise<void> { this.disconnected(); await this.options.transport.close(); }
}
