import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DEFAULT_LIMITS, type RunConfig } from '@moodcode/contracts';
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
  }
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
