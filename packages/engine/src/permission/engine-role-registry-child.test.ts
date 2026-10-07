import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { ApprovalRecord, JsonObject, RunReceipt, Session, Workspace } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { readPolicyDecisionReceipts } from './decision-receipts.js';
import { RoleResourcePolicyRegistry } from './role-policy-registry.js';
import type { RoleResourcePolicySnapshot } from './role-resources.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let release!: () => void;
  try { await Promise.race([promise, new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', release, { once: true }); if (signal.aborted) release(); })]); }
  finally { signal.removeEventListener('abort', release); }
}
const policy = (decision: 'allow' | 'deny'): RoleResourcePolicySnapshot => ({ revision: 1, rules: [{ id: 'actual-child-workspace-command', roleId: 'child-editor', toolName: 'run_command', effect: 'execute', resource: { kind: 'file', path: '.', descendants: true }, decision }] });

test('actual admitted child shares host policy generation, rejects old approval and executes only a freshly allowed command', { timeout: 25000, skip: process.platform === 'win32' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-role-registry-child-'))), repository = join(directory, 'repository'), artifacts = join(directory, 'artifacts'); await mkdir(repository);
  execFileSync('git', ['init', '--quiet', '--template=', repository]); await writeFile(join(repository, 'seed.txt'), 'Committed local child fixture\n'); execFileSync('git', ['-C', repository, 'add', 'seed.txt']); execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Local fixture']);
  const registry = new RoleResourcePolicyRegistry(policy('allow')), entered = gate(), parentRelease = gate(), children: MoodcodeEngine[] = [], observed = new Map<string, string>();
  const provider: ProviderAdapter = { id: 'role-registry-child-fixture', async *streamTurn(request, signal) {
    const prompt = request.messages.findLast(message => message.role === 'user')?.content;
    if (prompt === 'live-registry-parent') { entered.resolve(); yield { type: 'progress' }; await waitOrAbort(parentRelease.promise, signal); if (!signal.aborted) yield { type: 'finish', reason: 'stop' }; return; }
    assert.ok(prompt?.startsWith('actual-registry-child-')); assert.deepEqual(request.tools.map(tool => tool.name), ['run_command']);
    if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'child-exact-command', name: 'run_command', input: { command: 'printf actual-child-effect > effect.txt', cwd: '.', timeoutMs: 1000 } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { observed.set(request.runId, request.messages.findLast(message => message.role === 'tool')?.content ?? ''); yield { type: 'text.delta', delta: 'Child command observation finished.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: artifacts, providers: [provider], roleResourcePolicyRegistry: registry,
    resolveRoleResources: observation => observation.prepared.name === 'run_command' ? [{ kind: 'file', path: '.' }] : [{ kind: 'unknown', label: 'Host has no resource contract for this tool' }],
    defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: 10, maxToolCalls: 10, maxDurationMs: 60000 } },
    agentProfiles: [{ id: 'child-editor', description: 'Actual child command fixture.', instructions: 'Use only the allowed local command.', tools: ['run_command'] }],
    configureChild(child) { assert.strictEqual(child.roleResourcePolicyRegistry, registry); children.push(child); },
  });
  t.after(async () => { parentRelease.resolve(); try { await engine.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: repository }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  const worktree = await engine.createWorktree(session.id, 'actual-role-registry-child'), parent = await command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'live-registry-parent', config: { agentProfileId: 'child-editor' } }); await entered.promise;
  const start = (suffix: string) => engine.startChildTask({ sessionId: session.id, requestId: randomUUID(), parentRunId: parent.runId, worktreeId: worktree.id, prompt: `actual-registry-child-${suffix}`, tools: ['run_command'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 10000 } });
  async function pending(taskId: string): Promise<ApprovalRecord> {
    const deadline = Date.now() + 5000;
    for (;;) { const approval = engine.children.approvals(session.id, taskId)[0]; if (approval) return approval; const task = engine.children.tasks.get(session.id, taskId); assert.ok(['starting', 'running'].includes(task.state), JSON.stringify(task)); assert.ok(Date.now() < deadline, 'Actual child exact command approval must become ready'); await tick(); }
  }
  const effect = join(worktree.root, 'effect.txt'), stale = await start('stale'), oldApproval = await pending(stale.id); assert.equal(children.length, 1); assert.equal(existsSync(effect), false); assert.equal((oldApproval.preview.rolePolicy as { registryRevision: number }).registryRevision, 1);
  const staleChild = children[0]!, childWorkspace = staleChild.store.getWorkspace(staleChild.store.getSession(oldApproval.sessionId).workspaceId); assert.equal(childWorkspace.root, worktree.root); assert.notEqual(childWorkspace.root, repository); assert.equal(staleChild.getPolicyDecisionReceipts({ sessionId: oldApproval.sessionId, runId: oldApproval.runId, limit: 100 }).receipts.length, 1);
  const deniedGeneration = engine.replaceRoleResourcePolicy(1, policy('deny')); assert.equal(deniedGeneration.registryRevision, 2); engine.children.decide(session.id, stale.id, oldApproval.id, oldApproval.fingerprint, 'allow'); const staleOutcome = await engine.children.tasks.wait(session.id, stale.id);
  assert.equal(staleOutcome.state, 'completed'); assert.equal(existsSync(effect), false); assert.ok(observed.get(oldApproval.runId)?.includes('TOOL_CATALOGUE_STALE'));
  function durable(taskId: string) { return new SqliteStore(join(artifacts, 'children', taskId, 'engine.sqlite')); }
  const firstDb = durable(stale.id);
  try { assert.equal(firstDb.getApproval(oldApproval.id).status, 'allowed'); assert.equal(firstDb.getSnapshot(oldApproval.sessionId).tools.find(tool => tool.id === oldApproval.toolCallId)!.state, 'failed'); const receipt = readPolicyDecisionReceipts(firstDb, { sessionId: oldApproval.sessionId, runId: oldApproval.runId, limit: 100 }).receipts[0]!; assert.equal((receipt.receipt.rolePolicy as { registryRevision: number }).registryRevision, 1); } finally { firstDb.close(); }
  const denied = await start('denied'), deniedOutcome = await engine.children.tasks.wait(session.id, denied.id); assert.equal(deniedOutcome.state, 'completed'); assert.equal(existsSync(effect), false); assert.equal(children.length, 2);
  const deniedDb = durable(denied.id);
  try {
    const childSession = deniedDb.getSession(deniedDb.getRun(deniedOutcome.childRunId!).sessionId); const snapshot = deniedDb.getSnapshot(childSession.id), tool = snapshot.tools.find(tool => tool.name === 'run_command')!; assert.equal(tool.state, 'denied'); assert.equal(snapshot.approvals.length, 0); assert.ok(observed.get(tool.runId)?.includes('ROLE_RESOURCE_DENIED'));
    const receipt = readPolicyDecisionReceipts(deniedDb, { sessionId: childSession.id, runId: tool.runId, limit: 100 }).receipts[0]!.receipt; assert.equal((receipt.rolePolicy as { registryRevision: number }).registryRevision, 2); assert.equal((receipt.roleResource as { decision: string }).decision, 'deny');
  } finally { deniedDb.close(); }
  const allowedGeneration = engine.replaceRoleResourcePolicy(2, policy('allow')), fresh = await start('fresh'), freshApproval = await pending(fresh.id); assert.equal(children.length, 3); assert.equal((freshApproval.preview.rolePolicy as { registryRevision: number }).registryRevision, allowedGeneration.registryRevision); assert.notEqual(freshApproval.fingerprint, oldApproval.fingerprint);
  engine.children.decide(session.id, fresh.id, freshApproval.id, freshApproval.fingerprint, 'allow'); assert.equal((await engine.children.tasks.wait(session.id, fresh.id)).state, 'completed'); assert.equal(await readFile(effect, 'utf8'), 'actual-child-effect'); assert.equal(existsSync(join(repository, 'effect.txt')), false);
  const freshDb = durable(fresh.id); try { assert.equal(freshDb.getSnapshot(freshApproval.sessionId).tools.find(tool => tool.id === freshApproval.toolCallId)!.state, 'completed'); } finally { freshDb.close(); }
  parentRelease.resolve(); assert.equal((await engine.waitForRun(parent.runId)).state, 'completed');
});
