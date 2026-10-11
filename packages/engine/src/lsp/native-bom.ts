import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';
import { endPosition, lineStarts, positionOffset, type TextPosition, type TextRange } from '../formatters/edits.js';
import type { LspConnection } from './stdio.js';

const nativeConnections = new WeakSet<LspConnection>();
const bom = (text: string) => text.startsWith('\uFEFF');
const object = (value: JsonValue | undefined): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
function position(basis: string, value: TextPosition, direction: -1 | 1, starts?: readonly number[]): TextPosition {
  positionOffset(basis, value, starts);
  return { line: value.line, character: value.line === 0 ? Math.max(0, value.character + direction) : value.character };
}
function range(basis: string, starts: readonly number[], value: unknown, direction: -1 | 1): TextRange {
  const input = value as TextRange;
  if (!input || !input.start || !input.end) throw new EngineError('INVALID_LSP_NAVIGATION_RESULT', 'Native range needs two valid UTF-16 positions');
  if (positionOffset(basis, input.end, starts) < positionOffset(basis, input.start, starts)) throw new EngineError('INVALID_LSP_NAVIGATION_RESULT', 'Native range ends before it starts');
  return { start: position(basis, input.start, direction, starts), end: position(basis, input.end, direction, starts) };
}
export const usesNativeBOMProjection = (connection: LspConnection): boolean => nativeConnections.has(connection);
export function nativeBOMRangeProjection(text: string): (value: unknown) => unknown {
  if (!bom(text)) return value => value;
  const basis = text.slice(1), starts = lineStarts(basis);
  return value => range(basis, starts, value, 1);
}

/** TS7 disk reads strip a UTF-8 BOM; keep its overlays on that same text basis. */
export function installNativeBOMProjection(connection: LspConnection): void {
  if (nativeConnections.has(connection)) return;
  const notify = connection.notify.bind(connection), request = connection.request.bind(connection), listen = connection.onNotification.bind(connection), close = connection.close.bind(connection);
  const documents = new Map<string, string>();
  let closing: Promise<void> | undefined;
  nativeConnections.add(connection);
  connection.notify = async (method, input) => {
    const params = object(boundedJson(input, 1024 * 1024)), doc = object(params?.textDocument);
    const uri = typeof doc?.uri === 'string' ? doc.uri : undefined;
    if (method === 'textDocument/didOpen' && uri && typeof doc?.text === 'string') {
      const text = doc.text;
      documents.set(uri, text);
      await notify(method, { ...params, textDocument: { ...doc, text: bom(text) ? text.slice(1) : text } });
    } else if (method === 'textDocument/didChange' && uri && Array.isArray(params?.contentChanges)) {
      const prior = documents.get(uri), change = object(params.contentChanges[0]);
      if (prior === undefined || params.contentChanges.length !== 1 || typeof change?.text !== 'string') throw new EngineError('INVALID_LSP_NATIVE_TEXT', 'Native synchronization requires one complete observed document');
      const starts = lineStarts(prior), end = endPosition(prior, starts);
      if (change.range !== undefined) {
        const selected = change.range as unknown as TextRange;
        if (!selected?.start || !selected.end || selected.start.line !== 0 || selected.start.character !== 0 || selected.end.line !== end.line || selected.end.character !== end.character) throw new EngineError('INVALID_LSP_NATIVE_TEXT', 'Native synchronization only replaces the complete observed text');
      }
      const text = change.text;
      documents.set(uri, text);
      await notify(method, { ...params, contentChanges: [{ ...change, ...(change.range !== undefined && bom(prior) ? { range: range(prior, starts, change.range, -1) as unknown as JsonValue } : {}), text: bom(text) ? text.slice(1) : text,
        ...(change.rangeLength !== undefined && bom(prior) ? { rangeLength: prior.length - 1 } : {}) }] });
    } else {
      await notify(method, input);
      if (method === 'textDocument/didClose' && uri) documents.delete(uri);
    }
  };
  connection.request = async (method, input, signal, timeout) => {
    const params = object(boundedJson(input, 1024 * 1024)), doc = object(params?.textDocument);
    const text = typeof doc?.uri === 'string' ? documents.get(doc.uri) : undefined;
    const navigation = method === 'textDocument/definition' || method === 'textDocument/references';
    const output = await request(method, navigation && text !== undefined && bom(text) && params?.position ? { ...params, position: position(text, params.position as unknown as TextPosition, -1) as unknown as JsonValue } : input, signal, timeout);
    if (method !== 'textDocument/formatting' || text === undefined || !bom(text) || !Array.isArray(output)) return output;
    const project = nativeBOMRangeProjection(text);
    return output.map(value => {
      const edit = object(value);
      if (!edit) throw new EngineError('INVALID_FORMAT_EDIT', 'Native formatting needs valid text edits');
      return { ...edit, range: project(edit.range) as JsonValue };
    });
  };
  connection.onNotification = listener => listen((method, input) => {
    const params = object(input), text = typeof params?.uri === 'string' ? documents.get(params.uri) : undefined;
    if (method !== 'textDocument/publishDiagnostics' || text === undefined || !bom(text) || !Array.isArray(params?.diagnostics)) { listener(method, input); return; }
    try {
      const project = nativeBOMRangeProjection(text);
      listener(method, { ...params, diagnostics: params.diagnostics.map(value => {
        const diagnostic = object(value);
        if (!diagnostic) throw new EngineError('INVALID_LSP_DIAGNOSTIC', 'Native diagnostic needs a valid range');
        return { ...diagnostic, range: project(diagnostic.range) as JsonValue };
      }) });
    } catch { /* Malformed diagnostics remain unavailable, as in the manager. */ }
  });
  connection.close = () => closing ??= close().finally(() => { documents.clear(); nativeConnections.delete(connection); });
}
