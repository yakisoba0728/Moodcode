import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, sep, win32 } from 'node:path';
import { EngineError, type JsonObject, type JsonValue, type Workspace } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { resolveWorkspacePath } from '../../workspace/index.js';

export const READ_TOOL_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxReadLines: 2_000,
  maxFiles: 2_000,
  maxEntries: 20_000,
  maxSearchBytes: 16 * 1024 * 1024,
  maxSearchLines: 20_000,
  maxResults: 1_000,
  maxSnippetBytes: 2_048,
  maxQueryBytes: 2_048,
});

const excludedDirectories = new Set(['.git', 'node_modules', '.hg', '.svn', '.next', 'dist', 'build', 'coverage']);
const excludedDirectory = (name: string): boolean => excludedDirectories.has(name.toLowerCase());
const maxWarnings = 20;
type ToolName = 'list_files' | 'read_file' | 'search_files';
interface ReadInput { path: string; startLine: number; endLine: number | null }
interface ListInput { path: string; limit: number }
interface SearchInput extends ListInput { query: string }
interface ScanState {
  entriesVisited: number;
  filesVisited: number;
  bytesScanned: number;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
  skippedSymlinks: number;
  warnings: string[];
  warningsOmitted: number;
  reasons: Set<string>;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('CANCELLED', 'Read tool cancelled');
}

function invalid(message: string): never {
  throw new EngineError('INVALID_TOOL_INPUT', message);
}

function relativePath(value: unknown, optional: boolean): string {
  if (value === undefined && optional) return '.';
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4_096 || value.includes('\0') || value.includes('\\')) {
    return invalid('path must be a nonempty workspace-relative path without NUL or backslash');
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.split('/').includes('..')) {
    return invalid('path must remain inside the workspace');
  }
  return posix.normalize(value).replace(/\/+$/, '') || '.';
}

function positiveInteger(value: unknown, name: string, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return invalid(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeInput(name: ToolName, input: unknown): JsonObject {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('input must be an object');
  const object = input as Record<string, unknown>;
  const allowed = name === 'read_file' ? ['path', 'startLine', 'endLine'] : name === 'search_files' ? ['path', 'query', 'limit'] : ['path', 'limit'];
  if (Object.keys(object).some(key => !allowed.includes(key))) return invalid('input contains an unknown property');
  const path = relativePath(object.path, name !== 'read_file');
  if (name === 'read_file') {
    const startLine = positiveInteger(object.startLine, 'startLine', 1);
    const endLine = object.endLine === undefined ? null : positiveInteger(object.endLine, 'endLine');
    if (endLine !== null && endLine < startLine) return invalid('endLine must be greater than or equal to startLine');
    return { path, startLine, endLine };
  }
  const limit = Math.min(positiveInteger(object.limit, 'limit', name === 'list_files' ? 200 : 100), name === 'list_files' ? READ_TOOL_LIMITS.maxFiles : READ_TOOL_LIMITS.maxResults);
  if (name === 'search_files') {
    if (typeof object.query !== 'string' || object.query.length === 0 || Buffer.byteLength(object.query) > READ_TOOL_LIMITS.maxQueryBytes) {
      return invalid(`query must be nonempty and at most ${READ_TOOL_LIMITS.maxQueryBytes} UTF-8 bytes`);
    }
    return { path, query: object.query, limit };
  }
  return { path, limit };
}

function fingerprint(name: ToolName, input: JsonObject, workspace: Workspace): string {
  return createHash('sha256').update(JSON.stringify({ name, input, workspaceId: workspace.id, root: workspace.root })).digest('hex');
}

function checkedInput(name: ToolName, prepared: PreparedTool, context: ToolContext): JsonObject {
  cancelled(context.signal);
  // Revalidate the normalized input as public input, which does not accept null endLine.
  let input: unknown = prepared.input;
  if (name === 'read_file' && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const object: Record<string, unknown> = { ...input };
    if (object.endLine === null) delete object.endLine;
    input = object;
  }
  const normalized = normalizeInput(name, input);
  if (prepared.name !== name || prepared.requiresApproval || prepared.fingerprint !== fingerprint(name, normalized, context.workspace)) {
    throw new EngineError('PREPARED_TOOL_CHANGED', 'Prepared read tool input or workspace changed');
  }
  return normalized;
}

function scanState(): ScanState {
  return { entriesVisited: 0, filesVisited: 0, bytesScanned: 0, skippedBinaryFiles: 0, skippedLargeFiles: 0, skippedSymlinks: 0, warnings: [], warningsOmitted: 0, reasons: new Set() };
}

function warning(state: ScanState, path: string, error: unknown, reason = 'unreadable'): void {
  // Avoid returning host paths or arbitrary OS error strings to the model.
  const code = error instanceof EngineError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'READ_FAILED';
  if (state.warnings.length < maxWarnings) state.warnings.push(`${path}: ${code}`);
  else state.warningsOmitted++;
  state.reasons.add(reason);
}

function scanMetadata(state: ScanState): JsonObject {
  return { entriesVisited: state.entriesVisited, filesVisited: state.filesVisited, bytesScanned: state.bytesScanned, skippedBinaryFiles: state.skippedBinaryFiles, skippedLargeFiles: state.skippedLargeFiles, skippedSymlinks: state.skippedSymlinks, warnings: state.warnings, warningsOmitted: state.warningsOmitted, truncated: state.reasons.size > 0, truncationReasons: [...state.reasons] };
}

async function* walkFiles(workspace: Workspace, path: string, signal: AbortSignal, state: ScanState): AsyncGenerator<{ path: string; absolute: string }> {
  cancelled(signal);
  const absolute = await resolveWorkspacePath(workspace, path);
  cancelled(signal);
  const info = await stat(absolute);
  const lexicalParts = path.split('/');
  const canonicalParts = relative(workspace.root, absolute).split(sep);
  const directoryParts = info.isFile() ? [...lexicalParts.slice(0, -1), ...canonicalParts.slice(0, -1)] : [...lexicalParts, ...canonicalParts];
  if (directoryParts.some(excludedDirectory)) return;
  if (info.isFile()) { yield { path, absolute }; return; }
  if (!info.isDirectory()) throw new EngineError('NOT_REGULAR_FILE', 'The requested path is not a regular file or directory');
  const pending = [path];
  while (pending.length > 0) {
    cancelled(signal);
    const directory = pending.pop()!;
    try {
      const resolved = await resolveWorkspacePath(workspace, directory);
      cancelled(signal);
      const handle = await opendir(resolved);
      // Streaming iteration bounds memory even when a single directory has many entries.
      for await (const entry of handle) {
        cancelled(signal);
        if (state.entriesVisited >= READ_TOOL_LIMITS.maxEntries) { state.reasons.add('entries'); return; }
        state.entriesVisited++;
        const child = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) { state.skippedSymlinks++; continue; }
        if (entry.isDirectory()) {
          if (!excludedDirectory(entry.name)) pending.push(child);
        } else if (entry.isFile()) {
          try {
            const file = await resolveWorkspacePath(workspace, child);
            cancelled(signal);
            yield { path: child, absolute: file };
          } catch (error) {
            cancelled(signal);
            warning(state, child, error);
          }
        }
      }
    } catch (error) {
      cancelled(signal);
      warning(state, directory, error);
    }
  }
}

async function readBytes(absolute: string, signal: AbortSignal, byteBudget = READ_TOOL_LIMITS.maxFileBytes, onBytes?: (bytes: number) => void): Promise<Buffer> {
  cancelled(signal);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    cancelled(signal);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new EngineError('NOT_REGULAR_FILE', 'Only regular files can be read');
    if (info.size > BigInt(READ_TOOL_LIMITS.maxFileBytes)) throw new EngineError('FILE_TOO_LARGE', `File exceeds ${READ_TOOL_LIMITS.maxFileBytes} bytes`);
    if (info.size > BigInt(byteBudget)) throw new EngineError('SEARCH_BYTE_LIMIT', 'Search byte budget exhausted');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < Number(info.size)) {
      cancelled(signal);
      const capacity = Math.min(64 * 1024, Number(info.size) - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      cancelled(signal);
      if (bytesRead === 0) break;
      total += bytesRead;
      onBytes?.(bytesRead);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const atPath = await stat(absolute, { bigint: true });
    cancelled(signal);
    if (BigInt(total) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || atPath.ino !== info.ino || atPath.dev !== info.dev || atPath.size !== after.size || atPath.mtimeNs !== after.mtimeNs || atPath.ctimeNs !== after.ctimeNs) {
      throw new EngineError('FILE_CHANGED', 'File changed while it was being read; retry with a new read request');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function readWorkspaceBytes(workspace: Workspace, path: string, signal: AbortSignal, byteBudget = READ_TOOL_LIMITS.maxFileBytes, onBytes?: (bytes: number) => void): Promise<Buffer> {
  cancelled(signal);
  const absolute = await resolveWorkspacePath(workspace, path);
  const bytes = await readBytes(absolute, signal, byteBudget, onBytes);
  const current = await resolveWorkspacePath(workspace, path);
  cancelled(signal);
  if (current !== absolute) throw new EngineError('FILE_CHANGED', 'Workspace path changed while it was being read');
  return bytes;
}

function decodeText(bytes: Buffer): string {
  if (bytes.some(byte => byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b))) throw new EngineError('BINARY_FILE', 'Binary files are not supported');
  try {
    // Preserve a UTF-8 BOM so returnedBytes still describes the original byte sequence.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EngineError('BINARY_FILE', 'File is not valid UTF-8 text');
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let characters = Math.min(value.length, maxBytes);
  if (characters < value.length && value.charCodeAt(characters - 1) >= 0xd800 && value.charCodeAt(characters - 1) <= 0xdbff) characters--;
  const prefix = value.slice(0, characters);
  const bytes = Buffer.from(prefix);
  if (bytes.length <= maxBytes) return prefix;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  let count = content.endsWith('\n') ? 0 : 1;
  for (const character of content) if (character === '\n') count++;
  return count;
}

function markOutputTruncated(data: JsonObject): void {
  data.truncated = true;
  data.outputTruncated = true;
  const reasons = data.truncationReasons as string[];
  if (!reasons.includes('output_bytes')) reasons.push('output_bytes');
}

function boundedResult(data: JsonObject, context: ToolContext): ToolResult {
  cancelled(context.signal);
  const budget = Number.isSafeInteger(context.limits.maxOutputBytes) ? Math.max(0, context.limits.maxOutputBytes) : 0;
  data.outputTruncated = false;
  let content = JSON.stringify(data);
  if (Buffer.byteLength(content) <= budget) return { content, data };
  markOutputTruncated(data);
  // Find the largest complete payload that fits after metadata and JSON escaping.
  if (typeof data.content === 'string') {
    const original = data.content;
    const firstLine = data.startLine as number | null;
    const assign = (bytes: number): void => {
      const selected = utf8Prefix(original, bytes);
      data.content = selected;
      data.returnedBytes = Buffer.byteLength(selected);
      data.returnedLines = lineCount(selected);
      data.startLine = selected.length === 0 ? null : firstLine;
      data.endLine = selected.length === 0 || firstLine === null ? null : firstLine + (data.returnedLines as number) - 1;
      data.partialLastLine = selected.length > 0 && selected.length < original.length && !selected.endsWith('\n');
    };
    let low = 0;
    let high = Buffer.byteLength(original);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      assign(middle);
      if (Buffer.byteLength(JSON.stringify(data)) <= budget) low = middle;
      else high = middle - 1;
    }
    assign(low);
  } else {
    const key = Array.isArray(data.files) ? 'files' : 'matches';
    const items = data[key] as JsonValue[];
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      data[key] = items.slice(0, middle);
      data.returnedCount = middle;
      if (Buffer.byteLength(JSON.stringify(data)) <= budget) low = middle;
      else high = middle - 1;
    }
    data[key] = items.slice(0, low);
    data.returnedCount = low;
  }
  content = JSON.stringify(data);
  // Very small budgets cannot carry even the metadata. data remains structured and accurate.
  if (Buffer.byteLength(content) > budget) content = utf8Prefix('Tool output truncated.', budget);
  return { content, data };
}

async function listFiles(input: ListInput, context: ToolContext): Promise<ToolResult> {
  const state = scanState();
  const files: string[] = [];
  for await (const file of walkFiles(context.workspace, input.path, context.signal, state)) {
    if (files.length >= input.limit) { state.reasons.add('files'); break; }
    files.push(file.path);
    state.filesVisited++;
  }
  files.sort();
  return boundedResult({ path: input.path, files, returnedCount: files.length, ...scanMetadata(state) }, context);
}

async function readFile(input: ReadInput, context: ToolContext): Promise<ToolResult> {
  const bytes = await readWorkspaceBytes(context.workspace, input.path, context.signal);
  const text = decodeText(bytes);
  cancelled(context.signal);
  let totalLines = 0;
  let beginning = 0;
  let selectionStart: number | null = null;
  let selectionEnd = 0;
  let returnedLines = 0;
  let linesTruncated = false;
  for (let index = 0; index <= text.length; index++) {
    if (index % 65_536 === 0) cancelled(context.signal);
    if (text[index] !== '\n' && !(index === text.length && beginning < text.length)) continue;
    totalLines++;
    const ending = index === text.length ? index : index + 1;
    if (totalLines >= input.startLine && (input.endLine === null || totalLines <= input.endLine)) {
      if (returnedLines < READ_TOOL_LIMITS.maxReadLines) {
        selectionStart ??= beginning;
        selectionEnd = ending;
        returnedLines++;
      } else linesTruncated = true;
    }
    beginning = ending;
  }
  const content = selectionStart === null ? '' : text.slice(selectionStart, selectionEnd);
  return boundedResult({ path: input.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, encoding: 'utf-8', totalLines, requestedStartLine: input.startLine, requestedEndLine: input.endLine, startLine: returnedLines === 0 ? null : input.startLine, endLine: returnedLines === 0 ? null : input.startLine + returnedLines - 1, content, returnedBytes: Buffer.byteLength(content), returnedLines, partialLastLine: false, truncated: linesTruncated, truncationReasons: linesTruncated ? ['lines'] : [] }, context);
}

function searchLineStarts(text: string, signal: AbortSignal): { starts: number[]; end: number; truncated: boolean } {
  const starts = text.length === 0 ? [] : [0];
  for (let index = 0; index < text.length; index++) {
    if (index % 65_536 === 0) cancelled(signal);
    if (text[index] === '\n' && index + 1 < text.length) {
      if (starts.length >= READ_TOOL_LIMITS.maxSearchLines) return { starts, end: index + 1, truncated: true };
      starts.push(index + 1);
    }
  }
  return { starts, end: text.length, truncated: false };
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

async function searchFiles(input: SearchInput, context: ToolContext): Promise<ToolResult> {
  const state = scanState();
  const matches: JsonObject[] = [];
  let snippetsTruncated = 0;
  outer: for await (const file of walkFiles(context.workspace, input.path, context.signal, state)) {
    cancelled(context.signal);
    if (state.filesVisited >= READ_TOOL_LIMITS.maxFiles) { state.reasons.add('files'); break; }
    state.filesVisited++;
    let bytes: Buffer;
    try {
      bytes = await readWorkspaceBytes(context.workspace, file.path, context.signal, READ_TOOL_LIMITS.maxSearchBytes - state.bytesScanned, count => { state.bytesScanned += count; });
    } catch (error) {
      cancelled(context.signal);
      if (error instanceof EngineError && error.code === 'SEARCH_BYTE_LIMIT') { state.reasons.add('bytes'); break; }
      if (error instanceof EngineError && error.code === 'FILE_TOO_LARGE') state.skippedLargeFiles++;
      warning(state, file.path, error, error instanceof EngineError && error.code === 'FILE_TOO_LARGE' ? 'file_bytes' : 'unreadable');
      continue;
    }
    let text: string;
    try { text = decodeText(bytes); }
    catch (error) { state.skippedBinaryFiles++; continue; }
    const lines = searchLineStarts(text, context.signal);
    if (lines.truncated) state.reasons.add('lines');
    let offset = 0;
    let cachedRow = -1;
    let original = '';
    while (offset < lines.end) {
      cancelled(context.signal);
      const found = text.indexOf(input.query, offset);
      if (found < 0 || found + input.query.length > lines.end) break;
      if (matches.length >= input.limit) { state.reasons.add('results'); break outer; }
      const row = lineAt(lines.starts, found);
      const lineStart = lines.starts[row]!;
      const nextLineStart = lines.starts[row + 1] ?? lines.end;
      if (cachedRow !== row) {
        original = text.slice(lineStart, nextLineStart).replace(/\r?\n$/, '');
        cachedRow = row;
      }
      const prefix = utf8Prefix(original, READ_TOOL_LIMITS.maxSnippetBytes);
      const snippetTruncated = prefix.length !== original.length;
      let snippetOffset = snippetTruncated ? found - lineStart : 0;
      // A query can begin at a UTF-16 continuation; never split the rendered code point.
      if (snippetOffset > 0 && original.charCodeAt(snippetOffset) >= 0xdc00 && original.charCodeAt(snippetOffset) <= 0xdfff) snippetOffset--;
      const snippet = snippetTruncated ? utf8Prefix(original.slice(snippetOffset), READ_TOOL_LIMITS.maxSnippetBytes) : prefix;
      if (snippetTruncated) snippetsTruncated++;
      matches.push({ path: file.path, line: row + 1, column: found - lineStart + 1, text: snippet, snippetStartColumn: snippetOffset + 1, snippetTruncated });
      offset = found + input.query.length;
    }
  }
  if (snippetsTruncated > 0) state.reasons.add('snippet_bytes');
  return boundedResult({ path: input.path, query: input.query, matches, returnedCount: matches.length, snippetsTruncated, columnEncoding: 'utf-16', ...scanMetadata(state) }, context);
}

export function createReadTools(): ToolDefinition[] {
  const definitions: { name: ToolName; description: string; inputSchema: JsonObject }[] = [
    { name: 'list_files', description: 'List regular workspace files. Excludes dependency, VCS, build and coverage directories; does not traverse symlinks.', inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1 } } } },
    { name: 'read_file', description: 'Read UTF-8 workspace text and a whole-file SHA-256 hash, optionally selecting a 1-based inclusive line range.', inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } } } },
    { name: 'search_files', description: 'Search UTF-8 workspace files for a literal substring. Returns non-overlapping matches and 1-based UTF-16 columns.', inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1 } } } },
  ];
  return definitions.map(definition => ({
    ...definition,
    async prepare(input: unknown, context: ToolContext): Promise<PreparedTool> {
      cancelled(context.signal);
      const normalized = normalizeInput(definition.name, input);
      return { name: definition.name, input: normalized, fingerprint: fingerprint(definition.name, normalized, context.workspace), requiresApproval: false, preview: { operation: definition.name, ...normalized } };
    },
    async execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> {
      const input = checkedInput(definition.name, prepared, context);
      try {
        if (definition.name === 'list_files') return await listFiles(input as unknown as ListInput, context);
        if (definition.name === 'read_file') return await readFile(input as unknown as ReadInput, context);
        return await searchFiles(input as unknown as SearchInput, context);
      } catch (error) {
        cancelled(context.signal);
        throw error;
      }
    },
  }));
}
