import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalReferenceService } from './skills.js';

test('workspace-local skills and references return bounded content with provenance and reject escapes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-local-skills-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.moodcode', 'skills', 'check', 'references'), { recursive: true });
  await mkdir(join(root, '.moodcode', 'references'), { recursive: true });
  await writeFile(join(root, '.moodcode', 'skills', 'check', 'SKILL.md'), '---\ndescription: "Verify local checks"\n---\nRead a fixture.');
  await writeFile(join(root, '.moodcode', 'skills', 'check', 'references', 'one.txt'), 'reference one');
  await writeFile(join(root, '.moodcode', 'references', 'large.txt'), '한'.repeat(30_000));
  const service = new LocalReferenceService(), signal = new AbortController().signal;
  const listed = await service.list(root, signal);
  assert.equal(listed.skills[0]!.id, 'check'); assert.equal(listed.skills[0]!.description, 'Verify local checks');
  assert.equal((await service.skill(root, 'check', 'references/one.txt', signal)).text, 'reference one');
  const result = await service.reference(root, 'large.txt', signal); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.text) <= 65_536); assert.ok(result.source.startsWith('.moodcode/references/'));
  await assert.rejects(service.skill(root, 'check', '../other/SKILL.md', signal));
  await assert.rejects(service.reference(root, '/absolute.txt', signal));
});

test('local discovery ignores symlink skills and binary references and checks cancellation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-local-skills-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.moodcode', 'skills'), { recursive: true }); await mkdir(join(root, '.moodcode', 'references'));
  await mkdir(join(root, 'outside')); await writeFile(join(root, 'outside', 'SKILL.md'), 'outside skill');
  await symlink(join(root, 'outside'), join(root, '.moodcode', 'skills', 'linked'));
  await writeFile(join(root, '.moodcode', 'references', 'binary'), Buffer.from([0, 1]));
  const service = new LocalReferenceService(), signal = new AbortController().signal;
  assert.deepEqual((await service.list(root, signal)).skills, []);
  await assert.rejects(service.skill(root, 'linked', undefined, signal)); await assert.rejects(service.reference(root, 'binary', signal));
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(service.list(root, cancelled.signal));
});
