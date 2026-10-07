import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { ApprovalRecord, JsonObject, ProviderToolCall, RunReceipt, Session, Workspace } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { CommandPreflightRegistry } from './preflight.js';
import { RoleResourcePolicy } from './role-resources.js';

async function fixture(t: test.TestContext, call: ProviderToolCall, options: Partial<EngineOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-engine-role-'))), repository = join(directory, 'repository'); await mkdir(repository); await mkdir(join(repository, 'src')); await writeFile(join(repository, 'src', 'a.ts'), 'role-visible-source-marker\n');
  execFileSync('git', ['init', '--quiet', '--template=', repository]);
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'engine-role-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (request.turnIndex === 0) { yield { type: 'tool.call', call }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Fixture execution ended.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 10000 } }, agentProfiles: [{ id: 'editor', description: 'Fixture coding role', instructions: 'Use only fixture tools.', tools: ['read_file', 'run_command', 'discover_tools'] }], ...options });
  t.after(async () => { await engine.close(); await rm(directory, { force: true, recursive: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: repository }); const session = await command<Session>('session.create', { workspaceId: workspace.id });
  const submit = () => command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Run the bounded local fixture.', config: { agentProfileId: 'editor' } });
  async function pendingApproval(runId: string): Promise<ApprovalRecord> { const deadline = Date.now() + 5000; for (;;) { const pending = engine.store.getSnapshot(session.id).approvals.find(value => value.runId === runId && value.status === 'pending'); if (pending) return pending; assert.ok(Date.now() < deadline, 'Exact approval must become pending'); await tick(); } }
  return { repository, engine, command, workspace, session, requests, submit, pendingApproval };
}

for (const discovery of [false, true]) for (const decision of ['allow', 'deny'] as const) {
  test(`actual Engine ${discovery ? 'discovery' : 'eager'} profile ${decision} is applied to the model tool and durably explained`, { timeout: 10000 }, async t => {
    const policy = new RoleResourcePolicy({ revision: 1, rules: [{ id: 'source-role', roleId: 'editor', resource: { kind: 'file', path: 'src', descendants: true }, decision }] });
    const f = await fixture(t, { id: 'read-role-file', name: 'read_file', input: { path: 'src/a.ts' } }, { roleResourcePolicy: policy,
      resolveRoleResources: observation => [{ kind: 'file', path: (observation.prepared.input as { path: string }).path }],
      ...(discovery ? { toolDiscoveryPolicy: { kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: ['read_file'] } } : {}) });
    const receipt = await f.submit(); const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'completed'); assert.ok(run.config.agentProfileRevision); assert.equal(f.requests.length, 2);
    assert.ok(f.requests[0]!.tools.some(tool => tool.name === 'read_file')); const snapshot = f.engine.store.getSnapshot(f.session.id); const call = snapshot.tools.find(value => value.name === 'read_file')!;
    assert.equal(call.state, decision === 'allow' ? 'completed' : 'denied'); assert.equal(snapshot.approvals.length, 0);
    const modelResult = f.requests[1]!.messages.findLast(message => message.role === 'tool')!.content;
    assert.equal(modelResult.includes('role-visible-source-marker'), decision === 'allow'); if (decision === 'deny') assert.ok(modelResult.includes('ROLE_RESOURCE_DENIED'));
    const events = f.engine.store.readSessionEvents(f.session.id, 0, 100).filter(event => event.type === 'tool.policy_decision'); assert.equal(events.length, 1); assert.equal(events[0]!.payload.authority, 'observation-only');
    const page = f.engine.getPolicyDecisionReceipts({ sessionId: f.session.id, runId: run.id, limit: 100, maxBytes: 65536 }); assert.equal(page.authority, 'observation-only'); assert.equal(page.receipts.length, 1);
    const stored = page.receipts[0]!.receipt.roleResource as { decision: string; roleId: string; roleRevision: string; matchedRules: unknown[] }; assert.equal(stored.decision, decision); assert.equal(stored.roleId, 'editor'); assert.equal(stored.roleRevision, run.config.agentProfileRevision); assert.equal(stored.matchedRules.length, 1);
    stored.roleId = 'mutated-client-copy'; assert.equal((f.engine.getPolicyDecisionReceipts({ sessionId: f.session.id, runId: run.id, limit: 100 }).receipts[0]!.receipt.roleResource as { roleId: string }).roleId, 'editor');
  });
}

for (const stale of [false, true]) {
  test(`actual approved run_command ${stale ? 'rejects changed source with zero command effect' : 'runs exact command after bound preflight'}`, { timeout: 15000, skip: process.platform === 'win32' }, async t => {
    const registry = new CommandPreflightRegistry(); let checkedCommand = '', checkedCwd = '', checkedSource = '';
    registry.register({ id: 'fixture-analyzer', revision: 1, sourceSha256: 'a'.repeat(64), async analyze(context) { checkedCommand = context.binding.command; checkedCwd = context.binding.cwd; checkedSource = context.binding.sourceRevision; return { decision: 'allow', findings: [] }; } });
    const exactCommand = 'printf verified > effect.txt';
    const f = await fixture(t, { id: 'command', name: 'run_command', input: { command: exactCommand, cwd: '.', timeoutMs: 1000 } }, {
      roleResourcePolicy: new RoleResourcePolicy({ revision: 1, rules: [{ id: 'explicit-command-role', roleId: 'editor', effect: 'execute', resource: { kind: 'all' }, decision: 'allow' }] }),
      resolveRoleResources: () => [{ kind: 'file', path: '.' }],
      commandPreflight: { registry, selectAnalyzer: observation => observation.prepared.name === 'run_command' ? 'fixture-analyzer' : undefined,
        resolveSourceRevision: observation => createHash('sha256').update(readFileSync(join(observation.identity.workspaceRoot, 'src', 'a.ts'))).digest('hex') },
    });
    const receipt = await f.submit(); const pending = await f.pendingApproval(receipt.runId); assert.equal(existsSync(join(f.repository, 'effect.txt')), false);
    assert.equal(checkedCommand, exactCommand); assert.equal(checkedCwd, f.repository); assert.match(checkedSource, /^[a-f0-9]{64}$/);
    assert.equal((pending.preview.commandPreflight as { osIsolation: boolean }).osIsolation, false); assert.equal((pending.preview.roleResourceDecision as { decision: string }).decision, 'ask', 'Role allowance cannot lower exact producer approval');
    if (stale) await writeFile(join(f.repository, 'src', 'a.ts'), 'changed-uncommitted-source\n');
    await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' }); const run = await f.engine.waitForRun(receipt.runId);
    const call = f.engine.store.getSnapshot(f.session.id).tools.find(value => value.name === 'run_command')!;
    assert.equal(existsSync(join(f.repository, 'effect.txt')), !stale, JSON.stringify({ runState: run.state, runError: run.error, toolState: call.state, toolError: call.error, output: call.output })); if (!stale) assert.equal(readFileSync(join(f.repository, 'effect.txt'), 'utf8'), 'verified');
    assert.equal(call.state, stale ? 'failed' : 'completed'); if (stale) assert.ok(f.requests[1]!.messages.findLast(message => message.role === 'tool')!.content.includes('COMMAND_PREFLIGHT_STALE'));
    const page = f.engine.getPolicyDecisionReceipts({ sessionId: f.session.id, runId: receipt.runId, limit: 100 }); assert.equal(page.receipts.length, 1); assert.equal((page.receipts[0]!.receipt.commandPreflight as { sourceRevision: string }).sourceRevision, checkedSource);
  });
}
