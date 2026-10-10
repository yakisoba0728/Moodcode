import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Workspace } from '@moodcode/contracts';
import { LspManager } from '../lsp/index.js';
import { createTypeScriptNativeLspFactory } from '../lsp/typescript-native.js';
import { authoredRange } from './fixtures/semantic-corpus.js';
import { applyTextEdits } from '../formatters/edits.js';
import { projectNativeBOMRange } from '../lsp/native-bom.js';
import { nativeAvailable, nativeExecutable } from './fixtures/native-semantic-benchmark.js';

test('actual native TS7 preserves raw BOM UTF16 locations for disk targets, opened documents and source updates', { timeout: 30_000 }, async t => {
  if (!await nativeAvailable()) { t.skip('Pinned native TS7 executable is not installed on this platform'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-bom-')));
  const workspace: Workspace = { id: randomUUID(), root, gitRoot: '', branch: null, createdAt: new Date().toISOString() };
  const text = '\uFEFFconst astral = "😀"; export function όνομα(value: number) { return value + astral.length; }\r\nexport const unicodeResult = όνομα(4);\r\n';
  const importer = 'import { όνομα } from "./unicode.js";\nexport const value = όνομα(2);\n';
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2025', module: 'nodenext', strict: true, noEmit: true }, include: ['*.ts'] }));
  await writeFile(join(root, 'unicode.ts'), text); await writeFile(join(root, 'importer.ts'), importer);
  const manager = new LspManager({ startupTimeoutMs: 10_000, requestTimeoutMs: 10_000, cleanupTimeoutMs: 2000 });
  manager.register('native-bom', createTypeScriptNativeLspFactory({ executable: nativeExecutable, expectedVersion: '7.0.2' }));
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const disk = await manager.queryNavigation(workspace, 'native-bom', 'importer.ts', 'typescript', 'definition', signal, authoredRange(importer, 'όνομα', 1).start);
  const opened = await manager.queryNavigation(workspace, 'native-bom', 'unicode.ts', 'typescript', 'definition', signal, authoredRange(text, 'όνομα', 1).start);
  const references = await manager.queryNavigation(workspace, 'native-bom', 'unicode.ts', 'typescript', 'references', signal, authoredRange(text, 'όνομα', 1).start);
  const symbols = await manager.queryNavigation(workspace, 'native-bom', 'unicode.ts', 'typescript', 'symbols', signal);
  const changed = text.replace('value + astral.length', 'value + 1 + astral.length');
  await writeFile(join(root, 'unicode.ts'), changed);
  const updated = await manager.queryNavigation(workspace, 'native-bom', 'unicode.ts', 'typescript', 'definition', signal, authoredRange(changed, 'όνομα', 1).start);
  t.diagnostic(JSON.stringify({ disk: disk.items, opened: opened.items, references: references.items, symbols: symbols.items, updated: updated.items, rawSha256: createHash('sha256').update(text).digest('hex') }));
  for (const observation of [disk, opened]) {
    assert.equal(observation.complete, true); assert.equal(observation.items.length, 1);
    assert.deepEqual(observation.items[0]!.range, authoredRange(text, 'όνομα'));
    assert.equal(observation.items[0]!.hash, createHash('sha256').update(text).digest('hex'));
  }
  assert.deepEqual(references.items.filter(x => x.path === 'unicode.ts').map(x => x.range), [authoredRange(text, 'όνομα'), authoredRange(text, 'όνομα', 1)]);
  assert.deepEqual(symbols.items.find(x => x.name === 'όνομα')!.range, authoredRange(text, 'όνομα'));
  assert.deepEqual(updated.items[0]!.range, authoredRange(changed, 'όνομα'));
  assert.equal(await readFile(join(root, 'unicode.ts'), 'utf8'), changed);
});

test('actual native TS7 accepts identical full text versions and BOM removal with unchanged public positions and formatting bytes', { timeout: 30_000 }, async t => {
  if (!await nativeAvailable()) { t.skip('Pinned native TS7 executable is not installed on this platform'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-bom-update-')));
  const scope: Workspace = { id: randomUUID(), root, gitRoot: '', branch: null, createdAt: new Date().toISOString() };
  const text = '\uFEFFexport function όνομα(value:number){return value+1;}\r\nόνομα(2);\r\n';
  await writeFile(join(root, 'test.ts'), text); await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, include: ['*.ts'] }));
  const connection = await createTypeScriptNativeLspFactory({ executable: nativeExecutable, expectedVersion: '7.0.2' })(scope, new AbortController().signal);
  t.after(async () => { await connection.close(); await rm(root, { recursive: true, force: true }); });
  const signal = new AbortController().signal, uri = pathToFileURL(join(root, 'test.ts')).href;
  const initialized = await connection.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: { definition: { linkSupport: false } } } }, signal, 10_000);
  assert.equal((initialized as { capabilities: { positionEncoding: string } }).capabilities.positionEncoding, 'utf-16');
  await connection.notify('initialized', {});
  await connection.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'typescript', text } });
  const query = async (current: string) => {
    const response = await connection.request('textDocument/definition', { textDocument: { uri }, position: { ...authoredRange(current, 'όνομα').start } }, signal, 10_000) as { range: unknown }[];
    assert.equal(response.length, 1); assert.deepEqual(projectNativeBOMRange(current, response[0]!.range), authoredRange(current, 'όνομα'));
  };
  await query(text);
  await connection.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, text }] });
  await query(text);
  const edits = await connection.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }, signal, 10_000);
  assert.ok(Array.isArray(edits) && edits.length > 0); const formatted = applyTextEdits(text, edits);
  assert.ok(formatted.startsWith('\uFEFF')); assert.ok(formatted.includes('value: number')); assert.ok(formatted.includes('όνομα'));
  const plain = text.slice(1); await writeFile(join(root, 'test.ts'), plain);
  await connection.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: plain }] });
  await query(plain); assert.equal(await readFile(join(root, 'test.ts'), 'utf8'), plain);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(connection.request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 0 } }, cancelled.signal, 10_000), { code: 'CANCELLED' });
});
