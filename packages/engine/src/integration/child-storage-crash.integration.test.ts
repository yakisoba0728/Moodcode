import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import type { ChildTaskRecord } from '../child-tasks/index.js';
import { childStorageKind, type ChildStorageRecord } from '../child-tasks/storage-binding.js';
import { exportEngineArchive, importEngineArchive, validateEngineArchive } from '../storage/archive.js';
import { SqliteStore } from '../storage/index.js';
import type { AttemptCleanupRecord } from '../storage/attempt-cleanup.js';
import { CHILD_STORAGE_CRASH_PHASES, fixtureDatabase, fixtureSnapshot, rowData, stoppedFixtureSnapshot,
  type ChildStorageCrashPhase, type ChildStorageCrashReady, type CrashSnapshot } from './child-storage-crash.fixture.js';

// No provider account, GUI or existing checkout participates in this fixture.
// Commit wrappers stop an actual worker; mocked write failures are tested elsewhere.
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
interface ProviderCall { purpose: string; runId: string; attemptId: string; requestSha256: string; requestBytes: number }
function calls(directory: string): ProviderCall[] {
  const path = join(directory, 'provider-calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ProviderCall) : [];
}
function document(snapshot: CrashSnapshot, sessionId: string, kind: string) {
  return snapshot.session_documents.find(row => row.session_id === sessionId && row.kind === kind);
}
function task(snapshot: CrashSnapshot, ready: ChildStorageCrashReady): ChildTaskRecord {
  const journal = rowData<{ tasks: ChildTaskRecord[] }>(document(snapshot, ready.sessionId, 'engine.child_tasks')!);
  const record = journal.tasks.find(value => value.id === ready.taskId); assert.ok(record); return record;
}
function tree(directory: string): Record<string, { bytes: number; sha256: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }> {
  const result: ReturnType<typeof tree> = {};
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, tree(path));
    else {
      const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      result[path] = { bytes: stat.size, sha256: hash(readFileSync(path)), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    }
  }
  return result;
}
async function launch(t: TestContext, directory: string, phase: ChildStorageCrashPhase) {
  const source = import.meta.url.endsWith('.ts');
  const path = fileURLToPath(new URL(`./child-storage-crash-worker.${source ? 'ts' : 'js'}`, import.meta.url));
  const worker = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), path, directory, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; worker.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
  const exited = new Promise<void>(resolve => worker.once('close', () => resolve()));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await exited; });
  const signal = await new Promise<{ phase: string; readyPath: string; sha256: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker did not commit ${phase}: ${stderr}`)), 30000);
    worker.once('message', value => { clearTimeout(timer); resolve(value as { phase: string; readyPath: string; sha256: string }); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited before ${phase}: ${stderr}`)); });
  });
  assert.equal(signal.phase, phase);
  const serialized = readFileSync(signal.readyPath, 'utf8'); assert.equal(hash(serialized), signal.sha256);
  const ready = JSON.parse(serialized) as ChildStorageCrashReady;
  const evidencePrefix = process.env.MOODCODE_CHILD_CRASH_EVIDENCE_PREFIX;
  if (evidencePrefix) writeFileSync(`${evidencePrefix}-${phase}.json`, serialized, { mode: 0o600 });
  t.diagnostic(`${phase} committed evidence SHA256=${signal.sha256}`);
  return { worker, ready, exited };
}
function assertCapturedPhase(ready: ChildStorageCrashReady, observed: ProviderCall[]) {
  const early = ['root-prepared', 'child-run-admitted', 'root-admitted'].includes(ready.phase);
  assert.equal(observed.filter(value => value.purpose === 'historical').length, 1);
  assert.equal(observed.filter(value => value.purpose === 'parent').length, 1);
  assert.equal(observed.filter(value => value.purpose === 'child').length, early ? 0 : 1);
  assert.equal(ready.root.provider_recovery_acknowledgments.length, 1, 'Preservation uses a genuine pre-existing host ACK');
  assert.deepEqual(ready.child.provider_recovery_acknowledgments, []);
  assert.deepEqual(ready.child.summary_recovery_acknowledgments, []);
  const rootBinding = rowData<ChildStorageRecord>(document(ready.root, ready.sessionId, childStorageKind(ready.taskId))!);
  const mirror = document(ready.child, ready.childSessionId, 'engine.child_owner');
  if (ready.phase === 'root-prepared') {
    assert.equal(rootBinding.binding.phase, 'prepared'); assert.equal(mirror, undefined);
    assert.deepEqual(ready.child.runs, []); assert.equal(ready.childRunId, undefined);
  } else if (ready.phase === 'child-run-admitted') {
    assert.equal(rootBinding.binding.phase, 'prepared'); assert.ok(mirror);
    assert.equal(rowData<ChildStorageRecord>(mirror).binding.phase, 'prepared'); assert.equal(ready.child.runs.length, 1);
  } else if (ready.phase === 'root-admitted') {
    assert.equal(rootBinding.binding.phase, 'admitted'); assert.ok(mirror);
    assert.equal(rowData<ChildStorageRecord>(mirror).binding.phase, 'prepared');
  } else {
    assert.equal(rootBinding.binding.phase, 'admitted'); assert.ok(mirror);
    assert.equal(rowData<ChildStorageRecord>(mirror).sha256, rootBinding.sha256);
    assert.equal(rowData<ChildStorageRecord>(mirror).confirmedClose, undefined, 'Child mirror never owns the root close proof');
  }
  assert.equal(rootBinding.confirmedClose !== undefined, ['root-close-proof', 'task-outcome'].includes(ready.phase));
  assert.equal(ready.childClosed, ['root-close-proof', 'task-outcome'].includes(ready.phase));
  if (early) {
    assert.deepEqual(ready.child.provider_attempts, []); assert.deepEqual(ready.child.attempt_cleanup, []); assert.deepEqual(ready.child.attempt_usage, []);
  } else {
    const attempt = rowData<ProviderAttempt>(ready.child.provider_attempts[0]!), turn = rowData<TurnRecord>(ready.child.session_turns[0]!);
    const cleanup = rowData<AttemptCleanupRecord>(ready.child.attempt_cleanup[0]!);
    const invocation = observed.find(value => value.purpose === 'child')!;
    assert.equal(cleanup.attemptId, invocation.attemptId); assert.equal(cleanup.requestSha256, invocation.requestSha256); assert.equal(cleanup.requestBytes, invocation.requestBytes);
    assert.equal(cleanup.contextRevisionId, attempt.contextRevisionId); assert.ok(ready.child.context_revisions.some(row => row.id === cleanup.contextRevisionId));
    assert.ok(document(ready.child, ready.childSessionId, 'context.head'));
    assert.deepEqual(rowData<{ usage: unknown }>(ready.child.attempt_usage[0]!).usage, { inputTokens: 23, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 });
    const text = rowData<{ text: string; state: string }>(ready.child.message_parts.find(row => rowData(row).type === 'text')!);
    assert.equal(text.text, 'Authored durable child partial 🧩');
    if (ready.phase === 'partial-observed') {
      assert.equal(attempt.state, 'streaming'); assert.equal(turn.state, 'streaming'); assert.equal(cleanup.state, 'dispatched'); assert.equal(cleanup.cleanupConfirmed, null); assert.equal(text.state, 'open');
      assert.notEqual(ready.child.runs[0]!.state, 'completed');
    } else {
      assert.equal(ready.child.runs[0]!.state, 'completed'); assert.equal(attempt.state, 'completed'); assert.equal(turn.state, 'completed');
      assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.cleanupConfirmed, true); assert.equal(cleanup.method, 'iterator-next-done'); assert.equal(text.state, 'completed');
    }
  }
  const originalTask = task(ready.root, ready);
  if (ready.phase === 'task-outcome') {
    assert.equal(originalTask.state, 'completed'); assert.equal(originalTask.outcome?.state, 'completed');
    assert.deepEqual(originalTask.outcome?.usage, { turns: 1, toolCalls: 0, outputBytes: Buffer.byteLength('Authored durable child partial 🧩') });
  } else assert.equal(originalTask.outcome, undefined);
}

for (const phase of CHILD_STORAGE_CRASH_PHASES) test(`actual child storage SIGKILL at ${phase} preserves evidence without redispatch/backfill/ACK/owner release`, { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moodcode-child-crash-${phase}-`)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  const { worker, ready, exited } = await launch(t, directory, phase), originalCalls = calls(directory);
  assertCapturedPhase(ready, originalCalls);
  assert.throws(() => new SqliteStore(dbPath), code('DB_LOCKED'), 'Stopped worker retains the actual root owner lease');
  if (!ready.childClosed) assert.throws(() => new SqliteStore(ready.childDbPath), code('DB_LOCKED'), 'An unclosed child still owns its actual lease');
  worker.kill('SIGKILL'); await exited; assert.equal(worker.signalCode, 'SIGKILL');
  const originalChildFiles = tree(join(artifactDir, 'children', ready.taskId));
  assert.deepEqual(stoppedFixtureSnapshot(dbPath, join(directory, '.root-before-open')), ready.root);
  assert.deepEqual(stoppedFixtureSnapshot(ready.childDbPath, join(directory, '.child-before-open')), ready.child);
  assert.deepEqual(tree(join(artifactDir, 'children', ready.taskId)), originalChildFiles, 'Evidence reads touch only private copies');
  let unexpectedChildren = 0;
  const guard: ProviderAdapter = { id: 'child-storage-crash-fixture', async *streamTurn() {
    appendFileSync(join(directory, 'provider-calls.jsonl'), JSON.stringify({ purpose: 'UNEXPECTED' }) + '\n');
    yield { type: 'finish', reason: 'stop' };
  } };
  const engine = createEngine({ dbPath, artifactDir, providers: [guard], allowedToolNames: ['read_file'],
    configureChild: () => { unexpectedChildren++; throw new Error('Restart must not reopen a child engine'); },
    defaults: { providerId: guard.id, modelId: 'local-scripted', mode: 'build', limits: { ...DEFAULT_LIMITS, maxTurns: 8, maxToolCalls: 8, maxContextBytes: 262144, maxOutputBytes: 65536, maxDurationMs: 120000 },
      budgets: { providerRequestTimeoutMs: 90000, providerInactivityTimeoutMs: 90000, maxProviderAttempts: 2 } } });
  t.after(() => engine.close());
  await engine.waitForSession(ready.sessionId); await tick();
  assert.equal(engine.store.getRun(ready.parentRunId).state, 'interrupted');
  const reopened = fixtureSnapshot(fixtureDatabase(engine.store));
  // Active parent recovery may append its own audit and terminal state. Immutable
  // history, decision rows and both child phase documents cannot be rewritten.
  for (const table of ['provider_recovery_acknowledgments', 'summary_recovery_acknowledgments', 'context_revisions', 'messages', 'session_inputs'] as const) assert.deepEqual(reopened[table], ready.root[table], table);
  for (const table of ['events', 'session_events'] as const) assert.deepEqual(reopened[table].slice(0, ready.root[table].length), ready.root[table], `Original ${table} prefix`);
  for (const kind of [childStorageKind(ready.taskId), 'context.head', 'context.memory', 'context.active_memory', 'engine.child_tasks', 'engine.worktrees']) assert.deepEqual(document(reopened, ready.sessionId, kind), document(ready.root, ready.sessionId, kind), kind);
  const historicalAttempt = ready.root.provider_attempts.find(row => row.id === ready.historicalDecision.attemptId)!;
  const historicalRunId = String(historicalAttempt.run_id);
  for (const table of ['runs', 'provider_attempts', 'session_turns', 'attempt_cleanup', 'attempt_usage'] as const) {
    const matching = (snapshot: CrashSnapshot) => snapshot[table].filter(row => table === 'runs' ? row.id === historicalRunId : row.run_id === historicalRunId);
    assert.deepEqual(matching(reopened), matching(ready.root), `Historical ${table}`);
  }
  const selection = { sessionId: ready.sessionId, sourceRunId: ready.parentRunId, taskIds: [ready.taskId] };
  const beforeRetry = await engine.getChildDocumentStorageUsage(selection);
  assert.equal(beforeRetry.children[0]!.authorityStatus, phase === 'task-outcome' ? 'eligible' : 'active');
  const recovered = await engine.startChildTask(ready.request);
  assert.equal(recovered.id, ready.taskId); assert.equal(recovered.childRunId, task(ready.root, ready).childRunId);
  assert.equal(recovered.state, phase === 'task-outcome' ? 'completed' : 'uncertain');
  assert.deepEqual(recovered.outcome, task(ready.root, ready).outcome);
  if (phase !== 'task-outcome') assert.equal(recovered.errorCode, 'CHILD_OWNER_UNAVAILABLE');
  await assert.rejects(engine.startChildTask({ ...ready.request, prompt: ready.request.prompt + ' changed' }), code('CHILD_REQUEST_CONFLICT'));
  assert.equal(engine.children.tasks.list(ready.sessionId).length, 1);
  assert.equal(engine.children.worktrees.get(ready.sessionId, ready.worktreeId).ownerId, ready.taskId);
  assert.throws(() => engine.children.worktrees.claimOwnership(ready.sessionId, ready.worktreeId, 'other-fixture-owner'), code('WORKTREE_BUSY'));
  await assert.rejects(engine.children.worktrees.cleanup(ready.sessionId, ready.worktreeId, new AbortController().signal), code('WORKTREE_BUSY'), 'The recorded worktree owner blocks cleanup independently of the parent workspace quarantine');
  await assert.rejects(engine.cleanupWorktree(ready.sessionId, ready.worktreeId), error => error instanceof EngineError && ['WORKTREE_BUSY', 'CLEANUP_PENDING'].includes(error.code));
  const afterRetry = await engine.getChildDocumentStorageUsage(selection);
  if (phase === 'task-outcome') {
    assert.equal(afterRetry.complete, true, JSON.stringify(afterRetry)); assert.equal(afterRetry.stats.openedChildren, 1);
    assert.equal(afterRetry.coverage.cleanup, 'not-performed'); assert.equal(afterRetry.coverage.executionAuthority, 'not-granted');
    assert.equal(afterRetry.declaredReferenceBytes.children, Buffer.byteLength('%PDF-1.7\nAuthored child crash document bytes.\n'));
  } else {
    assert.equal(afterRetry.complete, false); assert.equal(afterRetry.children[0]!.authorityStatus, 'unconfirmed');
    assert.equal(afterRetry.stats.openedChildren, 0); assert.equal(afterRetry.stats.rawMirrorBytes, 0);
    assert.notEqual(afterRetry.children[0]!.authorityStatus, 'legacy');
  }
  const exactDecision = await engine.acknowledgeProviderRecovery(ready.historicalDecision);
  assert.equal(exactDecision.duplicate, true); assert.equal(exactDecision.providerRetried, false);
  const afterOperations = fixtureSnapshot(fixtureDatabase(engine.store));
  assert.deepEqual(afterOperations.provider_recovery_acknowledgments, ready.root.provider_recovery_acknowledgments);
  for (const kind of [childStorageKind(ready.taskId), 'engine.worktrees', 'context.head', 'context.memory', 'context.active_memory']) assert.deepEqual(document(afterOperations, ready.sessionId, kind), document(ready.root, ready.sessionId, kind), `No implicit repair of ${kind}`);
  const pools = (snapshot: CrashSnapshot) => rowData<{ pools: unknown }>(document(snapshot, ready.sessionId, 'engine.child_tasks')!).pools;
  assert.deepEqual(pools(afterOperations), pools(ready.root), 'Recovery never refunds or re-reserves child allocations');
  assert.deepEqual(calls(directory), originalCalls); assert.equal(unexpectedChildren, 0);
  assert.deepEqual(stoppedFixtureSnapshot(ready.childDbPath, join(directory, '.child-after-retry')), ready.child, 'Exact retry does not recover/backfill the separate child database');
  assert.deepEqual(tree(join(artifactDir, 'children', ready.taskId)), originalChildFiles);
  await engine.close();
  const archivePath = join(directory, 'archive');
  if (phase !== 'task-outcome') {
    await assert.rejects(exportEngineArchive({ dbPath, artifactDir, destination: archivePath }), code('ARCHIVE_CHILD_INVALID'));
    assert.equal(existsSync(archivePath), false);
  } else {
    const archive = await exportEngineArchive({ dbPath, artifactDir, destination: archivePath });
    assert.equal(archive.manifest.documentAudit?.coverage, 'complete'); assert.equal(archive.manifest.documentAudit?.children[0]?.taskId, ready.taskId);
    assert.deepEqual(validateEngineArchive({ directory: archivePath }).manifest, archive.manifest);
    const imported = await importEngineArchive({ directory: archivePath, destination: join(directory, 'imported') });
    assert.equal(imported.executionResumed, false); assert.equal(imported.childSessionsPaused, 1); assert.equal(imported.documentAuditCoverage, 'complete');
    const restoredRoot = stoppedFixtureSnapshot(imported.dbPath, join(directory, '.imported-root-proof'));
    assert.deepEqual(restoredRoot.provider_recovery_acknowledgments, ready.root.provider_recovery_acknowledgments);
    const restoredChild = stoppedFixtureSnapshot(join(imported.artifactDir, 'children', ready.taskId, 'engine.sqlite'), join(directory, '.imported-child-proof'));
    for (const table of ['runs', 'session_turns', 'provider_attempts', 'attempt_cleanup', 'attempt_usage', 'message_parts', 'context_revisions', 'summary_attempts', 'summary_usage', 'provider_recovery_acknowledgments', 'summary_recovery_acknowledgments'] as const) assert.deepEqual(restoredChild[table], ready.child[table], table);
    assert.deepEqual(document(restoredChild, ready.childSessionId, 'engine.child_owner'), document(ready.child, ready.childSessionId, 'engine.child_owner'));
    await assert.rejects(exportEngineArchive({ dbPath: imported.dbPath, artifactDir: imported.artifactDir, destination: join(directory, 'historical-reexport') }), code('ARCHIVE_CHILD_INVALID'));
  }
  assert.deepEqual(calls(directory), originalCalls);
  assert.deepEqual(tree(join(artifactDir, 'children', ready.taskId)), originalChildFiles);
  assert.equal(readdirSync(directory).some(name => name.startsWith('.moodcode-archive-')), false);
  t.diagnostic(`${phase}: before/after provider counts ${originalCalls.length}/${calls(directory).length}; historical ACK rows 1; child DB/files unchanged`);
});
