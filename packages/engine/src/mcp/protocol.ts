import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { boundedJson, JsonBudgetError } from '../artifacts/validation.js';
export type McpProtocolVersion = '2026-07-28' | '2025-11-25';
export interface JsonRpcRequest { jsonrpc: '2.0'; id?: number | string; method: string; params?: JsonObject }
export type JsonRpcMessage = JsonRpcRequest | { jsonrpc: '2.0'; id: number | string; result: JsonValue } | { jsonrpc: '2.0'; id: number | string; error: { code: number; message: string; data?: JsonValue } };
export interface McpTransport { readonly kind: 'stdio' | 'http'; start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: EngineError) => void): Promise<void>; send(message: JsonRpcMessage, signal?: AbortSignal, headers?: Readonly<Record<string, string>>): Promise<void>; cancel(requestId: number): Promise<void>; close(): Promise<void>; }
export const MCP_LIMITS = Object.freeze({ maxMessageBytes: 1024 * 1024, maxPending: 32, requestTimeoutMs: 10_000, maxTools: 128, maxResources: 256, maxPages: 8 });
export function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function cappedJson(value: unknown, limit = MCP_LIMITS.maxMessageBytes): JsonValue { try { return boundedJson(value, limit); } catch (error) { if (error instanceof JsonBudgetError) throw new EngineError('MCP_MESSAGE_LIMIT', 'MCP JSON message exceeds its byte budget'); throw new EngineError('MCP_INVALID_MESSAGE', 'MCP JSON message is invalid'); } }
export function parseMessage(raw: string | Uint8Array): JsonRpcMessage {
  if (Buffer.byteLength(raw) > MCP_LIMITS.maxMessageBytes) throw new EngineError('MCP_MESSAGE_LIMIT', 'MCP transport message exceeds its byte budget');
  let parsed: unknown; try { const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw); parsed = JSON.parse(text); } catch { throw new EngineError('MCP_INVALID_MESSAGE', 'MCP transport received invalid UTF-8 JSON'); }
  const data = cappedJson(parsed); if (!object(data) || data.jsonrpc !== '2.0') throw new EngineError('MCP_INVALID_MESSAGE', 'MCP JSON-RPC envelope is invalid');
  const hasId = typeof data.id === 'string' && Buffer.byteLength(data.id) <= 128 || Number.isSafeInteger(data.id); const hasMethod = typeof data.method === 'string' && data.method.length > 0 && Buffer.byteLength(data.method) <= 128;
  if (hasMethod) { if (data.id !== undefined && !hasId || data.params !== undefined && !object(data.params)) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP request identity or parameters are invalid'); return data as unknown as JsonRpcRequest; }
  if (!hasId || Object.hasOwn(data, 'result') === Object.hasOwn(data, 'error') || data.error !== undefined && (!object(data.error) || !Number.isSafeInteger(data.error.code) || typeof data.error.message !== 'string')) throw new EngineError('MCP_INVALID_MESSAGE', 'MCP response identity/result/error is invalid'); return data as unknown as JsonRpcMessage;
}
export function encodeMessage(message: JsonRpcMessage): string { const encoded = JSON.stringify(cappedJson(message)); parseMessage(encoded); return encoded; }
