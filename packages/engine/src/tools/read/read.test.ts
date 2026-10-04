import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { openWorkspace } from '../../workspace/index.js';
import { createReadTools, READ_TOOL_LIMITS } from './index.js';

const execFileAsync = promisify(execFile);

interface ListData {
  files: string[];
  truncated: boolean;
  truncationReasons: string[];
}

interface ReadData {
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  startLine: number | null;
  endLine: number | null;
  totalLines: number;
  returnedBytes: number;
  returnedLines: number;
  truncated: boolean;
  truncationReasons: string[];
}

interface SearchData {
  matches: { path: string; line: number; column: number; text: string; snippetStartColumn: number }[];
  truncated: boolean;
  truncationReasons: string[];
}

async function fixture(t: TestContext, entries: Record<string, string | Uint8Array> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-read-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const [path, content] of Object.entries(entries)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  // The workspace adapter requires a Git working tree. Initialize only this
  // disposable fixture; no shared checkout or user Git configuration is changed.
  await execFileAsync('git', ['init', '--quiet', '--template=', root], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const workspace = await openWorkspace(root);
  const tools = new Map(createReadTools().map((tool) => [tool.name, tool]));
  const context: ToolContext = {
    workspace,
    sessionId: 'read-test-session',
    runId: 'read-test-run',
    toolCallId: 'read-test-call',
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS },
    artifactDir: join(root, 'read-tool-artifacts'),
    recordCheckpoint() { assert.fail('Readonly tools must not record checkpoints'); },
  };
  function tool(name: string): ToolDefinition {
    const definition = tools.get(name);
    assert.ok(definition, `Missing tool ${name}`);
    return definition;
  }
  async function execute(name: string, input: unknown, executionContext = context): Promise<ToolResult> {
    const definition = tool(name);
    const prepared = await definition.prepare(input, executionContext);
    assert.equal(prepared.requiresApproval, false);
    return definition.execute(prepared, executionContext);
  }
  return { root, workspace, context, tool, execute };
}

function data<T>(result: ToolResult): T {
  assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
  return result.data as unknown as T;
}

function errorCode(expected: string) {
  return (error: unknown): boolean => {
    assert.equal((error as { code?: unknown }).code, expected);
    return true;
  };
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('read tools expose exactly the readonly catalog and prepare without filesystem access', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(createReadTools().map((tool) => tool.name).sort(), ['list_files', 'read_file', 'search_files']);
  const absentContext = {
    ...f.context,
    workspace: { ...f.workspace, root: join(f.root, 'absent-workspace') },
  };
  const requests = [
    ['list_files', { path: 'absent-directory' }],
    ['read_file', { path: 'absent-file.txt' }],
    ['search_files', { query: 'literal', path: 'absent-directory' }],
  ] as const;
  for (const [name, input] of requests) {
    const prepared = await f.tool(name).prepare(input, absentContext);
    assert.equal(prepared.name, name);
    assert.equal(prepared.requiresApproval, false);
    assert.equal(typeof prepared.fingerprint, 'string');
    assert.ok(prepared.fingerprint.length > 0);
  }
  await assert.rejects(stat(f.context.artifactDir), { code: 'ENOENT' });
});

test('invalid inputs fail with INVALID_TOOL_INPUT before execution', async (t) => {
  const f = await fixture(t);
  const invalid: [string, unknown][] = [
    ['list_files', null], ['list_files', []], ['list_files', { limit: 0 }],
    ['list_files', { limit: -1 }], ['list_files', { limit: 1.5 }],
    ['list_files', { limit: Number.MAX_SAFE_INTEGER + 1 }], ['list_files', { path: 1 }],
    ['list_files', { path: 'nul\u0000path' }], ['list_files', { unknown: true }],
    ['read_file', {}], ['read_file', { path: '' }], ['read_file', { path: 'a', startLine: 0 }],
    ['read_file', { path: 'a', endLine: -1 }], ['read_file', { path: 'a', startLine: 1.5 }],
    ['read_file', { path: 'a', startLine: 3, endLine: 2 }],
    ['read_file', { path: 'a', endLine: Number.MAX_SAFE_INTEGER + 1 }],
    ['read_file', { path: 'a', startLine: Number.POSITIVE_INFINITY }],
    ['search_files', {}], ['search_files', { query: '' }], ['search_files', { query: 1 }],
    ['search_files', { query: 'x', limit: Number.NaN }],
    ['search_files', { query: 'x', limit: '2' }], ['search_files', { query: 'x', extra: true }],
    ['search_files', { query: 'x'.repeat(READ_TOOL_LIMITS.maxQueryBytes + 1) }],
  ];
  for (const [name, input] of invalid) {
    await assert.rejects(f.tool(name).prepare(input, f.context), errorCode('INVALID_TOOL_INPUT'));
  }
  const multibyteQuery = '😀'.repeat(Math.floor(READ_TOOL_LIMITS.maxQueryBytes / 4) + 1);
  await assert.rejects(f.tool('search_files').prepare({ query: multibyteQuery }, f.context), errorCode('INVALID_TOOL_INPUT'));
  const exactByteQuery = '😀'.repeat(READ_TOOL_LIMITS.maxQueryBytes / 4);
  await f.tool('search_files').prepare({ query: exactByteQuery }, f.context);
});

test('list_files excludes configured directories at every depth and skips symlinks', async (t) => {
  const entries: Record<string, string> = {
    '.visible.txt': 'visible', 'nested/alpha.txt': 'alpha', 'z.txt': 'z',
  };
  for (const directory of ['.git', 'node_modules', '.hg', '.svn', '.next', 'dist', 'build', 'coverage']) {
    entries[`${directory}/hidden.txt`] = 'hidden';
    entries[`nested/${directory}/hidden.txt`] = 'hidden';
  }
  entries['DiSt/hidden.txt'] = 'hidden';
  entries['nested/NoDe_MoDuLeS/hidden.txt'] = 'hidden';
  const f = await fixture(t, entries);
  await symlink(join(f.root, 'nested'), join(f.root, 'linked-dir'), 'dir');
  await symlink(join(f.root, 'z.txt'), join(f.root, 'linked-file.txt'), 'file');
  await symlink(f.root, join(f.root, 'loop'), 'dir');
  const listed = data<ListData>(await f.execute('list_files', {}));
  assert.deepEqual([...listed.files].sort(), ['.visible.txt', 'nested/alpha.txt', 'z.txt']);
  assert.equal(listed.truncated, false);
  const nested = data<ListData>(await f.execute('list_files', { path: 'nested' }));
  assert.deepEqual(nested.files, ['nested/alpha.txt']);
});

test('list_files distinguishes exactly limit entries from an omitted extra file', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b' });
  const exact = data<ListData>(await f.execute('list_files', { limit: 2 }));
  assert.equal(exact.files.length, 2);
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.truncationReasons, []);
  await writeFile(join(f.root, 'c.txt'), 'c');
  const clipped = data<ListData>(await f.execute('list_files', { limit: 2 }));
  assert.equal(clipped.files.length, 2);
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.truncationReasons.length > 0);
});

test('directory paths with trailing slashes return canonical workspace-relative file paths', async (t) => {
  const f = await fixture(t, { 'nested/file.txt': 'needle', 'root.txt': 'root' });
  const root = data<ListData>(await f.execute('list_files', { path: './' }));
  assert.deepEqual([...root.files].sort(), ['nested/file.txt', 'root.txt']);
  const nested = data<ListData>(await f.execute('list_files', { path: 'nested/' }));
  assert.deepEqual(nested.files, ['nested/file.txt']);
  const searched = data<SearchData>(await f.execute('search_files', { query: 'needle', path: 'nested/' }));
  assert.deepEqual(searched.matches.map(({ path }) => path), ['nested/file.txt']);
});

test('explicit list and search paths honor excluded parents including symlink aliases', async (t) => {
  const f = await fixture(t, {
    'dist/hidden.txt': 'needle', 'nested/build/hidden.txt': 'needle', 'nested/dist': 'needle',
  });
  await symlink(join(f.root, 'dist/hidden.txt'), join(f.root, 'hidden-alias.txt'), 'file');
  await symlink(join(f.root, 'nested/build'), join(f.root, 'build-alias'), 'dir');
  for (const path of ['.git/config', 'dist/hidden.txt', 'nested/build/hidden.txt', 'hidden-alias.txt', 'build-alias/hidden.txt']) {
    const listed = data<ListData>(await f.execute('list_files', { path }));
    assert.deepEqual(listed.files, []);
    assert.equal(listed.truncated, false);
    const searched = data<SearchData>(await f.execute('search_files', { query: 'needle', path }));
    assert.deepEqual(searched.matches, []);
    assert.equal(searched.truncated, false);
  }
  const ordinaryBasename = data<ListData>(await f.execute('list_files', { path: 'nested/dist' }));
  assert.deepEqual(ordinaryBasename.files, ['nested/dist']);
  const searchedBasename = data<SearchData>(await f.execute('search_files', { query: 'needle', path: 'nested/dist' }));
  assert.equal(searchedBasename.matches.length, 1);
  const explicitRead = data<ReadData>(await f.execute('read_file', { path: 'dist/hidden.txt' }));
  assert.equal(explicitRead.content, 'needle');
});

test('read_file returns a one based inclusive range and hashes the complete original bytes', async (t) => {
  const original = 'first\r\n한글 😀\r\nlast\r\n';
  const f = await fixture(t, { 'sample.txt': original });
  const read = data<ReadData>(await f.execute('read_file', { path: 'sample.txt', startLine: 2, endLine: 2 }));
  assert.equal(read.path, 'sample.txt');
  assert.equal(read.sha256, sha256(original));
  assert.equal(read.bytes, Buffer.byteLength(original));
  assert.equal(read.totalLines, 3);
  assert.equal(read.startLine, 2);
  assert.equal(read.endLine, 2);
  assert.equal(read.returnedLines, 1);
  assert.equal(read.returnedBytes, Buffer.byteLength(read.content));
  assert.match(read.content, /한글 😀/);
  assert.doesNotMatch(read.content, /first|last/);
  assert.equal(read.truncated, false);
  assert.deepEqual(read.truncationReasons, []);
});

test('read_file preserves UTF-8 BOM and an emoji spanning the 64 KiB read boundary', async (t) => {
  const original = `\ufeff${'a'.repeat(65_536 - 3 - 2)}😀\n끝\n`;
  const bytes = Buffer.from(original);
  assert.equal(bytes[65_534], 0xf0);
  assert.equal(bytes[65_536], 0x98);
  const f = await fixture(t, { 'bom-boundary.txt': bytes });
  const context = { ...f.context, limits: { ...f.context.limits, maxOutputBytes: 256 * 1024 } };
  const read = data<ReadData>(await f.execute('read_file', { path: 'bom-boundary.txt' }, context));
  assert.equal(read.content, original);
  assert.equal(read.sha256, sha256(bytes));
  assert.equal(read.bytes, bytes.length);
  assert.equal(read.returnedBytes, bytes.length);
  assert.equal(read.totalLines, 2);
  assert.equal(read.returnedLines, 2);
  assert.equal(read.startLine, 1);
  assert.equal(read.endLine, 2);
  assert.equal(read.truncated, false);
});

test('empty files and EOF ranges have accurate empty metadata', async (t) => {
  const f = await fixture(t, { 'empty.txt': '', 'one.txt': 'one', 'newline.txt': 'one\n' });
  const empty = data<ReadData>(await f.execute('read_file', { path: 'empty.txt' }));
  assert.equal(empty.sha256, sha256(''));
  assert.equal(empty.bytes, 0);
  assert.equal(empty.content, '');
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.returnedLines, 0);
  assert.equal(empty.returnedBytes, 0);
  assert.equal(empty.startLine, null);
  assert.equal(empty.endLine, null);
  assert.equal(empty.truncated, false);
  for (const path of ['one.txt', 'newline.txt']) {
    const whole = data<ReadData>(await f.execute('read_file', { path, endLine: 10 }));
    assert.equal(whole.totalLines, 1);
    assert.equal(whole.returnedLines, 1);
    assert.equal(whole.endLine, 1);
    assert.equal(whole.truncated, false);
    const pastEnd = data<ReadData>(await f.execute('read_file', { path, startLine: 10 }));
    assert.equal(pastEnd.content, '');
    assert.equal(pastEnd.returnedLines, 0);
    assert.equal(pastEnd.startLine, null);
    assert.equal(pastEnd.endLine, null);
    assert.equal(pastEnd.truncated, false);
  }
});

test('read_file marks line truncation while retaining the full file hash and line count', async (t) => {
  const lineCount = READ_TOOL_LIMITS.maxReadLines + 1;
  const original = Array.from({ length: lineCount }, (_, index) => `line-${index + 1}\n`).join('');
  const f = await fixture(t, { 'many-lines.txt': original });
  const read = data<ReadData>(await f.execute('read_file', { path: 'many-lines.txt' }));
  assert.equal(read.sha256, sha256(original));
  assert.equal(read.totalLines, lineCount);
  assert.equal(read.returnedLines, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(read.startLine, 1);
  assert.equal(read.endLine, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(read.returnedBytes, Buffer.byteLength(read.content));
  assert.equal(read.truncated, true);
  assert.ok(read.truncationReasons.length > 0);
  assert.doesNotMatch(read.content, new RegExp(`line-${lineCount}(?:\\n|$)`));
});

test('exact read line limits and explicitly excluded extra lines are complete requests', async (t) => {
  const exact = Array.from({ length: READ_TOOL_LIMITS.maxReadLines }, (_, index) => `line-${index + 1}\n`).join('');
  const f = await fixture(t, { 'exact.txt': exact, 'extra.txt': `${exact}outside-request\n` });
  const complete = data<ReadData>(await f.execute('read_file', { path: 'exact.txt' }));
  assert.equal(complete.content, exact);
  assert.equal(complete.totalLines, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(complete.returnedLines, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(complete.truncated, false);
  assert.deepEqual(complete.truncationReasons, []);
  const selected = data<ReadData>(await f.execute('read_file', { path: 'extra.txt', endLine: READ_TOOL_LIMITS.maxReadLines }));
  assert.equal(selected.content, exact);
  assert.equal(selected.totalLines, READ_TOOL_LIMITS.maxReadLines + 1);
  assert.equal(selected.returnedLines, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(selected.endLine, READ_TOOL_LIMITS.maxReadLines);
  assert.equal(selected.truncated, false);
  assert.deepEqual(selected.truncationReasons, []);
});

test('binary input and overlarge files fail without returning file contents', async (t) => {
  const f = await fixture(t, {
    'nul.bin': Buffer.from([0x61, 0x00, 0x62]),
    'invalid-utf8.bin': Buffer.from([0x61, 0xff, 0x62]),
    'too-large.txt': Buffer.alloc(READ_TOOL_LIMITS.maxFileBytes + 1, 0x61),
    'at-limit.txt': Buffer.alloc(READ_TOOL_LIMITS.maxFileBytes, 0x61),
  });
  await assert.rejects(f.execute('read_file', { path: 'nul.bin' }), errorCode('BINARY_FILE'));
  await assert.rejects(f.execute('read_file', { path: 'invalid-utf8.bin' }), errorCode('BINARY_FILE'));
  await assert.rejects(f.execute('read_file', { path: 'too-large.txt' }), errorCode('FILE_TOO_LARGE'));
  const atLimit = data<ReadData>(await f.execute('read_file', { path: 'at-limit.txt' }));
  assert.equal(atLimit.bytes, READ_TOOL_LIMITS.maxFileBytes);
  assert.equal(atLimit.sha256, sha256(Buffer.alloc(READ_TOOL_LIMITS.maxFileBytes, 0x61)));
});

test('read output trimming preserves full hashes and exact final content metadata', async (t) => {
  const original = '한글😀'.repeat(300);
  const f = await fixture(t, { 'unicode.txt': original });
  const context = { ...f.context, limits: { ...f.context.limits, maxOutputBytes: 512 } };
  const result = await f.execute('read_file', { path: 'unicode.txt' }, context);
  const read = data<ReadData>(result);
  assert.ok(Buffer.byteLength(result.content) <= context.limits.maxOutputBytes);
  assert.equal(read.sha256, sha256(original));
  assert.equal(read.bytes, Buffer.byteLength(original));
  assert.equal(read.returnedBytes, Buffer.byteLength(read.content));
  assert.ok(read.returnedBytes < read.bytes);
  assert.equal(Buffer.from(read.content).toString('utf8'), read.content);
  assert.equal(read.returnedLines, read.content.length === 0 ? 0 : 1);
  assert.equal(read.startLine, read.content.length === 0 ? null : 1);
  assert.equal(read.endLine, read.content.length === 0 ? null : 1);
  assert.equal(read.truncated, true);
  assert.ok(read.truncationReasons.length > 0);
});

test('search_files uses literal substrings and one based UTF-16 columns', async (t) => {
  const f = await fixture(t, {
    'text.txt': 'prefix needle suffix\n😀needle [a.*]\nNeedle should not match\n',
    'nul.bin': Buffer.from('needle\u0000needle'),
    'node_modules/hidden.txt': 'needle',
  });
  const found = data<SearchData>(await f.execute('search_files', { query: 'needle' }));
  assert.deepEqual(found.matches.map(({ path, line, column }) => ({ path, line, column })), [
    { path: 'text.txt', line: 1, column: 8 },
    { path: 'text.txt', line: 2, column: 3 },
  ]);
  assert.equal(found.truncated, false);
  const literal = data<SearchData>(await f.execute('search_files', { query: '[a.*]' }));
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0]?.line, 2);
  assert.equal(literal.matches[0]?.column, 10);
});

test('multiline literal queries report the start line and UTF-16 column', async (t) => {
  const f = await fixture(t, { 'multiline.txt': 'header\n😀prefix needle\ncontinued tail\n' });
  const searched = data<SearchData>(await f.execute('search_files', { query: 'needle\ncontinued' }));
  assert.equal(searched.matches.length, 1);
  const match = searched.matches[0];
  assert.ok(match);
  assert.equal(match.path, 'multiline.txt');
  assert.equal(match.line, 2);
  assert.equal(match.column, '😀prefix '.length + 1);
  assert.equal(searched.truncated, false);
});

test('search line limits distinguish the exact boundary from omitted later lines', async (t) => {
  const exact = `${'plain\n'.repeat(READ_TOOL_LIMITS.maxSearchLines - 1)}needle\n`;
  const f = await fixture(t, { 'lines.txt': exact });
  const complete = data<SearchData>(await f.execute('search_files', { query: 'needle', path: 'lines.txt' }));
  assert.equal(complete.matches.length, 1);
  assert.equal(complete.matches[0]?.line, READ_TOOL_LIMITS.maxSearchLines);
  assert.equal(complete.matches[0]?.column, 1);
  assert.equal(complete.truncated, false);
  assert.deepEqual(complete.truncationReasons, []);
  await writeFile(join(f.root, 'lines.txt'), `${exact}needle-outside-limit\n`);
  const clipped = data<SearchData>(await f.execute('search_files', { query: 'needle', path: 'lines.txt' }));
  assert.equal(clipped.matches.length, 1);
  assert.equal(clipped.matches[0]?.line, READ_TOOL_LIMITS.maxSearchLines);
  assert.equal(clipped.truncated, true);
  assert.deepEqual(clipped.truncationReasons, ['lines']);
});

test('search_files distinguishes an exact result limit from an omitted match', async (t) => {
  const f = await fixture(t, { 'matches.txt': 'needle\nneedle\n' });
  const exact = data<SearchData>(await f.execute('search_files', { query: 'needle', limit: 2 }));
  assert.equal(exact.matches.length, 2);
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.truncationReasons, []);
  await writeFile(join(f.root, 'matches.txt'), 'needle\nneedle\nneedle\n');
  const clipped = data<SearchData>(await f.execute('search_files', { query: 'needle', limit: 2 }));
  assert.equal(clipped.matches.length, 2);
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.truncationReasons.length > 0);
});

test('search snippets obey their byte cap and retain positions beyond the snippet boundary', async (t) => {
  const prefix = '😀'.repeat(READ_TOOL_LIMITS.maxSnippetBytes);
  const f = await fixture(t, { 'long-line.txt': `${prefix}needle${'한'.repeat(READ_TOOL_LIMITS.maxSnippetBytes)}\n` });
  const searched = data<SearchData>(await f.execute('search_files', { query: 'needle' }));
  assert.equal(searched.matches.length, 1);
  const match = searched.matches[0];
  assert.ok(match);
  assert.equal(match.line, 1);
  assert.equal(match.column, prefix.length + 1);
  assert.equal(match.snippetStartColumn, match.column);
  assert.ok(match.text.includes('needle'));
  assert.ok(Buffer.byteLength(match.text) <= READ_TOOL_LIMITS.maxSnippetBytes);
  assert.equal(Buffer.from(match.text).toString('utf8'), match.text);
});

test('file scan limits bound list and search even when no search result is found', async (t) => {
  const entries: Record<string, string> = {};
  for (let index = 0; index <= READ_TOOL_LIMITS.maxFiles; index++) {
    entries[`files/${String(index).padStart(5, '0')}.txt`] = 'no match';
  }
  const f = await fixture(t, entries);
  const listed = data<ListData>(await f.execute('list_files', { limit: READ_TOOL_LIMITS.maxFiles }));
  assert.equal(listed.files.length, READ_TOOL_LIMITS.maxFiles);
  assert.equal(listed.truncated, true);
  assert.ok(listed.truncationReasons.length > 0);
  const searched = data<SearchData>(await f.execute('search_files', { query: 'absent' }));
  assert.deepEqual(searched.matches, []);
  assert.equal(searched.truncated, true);
  assert.ok(searched.truncationReasons.length > 0);
});

test('search aggregate byte limits bound scanning independently of result limits', async (t) => {
  const perFile = READ_TOOL_LIMITS.maxFileBytes;
  const fileCount = Math.floor(READ_TOOL_LIMITS.maxSearchBytes / perFile) + 1;
  const entries: Record<string, Uint8Array> = {};
  const content = Buffer.alloc(perFile, 0x61);
  for (let index = 0; index < fileCount; index++) entries[`${index}.txt`] = content;
  const f = await fixture(t, entries);
  const searched = data<SearchData>(await f.execute('search_files', { query: 'absent' }));
  assert.deepEqual(searched.matches, []);
  assert.equal(searched.truncated, true);
  assert.ok(searched.truncationReasons.length > 0);
});

test('all model outputs obey final UTF-8 byte budgets including tiny budgets', async (t) => {
  const f = await fixture(t, {
    '한글😀-one.txt': '😀needle "quoted"\t\\text\n'.repeat(10),
    '한글😀-two.txt': 'needle\n',
  });
  const requests = [
    ['list_files', {}], ['read_file', { path: '한글😀-one.txt' }], ['search_files', { query: 'needle' }],
  ] as const;
  for (const maxOutputBytes of [1, 16, 128, 512]) {
    const context = { ...f.context, limits: { ...f.context.limits, maxOutputBytes } };
    for (const [name, input] of requests) {
      const result = await f.execute(name, input, context);
      assert.ok(Buffer.byteLength(result.content) <= maxOutputBytes, `${name} exceeded ${maxOutputBytes} bytes`);
      assert.equal(Buffer.from(result.content).toString('utf8'), result.content);
    }
  }
});

test('workspace escapes and external symlinks cannot expose outside file contents', async (t) => {
  const f = await fixture(t, { 'inside.txt': 'inside' });
  const outside = await mkdtemp(join(tmpdir(), 'moodcode-read-outside-'));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  const outsideFile = join(outside, 'outside.txt');
  await writeFile(outsideFile, 'outside fixture content');
  await symlink(outsideFile, join(f.root, 'outside-link.txt'), 'file');
  await symlink(outside, join(f.root, 'outside-directory'), 'dir');
  await assert.rejects(f.execute('read_file', { path: relative(f.root, outsideFile) }));
  await assert.rejects(f.execute('read_file', { path: outsideFile }));
  await assert.rejects(f.execute('read_file', { path: 'outside-link.txt' }));
  const listed = data<ListData>(await f.execute('list_files', {}));
  assert.deepEqual(listed.files, ['inside.txt']);
  const searched = data<SearchData>(await f.execute('search_files', { query: 'outside fixture' }));
  assert.deepEqual(searched.matches, []);
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside fixture content');
});

test('prepared input changes are rejected before reading a different target', async (t) => {
  const f = await fixture(t, { 'first.txt': 'first', 'second.txt': 'second' });
  const tool = f.tool('read_file');
  const prepared = await tool.prepare({ path: 'first.txt' }, f.context);
  await assert.rejects(tool.execute({ ...prepared, input: { path: 'second.txt' } }, f.context), errorCode('PREPARED_TOOL_CHANGED'));
});

test('prepared requests reject changed workspace identity and root before filesystem access', async (t) => {
  const f = await fixture(t, { 'file.txt': 'needle' });
  const requests = [
    ['list_files', {}], ['read_file', { path: 'file.txt' }], ['search_files', { query: 'needle' }],
  ] as const;
  const changedContexts = [
    { ...f.context, workspace: { ...f.workspace, id: `${f.workspace.id}-changed` } },
    { ...f.context, workspace: { ...f.workspace, root: join(f.root, 'absent-workspace') } },
  ];
  for (const [name, input] of requests) {
    const tool = f.tool(name);
    const prepared = await tool.prepare(input, f.context);
    for (const context of changedContexts) {
      await assert.rejects(tool.execute(prepared, context), errorCode('PREPARED_TOOL_CHANGED'));
    }
  }
});

test('aborted preparation and execution fail with CANCELLED', async (t) => {
  const f = await fixture(t, { 'file.txt': 'needle\n'.repeat(10_000) });
  const requests = [
    ['list_files', {}], ['read_file', { path: 'file.txt' }], ['search_files', { query: 'needle' }],
  ] as const;
  for (const [name, input] of requests) {
    const controller = new AbortController();
    const context = { ...f.context, signal: controller.signal };
    const tool = f.tool(name);
    const prepared = await tool.prepare(input, context);
    controller.abort();
    await assert.rejects(tool.prepare(input, context), errorCode('CANCELLED'));
    await assert.rejects(tool.execute(prepared, context), errorCode('CANCELLED'));
  }
});

test('in-flight filesystem work observes cancellation after execute is called', async (t) => {
  const f = await fixture(t, { 'file.txt': 'needle\n'.repeat(10_000) });
  const requests = [
    ['list_files', {}], ['read_file', { path: 'file.txt' }], ['search_files', { query: 'needle' }],
  ] as const;
  for (const [name, input] of requests) {
    const controller = new AbortController();
    const context = { ...f.context, signal: controller.signal };
    const tool = f.tool(name);
    const prepared = await tool.prepare(input, context);
    const pending = tool.execute(prepared, context);
    controller.abort();
    await assert.rejects(pending, errorCode('CANCELLED'));
  }
});

test('entry traversal limit uses lookahead even when every entry is excluded or a symlink', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  // The Git metadata directory is one excluded entry; dangling links require no file reads.
  const count = READ_TOOL_LIMITS.maxEntries - 1;
  for (let start = 0; start < count; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, count - start) }, (_, index) => {
      const name = `link-${String(start + index).padStart(5, '0')}`;
      return symlink(join(f.root, 'missing-target'), join(f.root, name), 'file');
    }));
  }
  const exact = data<ListData & { entriesVisited: number }>(await f.execute('list_files', {}));
  assert.deepEqual(exact.files, []);
  assert.equal(exact.entriesVisited, READ_TOOL_LIMITS.maxEntries);
  assert.equal(exact.truncated, false);
  await symlink(join(f.root, 'missing-target'), join(f.root, 'one-extra-link'), 'file');
  const clipped = data<ListData & { entriesVisited: number }>(await f.execute('list_files', {}));
  assert.equal(clipped.entriesVisited, READ_TOOL_LIMITS.maxEntries);
  assert.deepEqual(clipped.truncationReasons, ['entries']);
  const searched = data<SearchData & { entriesVisited: number }>(await f.execute('search_files', { query: 'unused' }));
  assert.equal(searched.entriesVisited, READ_TOOL_LIMITS.maxEntries);
  assert.deepEqual(searched.matches, []);
  assert.deepEqual(searched.truncationReasons, ['entries']);
});
