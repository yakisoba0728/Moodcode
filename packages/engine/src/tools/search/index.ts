import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { projectToolResult } from '../../artifacts/result.js';
import { textPrefix } from '../../artifacts/validation.js';
import { createReadTools } from '../read/index.js';
import { readExactText } from '../file-actions/text.js';
import { continuationOffset, continuationToken, snapshotFingerprint, validateContinuation } from '../../workspace/ignore.js';
import { runSearchWorker } from './worker.js';
export const PATTERN_SEARCH_LIMITS = Object.freeze({ maxPatternBytes: 2048, maxFiles: 1000, maxBytes: 8 * 1024 * 1024, maxResults: 200, workerTimeoutMs: 250 });
interface Input { pattern: string; flags: string; path: string; limit: number; continuation?: string }
function parse(value: unknown, kind: 'glob' | 'regex'): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EngineError('INVALID_SEARCH_INPUT', 'Search input requires an object');
  const data = value as Record<string, unknown>; const allowed = kind === 'glob' ? ['pattern', 'path', 'limit', 'continuation'] : ['pattern', 'flags', 'path', 'limit', 'continuation'];
  if (Object.keys(data).some(k => !allowed.includes(k)) || typeof data.pattern !== 'string' || !data.pattern || Buffer.byteLength(data.pattern) > PATTERN_SEARCH_LIMITS.maxPatternBytes || /[\u0000-\u001f\u007f]/.test(data.pattern)) throw new EngineError('INVALID_SEARCH_INPUT', 'Pattern must be bounded text with supported input properties');
  const flags = data.flags ?? ''; if (typeof flags !== 'string' || !/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new EngineError('INVALID_SEARCH_INPUT', 'Regex flags may contain i, m and u once each');
  if (kind === 'glob' && (/^[\\/]|[:\\\[\]{}]/.test(data.pattern) || data.pattern.split('/').includes('..'))) throw new EngineError('UNSUPPORTED_GLOB_PATTERN', 'Glob supports *, ** and ? in relative paths; character classes, braces and parent traversal are unsupported');
  const path = data.path ?? '.'; if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 512) throw new EngineError('INVALID_SEARCH_INPUT', 'Search path must be bounded relative text');
  const limit = data.limit ?? 100; if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > PATTERN_SEARCH_LIMITS.maxResults) throw new EngineError('INVALID_SEARCH_INPUT', 'Search result limit is out of bounds');
  if (kind === 'regex') { try { new RegExp(data.pattern, flags); } catch { throw new EngineError('INVALID_SEARCH_PATTERN', 'Regex syntax is invalid'); } }
  if (data.continuation !== undefined) validateContinuation(data.continuation as string);
  return { pattern: data.pattern, flags: flags as string, path, limit: limit as number, ...(data.continuation === undefined ? {} : { continuation: data.continuation as string }) };
}
const binding = (context: ToolContext) => JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]);
export function createPatternSearchTools(): ToolDefinition[] {
  const list = createReadTools().find(tool => tool.name === 'list_files')!;
  return (['glob', 'regex'] as const).map(kind => {
    const name = kind === 'glob' ? 'glob_files' : 'regex_search'; const requests = new WeakMap<PreparedTool, { input: Input; snapshot: string; binding: string; used: boolean }>();
    return { name, effectClass: 'read' as const,
      description: kind === 'glob' ? 'Match Git-nonignored workspace file paths using bounded *, ** and ? glob evaluation. Returns truncation metadata; narrow requests when limits are reached.' : 'Search Git-nonignored UTF-8 text files using regex in a disposable worker with byte, file, result and wall-time limits. Returns 1-based UTF-16 columns and explicit truncation metadata.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string', minLength: 1, maxLength: PATTERN_SEARCH_LIMITS.maxPatternBytes }, ...(kind === 'regex' ? { flags: { type: 'string', pattern: '^[imu]*$' } } : {}), path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: PATTERN_SEARCH_LIMITS.maxResults }, continuation: { type: 'string', maxLength: 2048 } } },
      async prepare(value, context) {
        if (context.signal.aborted) throw new EngineError('CANCELLED', 'Search preparation cancelled'); const input = parse(value, kind);
        const scanContext = { ...context, limits: { ...context.limits, maxOutputBytes: 1024 * 1024 } }; await list.prepare({ path: input.path, limit: 2000 }, scanContext);
        const normalized: JsonObject = { pattern: input.pattern, ...(kind === 'regex' ? { flags: input.flags } : {}), path: input.path, limit: input.limit, ...(input.continuation ? { continuation: input.continuation } : {}) };
        const prepared: PreparedTool = { name, input: normalized, fingerprint: createHash('sha256').update(JSON.stringify({ name, input, workspaceId: context.workspace.id, root: context.workspace.root })).digest('hex'), requiresApproval: false, preview: { operation: name, ...normalized } }; requests.set(prepared, { input, snapshot: JSON.stringify(prepared), binding: binding(context), used: false }); return prepared;
      },
      async execute(prepared, context) {
        if (context.signal.aborted) throw new EngineError('CANCELLED', 'Search cancelled'); const request = requests.get(prepared); if (!request || request.used) throw new EngineError('INVALID_PREPARED_SEARCH', 'Search must be freshly prepared by this tool'); request.used = true;
        if (JSON.stringify(prepared) !== request.snapshot || binding(context) !== request.binding) throw new EngineError('SEARCH_REQUEST_STALE', 'Prepared search or execution identity changed');
        const scanContext: ToolContext = { ...context, limits: { ...context.limits, maxOutputBytes: 1024 * 1024 } };
        const listing = await list.execute(await list.prepare({ path: request.input.path, limit: 2000 }, scanContext), scanContext); const listingData = listing.data as JsonObject;
        const paths = (listingData.files as string[]).slice(0, PATTERN_SEARCH_LIMITS.maxFiles); const files: { path: string; content?: string }[] = []; const warnings: string[] = []; let bytesScanned = 0; let skippedFiles = 0;
        let scanTruncated = Boolean(listingData.truncated) || (listingData.files as string[]).length > paths.length;
        for (const path of paths) {
          if (context.signal.aborted) throw new EngineError('CANCELLED', 'Search cancelled');
          if (kind === 'glob') { files.push({ path }); continue; }
          try { const file = await readExactText(context.workspace, path, context.signal); const size = Buffer.byteLength(file.content); if (bytesScanned + size > PATTERN_SEARCH_LIMITS.maxBytes) { scanTruncated = true; break; } bytesScanned += size; files.push({ path, content: file.content }); }
          catch (error) { if (context.signal.aborted) throw new EngineError('CANCELLED', 'Search cancelled'); skippedFiles++; if (warnings.length < 20) warnings.push(`Skipped ${textPrefix(path, 256)}: ${error instanceof EngineError ? error.code : 'FILE_UNAVAILABLE'}`); }
        }
        const found = await runSearchWorker({ kind, pattern: request.input.pattern, flags: request.input.flags, files, maxResults: PATTERN_SEARCH_LIMITS.maxResults }, context.signal, PATTERN_SEARCH_LIMITS.workerTimeoutMs);
        const { continuation: _continuation, ...parameters } = request.input;
        const scope = snapshotFingerprint({ name, parameters, workspaceId: context.workspace.id, root: context.workspace.root });
        const snapshot = snapshotFingerprint({ observations: files.map(file => [file.path, file.content === undefined ? null : createHash('sha256').update(file.content).digest('hex')]), files: found.files, matches: found.matches, listing: listingData.files });
        const all = kind === 'glob' ? found.files : found.matches;
        const offset = continuationOffset(request.input.continuation, scope, snapshot, all.length); const selected = all.slice(offset, offset + request.input.limit); const next = offset + selected.length; const hasMore = next < all.length; const safe = !scanTruncated && !found.truncated && skippedFiles === 0;
        const data: JsonObject = { pattern: request.input.pattern, files: kind === 'glob' ? selected as string[] : [], matches: kind === 'regex' ? (selected as typeof found.matches).map(match => ({ ...match, text: textPrefix(match.text, 2048) })) : [], returnedCount: selected.length, pageOffset: offset, hasMore, ...(safe && hasMore && next > offset ? { continuation: continuationToken(scope, snapshot, next) } : {}), ...(!safe && (hasMore || scanTruncated || found.truncated) ? { continuationUnavailable: 'Scan/result limits or unreadable files prevent safe continuation; narrow the request.' } : {}), bytesScanned, filesScanned: files.length, skippedFiles, truncated: scanTruncated || found.truncated || skippedFiles > 0 || hasMore, truncationReasons: [...(scanTruncated ? ['scan_budget'] : []), ...(found.truncated || hasMore ? ['result_budget'] : []), ...(skippedFiles ? ['unreadable_files'] : [])], columnEncoding: 'utf-16', warnings };
        const display = JSON.stringify(data); return projectToolResult({ displayContent: display, structuredData: data, metadata: { operation: name }, warnings }, { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) });
      },
    };
  });
}
