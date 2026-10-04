import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LIMITS, type JsonObject } from '@moodcode/contracts';
import type { ToolContext } from '../../ports.js';
import { openWorkspace } from '../../workspace/index.js';
import { createReadTools } from './index.js';

const exec = promisify(execFile);
const errorCode = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;

async function fixture(t: TestContext, entries: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-pagination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', '--template=', root]);
  for (const [name, content] of Object.entries(entries)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const workspace = await openWorkspace(root);
  const tools = new Map(createReadTools().map(tool => [tool.name, tool]));
  const context: ToolContext = {
    workspace, runId: 'run', sessionId: 'session', toolCallId: 'call', signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS }, artifactDir: join(root, '.git', 'artifacts'),
    recordCheckpoint() { assert.fail('Exploration must not checkpoint'); },
  };
  async function execute(name: string, input: unknown, maxBytes = DEFAULT_LIMITS.maxOutputBytes): Promise<JsonObject> {
    const tool = tools.get(name)!;
    const selected = { ...context, limits: { ...context.limits, maxOutputBytes: maxBytes } };
    const result = await tool.execute(await tool.prepare(input, selected), selected);
    assert.ok(Buffer.byteLength(result.content) <= maxBytes);
    return JSON.parse(result.content) as JsonObject;
  }
  return { root, context, execute };
}

test('a Python repository omits real virtual environments, nested caches and Gitignored files from list/search', async t => {
  const f = await fixture(t, {
    '.gitignore': 'generated/\n*.log\n!keep.log\n',
    'app.py': 'needle = 1\n', 'keep.log': 'needle kept\n',
    'src/main.py': 'needle = 2\n', 'src/.gitignore': '*.secret\n!public.secret\n',
    'src/public.secret': 'needle public\n', 'src/private.secret': 'needle hidden\n',
    'generated/app.py': 'needle generated\n', 'debug.log': 'needle log\n',
    '.venv/lib/python3.14/site-packages/library.py': 'needle installed\n',
    'venv/bin/activate': 'needle installed\n', 'src/__pycache__/module.pyc': 'needle cache\n',
    '.pytest_cache/results': 'needle cache\n', 'cache/item.txt': 'needle cache\n',
  });
  const wanted = ['.gitignore', 'app.py', 'keep.log', 'src/.gitignore', 'src/main.py', 'src/public.secret'];
  const first = await f.execute('list_files', { limit: 2 });
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  const files = [...first.files as string[]];
  let continuation = first.continuation;
  let pages = 1;
  while (continuation) {
    assert.ok(++pages <= 10);
    const page = await f.execute('list_files', { limit: 2, continuation });
    files.push(...page.files as string[]);
    continuation = page.continuation;
    if (!continuation) assert.equal(page.hasMore, false);
  }
  assert.deepEqual(files, wanted);
  const matched = await f.execute('search_files', { query: 'needle', limit: 100 });
  assert.deepEqual((matched.matches as JsonObject[]).map(match => match.path), ['app.py', 'keep.log', 'src/main.py', 'src/public.secret']);
  assert.deepEqual((await f.execute('list_files', { path: '.venv' })).files, []);
  assert.equal((await f.execute('read_file', { path: '.venv/lib/python3.14/site-packages/library.py' })).content, 'needle installed\n');
});

test('list and search reject malformed, mismatched and changed continuations', async t => {
  const f = await fixture(t, { 'src/a.py': 'hit a\n', 'src/b.py': 'hit b\n', 'src/c.py': 'hit c\n' });
  for (const name of ['list_files', 'search_files', 'read_file']) {
    const input = name === 'search_files' ? { query: 'hit' } : { path: 'src/a.py' };
    for (const continuation of ['1', '../outside', 'x'.repeat(2049), `${Buffer.from('{"offset":2}').toString('base64url')}.${'a'.repeat(43)}`]) {
      await assert.rejects(f.execute(name, { ...input, continuation }), errorCode('INVALID_CONTINUATION'));
    }
  }
  const listed = await f.execute('list_files', { path: 'src', limit: 1 });
  assert.equal(typeof listed.continuation, 'string');
  await assert.rejects(f.execute('list_files', { path: '.', limit: 1, continuation: listed.continuation }), errorCode('INVALID_CONTINUATION'));
  await assert.rejects(f.execute('list_files', { path: 'src', limit: 2, continuation: listed.continuation }), errorCode('INVALID_CONTINUATION'));
  await writeFile(join(f.root, 'src/d.py'), 'hit d\n');
  await assert.rejects(f.execute('list_files', { path: 'src', limit: 1, continuation: listed.continuation }), errorCode('STALE_CONTINUATION'));
  const search = await f.execute('search_files', { path: 'src', query: 'hit', limit: 1 });
  await assert.rejects(f.execute('search_files', { path: 'src', query: 'different', limit: 1, continuation: search.continuation }), errorCode('INVALID_CONTINUATION'));
  await writeFile(join(f.root, 'src/a.py'), 'hit modified but same match position\n');
  await assert.rejects(f.execute('search_files', { path: 'src', query: 'hit', limit: 1, continuation: search.continuation }), errorCode('STALE_CONTINUATION'));
  const current = await f.execute('search_files', { path: 'src', query: 'hit', limit: 2 });
  const next = await f.execute('search_files', { path: 'src', query: 'hit', limit: 2, continuation: current.continuation });
  assert.deepEqual((next.matches as JsonObject[]).map(match => match.path), ['src/c.py', 'src/d.py']);
  assert.equal(next.hasMore, false);
});

test('read pagination reconstructs multibyte long lines under a small JSON output budget and invalidates edited content', async t => {
  const content = `\uFEFF${'한국어🙂"\\'.repeat(200)}\r\nsecond\n${'tail🙂'.repeat(100)}`;
  const f = await fixture(t, { 'long.py': content });
  const chunks: string[] = [];
  let continuation: unknown;
  let first: JsonObject | undefined;
  let partialLine = false;
  for (let page = 0; page < 30; page++) {
    const read = await f.execute('read_file', { path: 'long.py', ...(continuation ? { continuation } : {}) }, 1800);
    first ??= read;
    assert.equal(typeof read.content, 'string');
    assert.equal(read.returnedBytes, Buffer.byteLength(read.content as string));
    assert.ok(!(read.content as string).includes('\uFFFD'));
    partialLine ||= read.partialFirstLine === true;
    chunks.push(read.content as string);
    continuation = read.continuation;
    if (!continuation) { assert.equal(read.hasMore, false); break; }
    assert.ok(Buffer.byteLength(continuation as string) <= 2048);
  }
  assert.equal(chunks.join(''), content);
  assert.equal(partialLine, true);
  assert.equal(first!.truncated, true);
  await assert.rejects(f.execute('read_file', { path: 'long.py', startLine: 2, continuation: first!.continuation }, 1800), errorCode('INVALID_CONTINUATION'));
  await writeFile(join(f.root, 'long.py'), content.replace('second', 'edited'));
  await assert.rejects(f.execute('read_file', { path: 'long.py', continuation: first!.continuation }, 1800), errorCode('STALE_CONTINUATION'));
});

test('read line cap and JSON-limited directory pages have complete, nonoverlapping continuations', async t => {
  const entries: Record<string, string> = { 'lines.py': 'x\n'.repeat(2003) };
  for (let index = 0; index < 12; index++) entries[`src/${String(index).padStart(2, '0')}-${'n'.repeat(140)}.py`] = 'x\n';
  const f = await fixture(t, entries);
  const first = await f.execute('read_file', { path: 'lines.py' });
  assert.equal(first.returnedLines, 2000);
  assert.equal(first.endLine, 2000);
  const next = await f.execute('read_file', { path: 'lines.py', continuation: first.continuation });
  assert.equal(next.content, 'x\n'.repeat(3));
  assert.equal(next.startLine, 2001);
  assert.equal(next.endLine, 2003);
  assert.equal(next.hasMore, false);
  let continuation: unknown;
  const files: string[] = [];
  for (let page = 0; page < 20; page++) {
    const result = await f.execute('list_files', { path: 'src', limit: 12, ...(continuation ? { continuation } : {}) }, 1200);
    assert.ok((result.files as string[]).length > 0);
    files.push(...result.files as string[]);
    continuation = result.continuation;
    if (!continuation) break;
  }
  assert.deepEqual(files, Object.keys(entries).filter(name => name.startsWith('src/')).sort());
  assert.equal(new Set(files).size, files.length);
});

test('an incomplete hard-limited search explains why no safe continuation can be offered', async t => {
  const f = await fixture(t, { 'many.py': 'hit\n'.repeat(1001) });
  const search = await f.execute('search_files', { query: 'hit', limit: 1 });
  assert.equal(search.truncated, true);
  assert.equal(search.hasMore, true);
  assert.equal(search.continuation, undefined);
  assert.match(search.continuationUnavailable as string, /narrow the request/);
});
