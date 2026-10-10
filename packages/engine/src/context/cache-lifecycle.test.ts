import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DEFAULT_LIMITS, type JsonObject, type Message, type Run, type RunConfig, type ToolCallRecord } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { ContextService } from './service.js';

test('long-lived context service evicts idle instruction caches and reloads persisted owner-validated baselines', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-context-caches-'))), store = new SqliteStore(':memory:');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  await writeFile(join(root, 'AGENTS.md'), 'Persist this exact workspace baseline 🌊');
  const config: RunConfig = { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } };
  const service = new ContextService(store), signal = new AbortController().signal;
  const build = (sessionId: string) => service.build({ workspace: store.getWorkspace('workspace'), snapshot: service.snapshot(sessionId, config), config, signal });
  for (let index = 0; index < 130; index++) {
    const id = 'session-' + index;
    store.createSession({ id, workspaceId: 'workspace', title: 'Long-lived fixture', createdAt });
    assert.ok((await build(id)).some(message => message.content.includes('Persist this exact workspace baseline')));
    service.releaseContext(id);
  }
  assert.equal(Reflect.get(service, 'history') instanceof Map, false, 'Settled sessions must not remain strongly retained by a session metadata Map');
  assert.equal(Reflect.get(service, 'revisions') instanceof Map, false, 'The original durable revision is sufficient after an idle context is released');
  const persisted = store.getSessionDocument('session-0', 'context.head')!;
  assert.equal(service.revisionId('session-0'), persisted.data.revisionId);
  assert.equal(new ContextService(store).revisionId('session-0'), persisted.data.revisionId);
  const supplied = store.getSnapshot('session-0');
  assert.ok((await service.build({ workspace: store.getWorkspace('workspace'), snapshot: structuredClone(supplied), config, signal })).some(message => message.content.includes('Persist this exact workspace baseline')));
  // A transient unreadable observation must reload the prior baseline even
  // after its in-memory entry was evicted. Oversized text never replaces it.
  await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(32769));
  const retained = await build('session-0');
  assert.ok(retained.some(message => message.content.includes('Persist this exact workspace baseline 🌊')));
  const sources = service.diagnostics('session-0')!.instructions.sources;
  assert.equal(sources[0]?.retainedBaseline, true); assert.equal(sources[0]?.status, 'unavailable');
  assert.equal(sources[0]?.text, null);
  await unlink(join(root, 'AGENTS.md'));
  assert.ok((await build('session-0')).every(message => !message.content.includes('Persist this exact workspace baseline')));
  assert.equal(service.diagnostics('session-0')!.instructions.sources[0]?.status, 'missing');
});

test('model-chosen tool arguments are instruction hints that cannot fail context building', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-instruction-hints-'))), store = new SqliteStore(':memory:');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet', '--template=', root]);
  const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Instruction hint fixture', createdAt });
  await writeFile(join(root, '.gitignore'), 'vendor/\nsrc/AGENTS.md\n');
  for (const [directory, text] of [['src', 'Nested source guidance'], ['mcp', 'Guidance from an MCP path'], [join('vendor', 'pkg'), 'Vendored package guidance']] as const) {
    await mkdir(join(root, directory), { recursive: true }); await writeFile(join(root, directory, 'AGENTS.md'), text);
  }
  const config: RunConfig = { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } };
  const service = new ContextService(store), signal = new AbortController().signal;
  const run: Run = { id: 'run', inputId: 'input', sessionId: 'session', workspaceId: 'workspace', requestId: 'request', prompt: 'Inspect', config, state: 'running', createdAt, updatedAt: createdAt };
  const deep = Array.from({ length: 4 }, (_, index) => `m${index}/src/main/java/com/acme/m${index}/service/A.java`);
  const inputs: [string, JsonObject][] = [
    ['read_file', { path: join(root, 'src', 'a.ts') }], ['read_file', { path: '../outside.ts' }], ['read_file', { path: 'src/\0a.ts' }],
    ['execute_code', { source: `${'x/'.repeat(40)}${'y'.repeat(5000)}` }], ['mcp_fs_read', { path: 'mcp/a.ts' }],
    ['read_file', { path: 'src/a.ts' }], ['read_file', { path: 'vendor/pkg/a.ts' }], ...deep.map((path): [string, JsonObject] => ['read_file', { path }]),
  ];
  const tools: ToolCallRecord[] = inputs.map(([name, input], index) => ({ id: `tool-${index}`, runId: run.id, sessionId: 'session', name, input, state: 'failed' }));
  const messages: Message[] = [{ id: 'user', sessionId: 'session', runId: run.id, role: 'user', content: 'Inspect the sources', createdAt }];
  const built = await service.build({ workspace: store.getWorkspace('workspace'), snapshot: { ...service.snapshot('session', config), runs: [run], messages, tools }, config, signal });
  assert.ok(built.some(message => message.content.includes('Nested source guidance')), 'A file-specific ignore rule does not hide a nested instruction file');
  assert.ok(built.every(message => !message.content.includes('Guidance from an MCP path') && !message.content.includes('Vendored package guidance')));
  const instructions = service.diagnostics('session')!.instructions, vendored = join('vendor', 'pkg', 'AGENTS.md');
  assert.deepEqual(instructions.sources.filter(source => source.status === 'available').map(source => source.path), [join('src', 'AGENTS.md')]);
  assert.ok(instructions.sources.every(source => !source.path.startsWith('m3') && source.path !== vendored));
  assert.ok(instructions.warnings.some(warning => warning.includes('instruction scope limit')));
  assert.ok(instructions.warnings.includes(`Instruction source ${vendored} is in a Git-ignored directory and was not loaded.`));
  const baselineKey = `instruction.${createHash('sha256').update(JSON.stringify('instruction:vendor/pkg/AGENTS.md')).digest('hex').slice(0, 32)}`;
  assert.equal(store.getSessionDocument('session', baselineKey), null, 'An ignored dependency file never becomes a session baseline');
});
