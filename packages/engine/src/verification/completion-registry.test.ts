import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ApprovalRecord, JsonObject, RunReceipt, Session, Workspace } from '@moodcode/contracts';
import { createEngine } from '../index.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';

async function fixture(t: TestContext, phase: 'after-pass' | 'before-plan', maxRepairs: number) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-registry-'))), root = join(base, 'repository');
  await mkdir(root); execFileSync('git', ['init', '--quiet', '--template=', root]); await writeFile(join(root, 'a.ts'), 'export const alpha = 1;\n');
  const requests: TurnRequest[] = []; let unregister: () => void = () => { throw new Error('Host check has not been registered'); };
  const provider: ProviderAdapter = { id: 'registry-fixture', async *streamTurn(request) {
    requests.push(structuredClone(request));
    if (phase === 'after-pass' && request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'actual-check', name: 'verify_changes', input: { checkId: 'registered-check' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { unregister(); yield { type: 'text.delta', delta: 'The provider reached its normal stop.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(base, 'engine.sqlite'), artifactDir: join(base, 'artifacts'), verificationTools: true, providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 10000 } }, agentProfiles: [{ id: 'verifier', description: 'Registry fixture', instructions: 'Use the selected check.', tools: ['verify_changes', 'run_command'] }] });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; };
  const workspace = await command<Workspace>('workspace.open', { path: root }), session = await command<Session>('session.create', { workspaceId: workspace.id }), profile = engine.profiles.list()[0]!;
  unregister = engine.registerVerificationCheck({ id: 'registered-check', revision: 1, workspaceId: workspace.id, command: 'printf checked > verification-effect.txt', cwd: root, profileId: profile.id, profileRevision: profile.revision, sourceRevision: 'host-v1', timeoutMs: 2000, maxOutputBytes: 8192, required: true });
  await engine.configureVerificationSession(session.id, 0, { checkIds: ['registered-check'], sourcePaths: ['a.ts'], maxRepairs });
  const submitted = await command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Complete the current task and verify it.', config: { agentProfileId: profile.id } });
  const pendingApproval = async (): Promise<ApprovalRecord> => { const deadline = Date.now() + 5000; for (;;) { const pending = engine.store.getSnapshot(session.id).approvals.find(value => value.status === 'pending'); if (pending) return pending; assert.ok(Date.now() < deadline, 'Exact command approval must become pending'); await new Promise(done => setTimeout(done, 5)); } };
  return { root, engine, session, submitted, requests, command, pendingApproval };
}

test('unregister after actual passing receipt blocks task verification while preserving normal output completion and exact evidence', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'after-pass', 2), approval = await f.pendingApproval(); assert.equal(existsSync(join(f.root, 'verification-effect.txt')), false);
  await f.command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
  const run = await f.engine.waitForRun(f.submitted.runId), verification = f.engine.getVerificationState(f.session.id, run.id)!, completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(run.error, undefined); assert.equal(verification.receipts.length, 1); assert.equal(verification.receipts[0]!.status, 'pass'); assert.equal(verification.plans.length, 1);
  assert.equal(completion.result.taskVerified, false); assert.equal(completion.result.status, 'blocked'); assert.equal(completion.result.reason, 'check_stale'); assert.equal(completion.repairsUsed, 0); assert.equal(completion.stages.length, 0);
  assert.equal(f.requests.length, 2); assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1); assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(verification.receipts[0]!.observation!.exitCode, 0); assert.equal(verification.receipts[0]!.observation!.cleanup.confirmed, true); assert.equal(existsSync(join(f.root, 'verification-effect.txt')), true);
});

for (const maxRepairs of [0, 2]) test(`missing registration before the first plan produces blocked completion without allocating host configured ${maxRepairs} repairs`, { timeout: 10000 }, async t => {
  const f = await fixture(t, 'before-plan', maxRepairs), run = await f.engine.waitForRun(f.submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(run.error, undefined); assert.equal(f.engine.getVerificationState(f.session.id, run.id), null);
  assert.equal(completion.result.taskVerified, false); assert.equal(completion.result.status, 'blocked'); assert.equal(completion.result.reason, 'check_stale'); assert.equal(completion.repairsUsed, 0); assert.equal(completion.stages.length, 0);
  assert.equal(completion.maxRepairs, 0); assert.equal(completion.completion!.authority, 'observation-only'); assert.equal(f.requests.length, 1);
  const snapshot = f.engine.store.getSnapshot(f.session.id); assert.equal(snapshot.tools.length, 0); assert.equal(snapshot.approvals.length, 0); assert.equal(existsSync(join(f.root, 'verification-effect.txt')), false);
});
