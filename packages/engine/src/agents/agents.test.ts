import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, type RunConfig } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { AgentProfiles } from './index.js';

test('profile model, instructions, tools and allowance have an immutable revision independent of mode', t => {
  const store = new SqliteStore(':memory:'); t.after(() => store.close()); const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'w', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt }); store.createSession({ id: 's', workspaceId: 'w', title: 'profiles', createdAt });
  const profiles = new AgentProfiles(store, [{ id: 'review', description: 'Read changes', instructions: 'Check current files before conclusions.', tools: ['read_file'], model: { providerId: 'fixture', modelId: 'review-model', reasoningEffort: 'high' }, turnAllowance: 3 }]);
  const config: RunConfig = { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS }, agentProfileId: 'review' };
  const selected = profiles.apply('s', config); assert.equal(selected.mode, 'build'); assert.equal(selected.providerId, 'fixture'); assert.equal(selected.budgets!.turnAllowance, 3); assert.equal(selected.reasoningEffort, 'high');
  const revision = selected.agentProfileRevision; assert.ok(revision); assert.deepEqual(profiles.forRun('s', selected)!.tools, ['read_file']);
  const reopened = new AgentProfiles(store); assert.equal(reopened.forRun('s', selected)!.revision, revision);
  profiles.register({ id: 'review', description: 'Updated', instructions: 'New instructions', tools: [] });
  assert.equal(profiles.forRun('s', selected)!.revision, revision, 'a running profile retains its admitted configuration');
  assert.throws(() => profiles.apply('s', selected));
  assert.notEqual(profiles.apply('s', { ...config, agentProfileRevision: undefined }).agentProfileRevision, revision);
  assert.throws(() => profiles.register({ id: 'bad', description: '', instructions: '', tools: ['read_file', 'read_file'] }));
});
