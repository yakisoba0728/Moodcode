import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { InstructionSources, instructionPathHints, type InstructionSource } from './sources.js';

test('nested instructions have explicit scopes and a changed hash at the next observation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'root guidance');
  await writeFile(join(root, 'src', 'AGENTS.md'), 'src guidance');
  const sources = new InstructionSources(root);
  const first = await sources.observe(['src/nested/file.ts'], new AbortController().signal);
  assert.deepEqual(first.sources.map(source => source.scope), ['', 'src', join('src', 'nested')]);
  assert.equal(first.sources[2]!.status, 'missing');
  const second = await sources.observe(['src/nested/file.ts'], new AbortController().signal);
  assert.deepEqual(second.changedSourceIds, []);
  await writeFile(join(root, 'src', 'AGENTS.md'), 'updated src guidance');
  const updated = await sources.observe(['src/nested/file.ts'], new AbortController().signal);
  assert.deepEqual(updated.changedSourceIds, ['instruction:src/AGENTS.md']);
  await assert.rejects(sources.observe(['../outside/file.ts'], new AbortController().signal));
});

test('unavailable symlink preserves valid baseline but deletion removes it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'AGENTS.md');
  await writeFile(path, 'valid guidance');
  const sources = new InstructionSources(root);
  await sources.observe([], new AbortController().signal);
  await rm(path);
  await symlink(join(root, 'target.md'), path);
  const unavailable = await sources.observe([], new AbortController().signal);
  assert.equal(unavailable.sources[0]!.status, 'unavailable');
  assert.equal(unavailable.sources[0]!.retainedBaseline, true);
  assert.equal(unavailable.sources[0]!.text, 'valid guidance');
  await rm(path);
  const removed = await sources.observe([], new AbortController().signal);
  assert.equal(removed.sources[0]!.status, 'missing');
  assert.equal(removed.sources[0]!.text, null);
  assert.deepEqual(removed.changedSourceIds, ['instruction:AGENTS.md']);
});

test('durable source baseline survives a fresh reader and transient size/symlink failures until actual deletion', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-durable-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'AGENTS.md'), durable = new Map<string, InstructionSource>(), saved: InstructionSource[] = [];
  const persistence = {
    loadBaseline(id: string) { return durable.has(id) ? structuredClone(durable.get(id)!) : null; },
    saveBaseline(source: InstructionSource) { durable.set(source.id, structuredClone(source)); saved.push(structuredClone(source)); },
  };
  await writeFile(path, '지속되는 root guidance');
  const first = await new InstructionSources(root, persistence).observe([], new AbortController().signal);
  assert.equal(first.sources[0]!.workspaceRoot, root); assert.equal(saved.length, 1);
  await writeFile(path, '😀'.repeat(8193));
  const oversized = await new InstructionSources(root, persistence).observe([], new AbortController().signal);
  assert.equal(oversized.sources[0]!.status, 'unavailable'); assert.equal(oversized.sources[0]!.retainedBaseline, true);
  assert.equal(oversized.sources[0]!.text, first.sources[0]!.text); assert.deepEqual(oversized.changedSourceIds, []);
  assert.equal(saved.length, 1, 'An unavailable observation cannot replace the durable last-valid baseline');
  await rm(path); await symlink(join(root, 'target.md'), path);
  const linked = await new InstructionSources(root, persistence).observe([], new AbortController().signal);
  assert.equal(linked.sources[0]!.status, 'unavailable'); assert.equal(linked.sources[0]!.text, first.sources[0]!.text);
  assert.equal(saved.length, 1);
  await rm(path);
  const removed = await new InstructionSources(root, persistence).observe([], new AbortController().signal);
  assert.equal(removed.sources[0]!.status, 'missing'); assert.equal(removed.sources[0]!.text, null);
  assert.deepEqual(removed.changedSourceIds, ['instruction:AGENTS.md']); assert.equal(saved.length, 2);
  assert.equal(durable.get('instruction:AGENTS.md')!.status, 'missing');
  await writeFile(path, 'x'.repeat(32769));
  const afterDeletion = await new InstructionSources(root, persistence).observe([], new AbortController().signal);
  assert.equal(afterDeletion.sources[0]!.retainedBaseline, false); assert.equal(afterDeletion.sources[0]!.text, null);
  assert.equal(saved.length, 2);
});

test('persisted baselines reject forged workspace, candidate, scope, status, text, digest and timestamp', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-forged-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'AGENTS.md'), 'valid text');
  let valid: InstructionSource | null = null;
  await new InstructionSources(root, { loadBaseline: () => null, saveBaseline: source => { valid = structuredClone(source); } }).observe([], new AbortController().signal);
  const baseline = valid as InstructionSource | null;
  assert.ok(baseline);
  const changes: Partial<InstructionSource>[] = [
    { workspaceRoot: join(root, 'other') }, { workspaceRoot: undefined }, { id: 'instruction:other/AGENTS.md' },
    { path: '../AGENTS.md' }, { path: join(root, 'AGENTS.md') }, { scope: 'other' }, { status: 'unavailable' },
    { text: 'x'.repeat(32769) }, { text: '\ud800' }, { text: 'forged text' }, { sha256: '0'.repeat(64) },
    { observedAt: 'invalid timestamp' }, { retainedBaseline: true }, { status: 'missing' },
  ];
  for (const change of changes) {
    const source = { ...baseline, ...change } as InstructionSource;
    let writes = 0;
    const reader = new InstructionSources(root, { loadBaseline: () => structuredClone(source), saveBaseline: () => { writes++; } });
    await assert.rejects(reader.observe([], new AbortController().signal), error => error instanceof EngineError && error.code === 'INSTRUCTION_BASELINE_INVALID');
    assert.equal(writes, 0);
  }
});

test('durable write failure cannot install a volatile baseline and callback/default results stay detached', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-baseline-write-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'AGENTS.md'); await writeFile(path, 'candidate guidance');
  const reader = new InstructionSources(root, { loadBaseline: () => null, saveBaseline: () => { throw new Error('durable write failed'); } });
  await assert.rejects(reader.observe([], new AbortController().signal), /durable write failed/);
  await writeFile(path, 'x'.repeat(32769));
  const unavailable = await reader.observe([], new AbortController().signal);
  assert.equal(unavailable.sources[0]!.retainedBaseline, false); assert.equal(unavailable.sources[0]!.text, null);
  await writeFile(path, 'actual guidance');
  const detached = new InstructionSources(root, { loadBaseline: () => null, saveBaseline: source => { source.text = 'callback mutation'; } });
  const first = await detached.observe([], new AbortController().signal);
  assert.equal(first.sources[0]!.text, 'actual guidance');
  first.sources[0]!.text = 'caller mutation';
  await writeFile(path, 'x'.repeat(32769));
  assert.equal((await detached.observe([], new AbortController().signal)).sources[0]!.text, 'actual guidance');
  const ordinary = await new InstructionSources(root).observe([], new AbortController().signal);
  assert.equal(Object.hasOwn(ordinary.sources[0]!, 'workspaceRoot'), false);
});

test('dependency and VCS trees never provide instructions while build output scopes still do', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-dependency-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const site = join('.venv', 'lib', 'python3.12', 'site-packages', 'pkg');
  for (const directory of [join('node_modules', 'pkg', 'lib'), join('Node_Modules', 'other'), join('app', '.git'), site, join('lib', 'site-packages', 'mod'), 'dist'])
    await mkdir(join(root, directory), { recursive: true });
  for (const directory of [join('node_modules', 'pkg'), 'node_modules', join('Node_Modules', 'other'), join('app', '.git'), site, '.venv', join('lib', 'site-packages', 'mod')])
    await writeFile(join(root, directory, 'AGENTS.md'), 'Dependency instructions');
  await writeFile(join(root, 'dist', 'AGENTS.md'), 'Build output guidance'); await writeFile(join(root, 'app', 'AGENTS.md'), 'App guidance');
  const observed = await new InstructionSources(root).observe(['node_modules/pkg/lib/index.js', 'Node_Modules/other/x.js', 'app/.git/config',
    `${site.split('\\').join('/')}/mod.py`, 'lib/site-packages/mod/a.py', 'dist/app.js'], new AbortController().signal);
  assert.deepEqual(observed.sources.map(source => source.path), ['AGENTS.md', 'app/AGENTS.md', 'dist/AGENTS.md', 'lib/AGENTS.md'].map(path => path.split('/').join(sep)));
  assert.deepEqual(observed.sources.filter(source => source.text !== null).map(source => source.text), ['App guidance', 'Build output guidance']);
});

test('path hints skip invalid values and leave out whole paths past the scope limit', () => {
  const root = join(tmpdir(), 'moodcode-hint-root'), deep = Array.from({ length: 31 }, (_, index) => `d${index}`).join('/');
  const hints = [join(root, 'src', 'a.ts'), '../outside.ts', 'src/\0a.ts', 'x/'.repeat(2100), `${deep}/file.ts`, 'other/file.ts', 'd0/d1/file.ts', 'node_modules/a/b/c.js', 'top.ts'];
  const selected = instructionPathHints(root, hints);
  assert.deepEqual(selected.paths, [`${deep}/file.ts`, 'd0/d1/file.ts', 'node_modules/a/b/c.js', 'top.ts']);
  assert.deepEqual(selected.warnings, ['1 instruction path hint(s) were skipped at the 32-source instruction scope limit.']);
  assert.deepEqual(instructionPathHints(root, ['src/a.ts']), { paths: ['src/a.ts'], warnings: [] });
});

test('nested instructions in Git-ignored directories are dropped and an unchecked lookup fails closed', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-ignored-instructions-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const directory of ['ignored', 'kept']) { await mkdir(join(root, directory)); await writeFile(join(root, directory, 'AGENTS.md'), `${directory} guidance`); }
  await writeFile(join(root, 'AGENTS.md'), 'root guidance');
  const paths = ['ignored/a.ts', 'kept/a.ts', 'missing/a.ts'], lookups: string[][] = [], saved: string[] = [];
  const persistence = { loadBaseline: () => null, saveBaseline: (source: InstructionSource) => { saved.push(source.id); } };
  const filtered = await new InstructionSources(root, persistence, async directories => { lookups.push(directories); return new Set(['ignored']); }).observe(paths, new AbortController().signal);
  assert.deepEqual(lookups, [['ignored', 'kept']]);
  assert.deepEqual(filtered.sources.map(source => source.text), ['root guidance', 'kept guidance', null]);
  assert.deepEqual(filtered.warnings, [`Instruction source ${join('ignored', 'AGENTS.md')} is in a Git-ignored directory and was not loaded.`]);
  assert.ok(!saved.includes('instruction:ignored/AGENTS.md'));
  const failed = await new InstructionSources(root, undefined, async () => { throw new EngineError('IGNORE_LOOKUP_FAILED', 'unavailable'); }).observe(paths, new AbortController().signal);
  assert.deepEqual(failed.sources.map(source => source.path), ['AGENTS.md', join('missing', 'AGENTS.md')]);
  assert.deepEqual(failed.warnings, ['Nested instruction sources were not loaded because Git ignore rules could not be checked.']);
  const controller = new AbortController();
  const aborted = new InstructionSources(root, undefined, async () => { controller.abort(); throw new EngineError('ABORTED', 'aborted'); });
  await assert.rejects(aborted.observe(paths, controller.signal), error => error instanceof EngineError && error.code === 'CANCELLED');
});
