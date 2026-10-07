import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexProvider, createEngine, DEFAULT_TOOL_DISCOVERY_POLICY, exportEngineArchive, getCodexAuthStatus, importEngineArchive, inspectArchivedChildDocumentStorage, SqliteStore, validateEngineArchive } from '@moodcode/engine';

// One real child text request in an authored temporary Git repository. The PDF
// is a host storage fixture, never a provider attachment or a model PDF test.
if (!process.argv.includes('--live')) throw new Error('Use --live for existing Codex account verification.');
const toolDiscovery = process.argv.includes('--tool-discovery');
const auth = await getCodexAuthStatus(); assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-child-document-live-')));
const repository = join(root, 'repo'), artifacts = join(root, 'artifacts'), database = join(root, 'engine.sqlite');
const pdf = Buffer.from('%PDF-1.7\nAuthored opaque child storage fixture bytes.\n', 'ascii');
const sha = value => createHash('sha256').update(value).digest('hex');
const transport = new CodexProvider({ timeoutMs: 90_000 });
let releaseParent, enterParent, childEngine, childDocument, childRequest, parentRunId, engine, realCalls = 0, naturalDone = false, phase = 'setup';
let snapshots = 0;
const originalSnapshot = SqliteStore.prototype.getSnapshot;
SqliteStore.prototype.getSnapshot = () => { snapshots++; throw new Error('Whole snapshots are outside this fixture.'); };
const parentRelease = new Promise(yes => { releaseParent = yes; }), parentEntered = new Promise(yes => { enterParent = yes; });
const report = {
  kind: 'managed-child-document-storage-live-text-regression',
  implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  timestamp: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  providerId: transport.id, modelId: auth.modelId,
  scope: { actualChildRequests: 1, actualRootRequests: 0, remotePdfRequests: 0, syntheticParent: true, hostImportedOpaquePdf: true,
    projectRecoveryAcknowledged: false, executionAutomaticallyResumed: false, rawHttpBodyHashed: false },
  actualRequests: [], passed: false, cleanupConfirmed: false,
  toolCatalogueMode: toolDiscovery ? 'discovery' : 'eager',
  toolDiscovery: { hostOptIn: toolDiscovery, childAdvertisedTools: 0, reservationVerified: false },
};
const provider = {
  id: transport.id, replayProtocol: transport.replayProtocol, inputModalities: transport.inputModalities,
  inputFileTypes: transport.inputFileTypes, retryableHttpStatuses: transport.retryableHttpStatuses,
  streamTurn(request, signal) {
    if (request.messages.some(message => message.role === 'user' && message.content === 'AUTHORED_PARENT_HOLDER')) return (async function* () {
      enterParent(); yield { type: 'progress' };
      let abort; const cancelled = new Promise(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
      try { await Promise.race([parentRelease, cancelled]); } finally { signal.removeEventListener('abort', abort); }
      yield { type: 'text.delta', delta: 'Authored parent fixture completed.' }; yield { type: 'finish', reason: 'stop' };
    })();
    let inner, initialize;
    const ready = () => initialize ??= (async () => {
      assert.equal(realCalls, 0); assert.ok(childEngine); assert.ok(request.sessionId);
      assert.ok(request.messages.every(message => !(message.documents?.length))); assert.equal(request.tools.length, 0);
      childDocument = await childEngine.importDocument(request.sessionId, pdf);
      childRequest = structuredClone(request); realCalls++;
      const observation = { attemptId: request.attemptId, logicalRequestSha256: sha(JSON.stringify(request)), logicalRequestBytes: Buffer.byteLength(JSON.stringify(request)), usage: null };
      report.actualRequests.push(observation); inner = transport.streamTurn(request, signal)[Symbol.asyncIterator]();
    })();
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        await ready(); const item = await inner.next();
        if (item.done === true) naturalDone = true;
        else if (item.value.type === 'usage') report.actualRequests[0].usage = { ...report.actualRequests[0].usage, ...item.value };
        return item;
      },
      async return() { if (initialize) await initialize.catch(() => {}); if (!inner) return { done: true, value: undefined }; assert.ok(inner.return); return inner.return(); },
    };
  },
};
try {
  const hooks = join(root, 'empty-hooks'), attributes = join(root, 'empty-attributes');
  await mkdir(hooks); await writeFile(attributes, '');
  await mkdir(repository); await writeFile(join(repository, 'fixture.txt'), 'Authored child storage verification.\n');
  execFileSync('git', ['init', '--template=', '-q', repository]);
  execFileSync('git', ['-C', repository, '-c', 'core.attributesFile=' + attributes, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  engine = createEngine({ dbPath: database, artifactDir: artifacts, providers: [provider], allowedToolNames: ['read_file'],
    ...(toolDiscovery ? { toolDiscoveryPolicy: DEFAULT_TOOL_DISCOVERY_POLICY } : {}),
    defaults: { providerId: provider.id, modelId: auth.modelId, mode: 'build',
      limits: { maxContextBytes: 262_144, maxOutputBytes: 49_152, maxDurationMs: 120_000, maxTurns: 2, maxToolCalls: 2 },
      budgets: { providerRequestTimeoutMs: 90_000, providerInactivityTimeoutMs: 90_000, maxProviderAttempts: 1, turnAllowance: 1 } },
    configureChild: child => { childEngine = child; } });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'parent-session', workspaceId: 'workspace', title: 'Authored live child fixture', createdAt });
  const worktree = await engine.createWorktree('parent-session', 'fixture-worktree');
  const parent = engine.scheduler.submitLegacy({ sessionId: 'parent-session', requestId: 'parent', prompt: 'AUTHORED_PARENT_HOLDER', config: engine.getCapabilities().defaults });
  parentRunId = parent.runId; await parentEntered; phase = 'child-text-request';
  const initial = await engine.startChildTask({ sessionId: 'parent-session', parentRunId, requestId: 'child', worktreeId: worktree.id,
    prompt: 'Do not use tools. Reply with exactly READY.', tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 8192, durationMs: 90_000 } });
  const task = await engine.children.tasks.wait('parent-session', initial.id);
  assert.equal(task.state, 'completed'); assert.match(task.outcome.content.trim(), /^READY[.!]?$/u);
  assert.equal(realCalls, 1); assert.equal(naturalDone, true); assert.ok(childDocument); assert.ok(childRequest.attemptId);
  phase = 'selected-storage-observation';
  const binding = engine.store.getSessionDocument('parent-session', 'child.storage.' + task.id).data;
  assert.equal(binding.binding.phase, 'admitted'); assert.equal(binding.confirmedClose.method, 'engine-close-resolved');
  assert.equal(binding.binding.child.sessionId, childRequest.sessionId); assert.equal(binding.binding.child.runId, task.childRunId);
  const storage = await engine.getChildDocumentStorageUsage({ sessionId: 'parent-session', sourceRunId: parentRunId, taskIds: [task.id] });
  assert.equal(storage.complete, true); assert.equal(storage.observedChildren, 1); assert.equal(storage.declaredReferenceBytes.children, pdf.length);
  assert.equal(storage.children[0].blobHashes, 'not-read'); assert.equal(snapshots, 0);
  const originalBlob = join(artifacts, 'children', task.id, 'artifacts', 'input-documents', childDocument.id + '.blob');
  assert.equal(sha(await readFile(originalBlob)), childDocument.sha256);
  releaseParent(); assert.equal((await engine.waitForRun(parentRunId)).state, 'completed'); await engine.close();
  phase = 'archive-and-import';
  const archive = await exportEngineArchive({ dbPath: database, artifactDir: artifacts, destination: join(root, 'archive') });
  assert.equal(archive.manifest.documentAudit.coverage, 'complete'); assert.equal(archive.manifest.documentAudit.children.length, 1);
  validateEngineArchive({ directory: archive.directory });
  phase = 'historical-child-document-inspection';
  const inspection = await inspectArchivedChildDocumentStorage({ directory: archive.directory, expectedManifestSha256: archive.manifestSha256,
    sessionId: 'parent-session', sourceRunId: parentRunId, taskIds: [task.id] });
  assert.equal(inspection.scope, 'verified-archive-historical'); assert.equal(inspection.manifestSha256, archive.manifestSha256);
  assert.equal(inspection.complete, true); assert.equal(inspection.archiveCoverage, 'complete'); assert.equal(inspection.observedChildren, 1);
  assert.equal(inspection.declaredReferenceBytes.children, pdf.length); assert.deepEqual(inspection.children[0].documents, [childDocument]);
  assert.equal(inspection.physicalRebinding, false); assert.equal(inspection.executionResumed, false); assert.equal(inspection.recoveryAcknowledgmentsRebound, false);
  assert.equal(inspection.statsScope, 'whole-archive-proof-frame'); assert.equal(snapshots, 0); assert.equal(realCalls, 1);
  report.historicalInspection = { complete: inspection.complete, archiveCoverage: inspection.archiveCoverage, observedChildren: inspection.observedChildren,
    declaredChildBytes: inspection.declaredReferenceBytes.children, documents: inspection.children[0].documents, stats: inspection.stats, statsScope: inspection.statsScope,
    manifestSha256: inspection.manifestSha256, physicalRebinding: inspection.physicalRebinding, executionResumed: inspection.executionResumed,
    recoveryAcknowledgmentsRebound: inspection.recoveryAcknowledgmentsRebound };
  phase = 'archive-and-import';
  const child = archive.manifest.documentAudit.children[0];
  const reader = new DatabaseSync(join(archive.directory, 'data', child.database.file), { readOnly: true });
  try {
    const cleanup = JSON.parse(reader.prepare('SELECT data FROM attempt_cleanup WHERE attempt_id=?').get(childRequest.attemptId).data);
    assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-next-done');
    assert.equal(cleanup.requestSha256, report.actualRequests[0].logicalRequestSha256);
    assert.equal(cleanup.requestBytes, report.actualRequests[0].logicalRequestBytes);
    report.cleanupProof = { state: cleanup.state, method: cleanup.method, reason: cleanup.reason };
    {
      const rows = reader.prepare("SELECT data FROM events WHERE run_id=? AND type='context.prepared'").all(task.childRunId);
      assert.equal(rows.length, 1);
      const prepared = JSON.parse(rows[0].data).payload;
      assert.deepEqual(prepared.advertisedToolNames, []);
      assert.equal(prepared.toolCatalogueSha256, sha(JSON.stringify(childRequest.tools)));
      assert.equal(prepared.reservedToolBytes, Buffer.byteLength(JSON.stringify({ messages: [], tools: childRequest.tools })) - 2);
      report.toolDiscovery.reservationVerified = true;
      report.toolDiscovery.reservedToolBytes = prepared.reservedToolBytes;
      report.toolDiscovery.toolCatalogueSha256 = prepared.toolCatalogueSha256;
    }
  } finally { reader.close(); }
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(root, 'imported') });
  assert.equal(imported.childSessionsPaused, 1); assert.equal(imported.documentAuditCoverage, 'complete'); assert.equal(imported.executionResumed, false);
  assert.equal(sha(await readFile(originalBlob)), childDocument.sha256); assert.equal(realCalls, 1);
  await assert.rejects(exportEngineArchive({ dbPath: imported.dbPath, artifactDir: imported.artifactDir, destination: join(root, 'unsupported-reexport') }), error => error?.code === 'ARCHIVE_CHILD_INVALID');
  report.storage = { complete: storage.complete, observedChildren: storage.observedChildren, declaredChildBytes: storage.declaredReferenceBytes.children, stats: storage.stats, blobHashesVerifiedByDiagnostic: false };
  report.archive = { documentAuditCoverage: archive.manifest.documentAudit.coverage, verifiedChildDatabases: 1, childSessionsPaused: imported.childSessionsPaused, restoredPhysicalAuthorityGranted: false, restoredTypedChildReexportRejected: true };
  report.fullSnapshotReads = snapshots; report.actualRequestCount = realCalls; report.cleanupConfirmed = true; report.passed = true;
} catch (error) {
  report.failure = { phase, code: typeof error?.code === 'string' ? error.code : 'CHILD_DOCUMENT_LIVE_FAILED' }; process.exitCode = 1;
} finally {
  releaseParent();
  try { await engine?.close(); } catch { report.passed = false; report.cleanupConfirmed = false; report.failure = { phase: 'host-close', code: 'HOST_CLOSE_FAILED' }; process.exitCode = 1; }
  SqliteStore.prototype.getSnapshot = originalSnapshot;
  if (report.passed && report.cleanupConfirmed) { await rm(root, { recursive: true, force: true }); report.fixtureRemoved = true; }
  else { report.fixtureRemoved = false; report.retainedFixture = root; }
  console.log(JSON.stringify(report, null, 2));
}
