import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InstructionSources } from './sources.js';

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
