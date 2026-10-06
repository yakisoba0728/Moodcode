import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, EngineError } from '@moodcode/contracts';
import { loadConfig } from './index.js';

test('engine budget config merges independent limits and reasoning while retaining legacy omission', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-budgets-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const userConfigPath = join(root, 'user.json');
  const workspaceConfigPath = join(root, 'workspace.json');
  await writeFile(userConfigPath, JSON.stringify({ reasoningEffort: 'high', budgets: { turnAllowance: 4, maxPendingInputs: 10 } }));
  await writeFile(workspaceConfigPath, JSON.stringify({ budgets: { maxPendingBytes: 4096, maxPendingInputs: 5 } }));
  const result = await loadConfig({ userConfigPath, workspaceConfigPath });
  assert.deepEqual(result.runConfig.budgets, { ...DEFAULT_ENGINE_BUDGETS, turnAllowance: 4, maxPendingInputs: 5, maxPendingBytes: 4096 });
  assert.equal(result.runConfig.reasoningEffort, 'high');
  assert.ok(Object.isFrozen(result.runConfig.budgets));
  assert.equal((await loadConfig()).runConfig.budgets, undefined);
  await writeFile(userConfigPath, JSON.stringify({ budgets: { maxPendingInputs: 0 } }));
  await assert.rejects(loadConfig({ userConfigPath, workspaceConfigPath }), (error: unknown) =>
    error instanceof EngineError && error.code === 'CONFIG_INVALID' && error.details?.field === 'budgets.maxPendingInputs');
});
