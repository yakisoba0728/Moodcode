import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonValue, Workspace } from '@moodcode/contracts';
import { applyTextEdits } from '../formatters/edits.js';
import { installNativeBOMProjection, projectNativeBOMRange, usesNativeBOMProjection } from './native-bom.js';
import { navigationCandidates, projectNavigation } from './navigation.js';
import type { LspConnection } from './stdio.js';

function fixture() {
  const sent: { method: string; params: JsonValue; signal?: AbortSignal; timeout?: number }[] = [];
  let listener: ((method: string, input: JsonValue) => void) | undefined, output: JsonValue = null, closes = 0;
  const connection: LspConnection = {
    async notify(method, params) { sent.push({ method, params }); },
    async request(method, params, signal, timeout) { sent.push({ method, params, signal, timeout }); if (signal.aborted) throw new Error('original-abort'); return output; },
    onNotification(value) { listener = value; return () => { listener = undefined; }; },
    async close() { closes++; },
  };
  return { connection, sent, setOutput: (value: JsonValue) => { output = value; }, emit: (value: JsonValue) => listener?.('textDocument/publishDiagnostics', value), closes: () => closes };
}
const uri = 'file:///fixture.ts', raw = '\uFEFFconst value = "😀\uFEFF";\r\nvalue;\r\n';
const end = { line: 2, character: 0 }, whole = { start: { line: 0, character: 0 }, end };
const range = (start: number, finish: number, line = 0) => ({ start: { line, character: start }, end: { line, character: finish } });
const signal = () => new AbortController().signal;
async function opened() {
  const state = fixture(); installNativeBOMProjection(state.connection);
  await state.connection.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'typescript', text: raw } });
  return state;
}

test('native canonicalization preserves versions and interior BOM with one wire message per whole update', async () => {
  const state = await opened();
  assert.equal(usesNativeBOMProjection(state.connection), true);
  assert.deepEqual(state.sent[0], { method: 'textDocument/didOpen', params: { textDocument: { uri, version: 1, languageId: 'typescript', text: raw.slice(1) } } });
  await state.connection.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ range: whole, text: raw }] });
  assert.deepEqual(state.sent[1]!.params, { textDocument: { uri, version: 2 }, contentChanges: [{ range: whole, text: raw.slice(1) }] });
  const oneLine = '\uFEFFconst x = 1;';
  await state.connection.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: oneLine }] });
  await state.connection.notify('textDocument/didChange', { textDocument: { uri, version: 4 }, contentChanges: [{ range: range(0, oneLine.length), rangeLength: oneLine.length, text: oneLine }] });
  assert.deepEqual(state.sent[3]!.params, { textDocument: { uri, version: 4 }, contentChanges: [{ range: range(0, oneLine.length - 1), rangeLength: oneLine.length - 1, text: oneLine.slice(1) }] });
  await assert.rejects(state.connection.notify('textDocument/didChange', { textDocument: { uri, version: 5 }, contentChanges: [{ range: range(2, 3), text: 'x' }] }), { code: 'INVALID_LSP_NATIVE_TEXT' });
  assert.equal(state.sent.length, 4);
});

test('only native definition/reference positions shift and original signals, deadlines and cancellation errors remain owned', async () => {
  const state = await opened(), abort = new AbortController();
  const params = { textDocument: { uri }, position: { line: 0, character: 7 }, metadata: { character: 99 } };
  await state.connection.request('textDocument/definition', params, abort.signal, 1234);
  assert.deepEqual(state.sent[1], { method: 'textDocument/definition', params: { ...params, position: { line: 0, character: 6 } }, signal: abort.signal, timeout: 1234 });
  await state.connection.request('textDocument/references', { ...params, position: { line: 1, character: 1 } }, abort.signal, 1234);
  assert.deepEqual((state.sent[2]!.params as { position: unknown }).position, { line: 1, character: 1 });
  await state.connection.request('unrelated', params, abort.signal, 1234); assert.deepEqual(state.sent[3]!.params, params);
  abort.abort(); await assert.rejects(state.connection.request('textDocument/definition', params, abort.signal, 1234), /original-abort/);
  await state.connection.notify('textDocument/didClose', { textDocument: { uri } });
  await state.connection.request('textDocument/definition', params, signal(), 1234); assert.deepEqual(state.sent.at(-1)!.params, params);
});

test('native formatting and versioned diagnostics project exact raw ranges without dropping BOM or changing unrelated metadata', async () => {
  const state = await opened();
  state.setOutput([{ range: range(6, 11), newText: 'result', metadata: { character: 99 } }]);
  const edits = await state.connection.request('textDocument/formatting', { textDocument: { uri } }, signal(), 5000);
  assert.deepEqual(edits, [{ range: range(7, 12), newText: 'result', metadata: { character: 99 } }]);
  assert.equal(applyTextEdits(raw, edits), raw.replace('value', 'result'));
  const observed: JsonValue[] = [], remove = state.connection.onNotification((_method, input) => observed.push(input));
  state.emit({ uri, version: 1, diagnostics: [{ range: range(6, 11), message: 'fixture', code: 1, data: { character: 99 } }] });
  assert.deepEqual(observed[0], { uri, version: 1, diagnostics: [{ range: range(7, 12), message: 'fixture', code: 1, data: { character: 99 } }] });
  state.emit({ uri, version: 1, diagnostics: [{ range: range(100, 101), message: 'invalid' }] }); assert.equal(observed.length, 1);
  remove(); state.emit({ uri, diagnostics: [] }); assert.equal(observed.length, 1);
  const closing = state.connection.close(); assert.equal(state.connection.close(), closing); await closing;
  assert.equal(state.closes(), 1); assert.equal(usesNativeBOMProjection(state.connection), false);
});

test('only a leading BOM shifts validated first-line ranges and invalid surrogate/line positions remain rejected', () => {
  assert.deepEqual(projectNativeBOMRange(raw, range(6, 11)), range(7, 12));
  assert.deepEqual(projectNativeBOMRange(raw, range(0, 5, 1)), range(0, 5, 1));
  assert.deepEqual(projectNativeBOMRange(raw.slice(1), range(6, 11)), range(6, 11));
  assert.throws(() => projectNativeBOMRange('\uFEFF😀x', range(1, 2)), { code: 'INVALID_FORMAT_RANGE' });
  assert.throws(() => projectNativeBOMRange(raw, range(0, 1, 99)), { code: 'INVALID_FORMAT_RANGE' });
  const generic = fixture(); assert.equal(usesNativeBOMProjection(generic.connection), false);
});

test('native LocationLink and nested DocumentSymbol/SymbolInformation ranges use only validated source text', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-bom-navigation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const text = '\uFEFFfunction parent() { const child = 1; }\r\nparent();\r\n';
  await writeFile(join(root, 'target.ts'), text);
  const scope: Workspace = { id: 'bom-targets', root, gitRoot: '', branch: null, createdAt: new Date().toISOString() };
  const target = pathToFileURL(join(root, 'target.ts')).href;
  const base = { serverId: 'native', workspaceId: scope.id, path: 'target.ts', documentVersion: 1, documentHash: 'fixture-hash', kind: 'symbols' as const };
  const source = { content: text, hash: (await import('../tools/file-actions/text.js')).textHash(text) };
  const values = [{ name: 'parent', kind: 12, range: range(0, 38), selectionRange: range(9, 15), children: [{ name: 'child', kind: 13, range: range(20, 36), selectionRange: range(26, 31) }] }];
  const nested = await projectNavigation(base, scope, navigationCandidates(values, 'symbols', target), source, signal(), true);
  assert.deepEqual(nested.items.map(x => x.range), [range(10, 16), range(27, 32)]); assert.deepEqual(nested.items.map(x => x.depth), [0, 1]);
  const flat = await projectNavigation(base, scope, navigationCandidates([{ name: 'parent', kind: 12, location: { uri: target, range: range(9, 15) } }], 'symbols', target), source, signal(), true);
  assert.deepEqual(flat.items[0]!.range, range(10, 16));
  const linked = await projectNavigation({ ...base, kind: 'definition' }, scope, navigationCandidates([{ targetUri: target, targetRange: range(0, 38), targetSelectionRange: range(9, 15), originSelectionRange: range(0, 6, 1) }], 'definition', target), source, signal(), true);
  assert.deepEqual(linked.items[0]!.range, range(10, 16));
  const generic = await projectNavigation(base, scope, navigationCandidates(values, 'symbols', target), source, signal());
  assert.deepEqual(generic.items[0]!.range, range(9, 15));
  assert.equal(await readFile(join(root, 'target.ts'), 'utf8'), text);
});

test('native range projection preserves outside/ignored omissions and cancellation before any target read', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-bom-authority-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.ts'), raw); await writeFile(join(root, 'ignored.ts'), raw); await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
  const { runGit } = await import('../workspace/git.js'); assert.equal((await runGit(root, ['init', '--quiet', '--template='])).code, 0);
  const scope: Workspace = { id: 'bom-authority', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() };
  const source = { content: raw, hash: (await import('../tools/file-actions/text.js')).textHash(raw) };
  const base = { serverId: 'native', workspaceId: scope.id, path: 'source.ts', documentVersion: 1, documentHash: source.hash, kind: 'definition' as const };
  const targets = [{ uri: pathToFileURL(join(root, '../must-not-read.ts')).href, range: range(9999, 10000) }, { uri: pathToFileURL(join(root, 'ignored.ts')).href, range: range(9999, 10000) }];
  const result = await projectNavigation(base, scope, navigationCandidates(targets, 'definition', ''), source, signal(), true);
  assert.equal(result.items.length, 0); assert.equal(result.omitted.outsideWorkspace, 1); assert.equal(result.omitted.ignored, 1); assert.equal(result.complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(projectNavigation({ ...base }, { ...scope, gitRoot: '' }, navigationCandidates([{ uri: pathToFileURL(join(root, 'missing.ts')).href, range: range(0, 1) }], 'definition', ''), source, controller.signal, true), { code: 'CANCELLED' });
});
