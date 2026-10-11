import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JsonObject, Session, Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { exportEngineArchive, importEngineArchive, validateEngineArchive } from '../storage/archive.js';
import { DB_VERSION } from '../storage/migrations.js';

function stored<T>(dbPath: string, read: (db: DatabaseSync) => T): T { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return read(db); } finally { db.close(); } }
async function fixture(t: test.TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-native-knowledge-'))), root = join(base, 'repo'), dbPath = join(base, 'engine.sqlite'), artifactDir = join(base, 'artifacts');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Use the project formatter.\n'); writeFileSync(join(root, 'a.ts'), 'const alpha = 1;\n');
  const engine = createEngine({ dbPath, artifactDir });
  t.after(async () => { await engine.close(); rmSync(base, { recursive: true, force: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: root }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  const preview = engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']);
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'allow-trust', expectedRevision: 0, decision: 'allow', preview });
  function prepare(requestId = 'pending-generation') {
    const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'a.ts' }]), target = engine.captureWorkspaceKnowledgeTarget(workspace.id, 'MOODCODE_MEMORY.md');
    const input = { workspaceId: workspace.id, requestId, projection, expectedTrustRevision: trust.revision, target, providerId: 'future-tools-free-provider', modelId: 'future-model', requestSha256: createHash('sha256').update(projection.body).digest('hex'), requestBytes: projection.bodyBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60000).toISOString() };
    return { projection, input, promise: engine.prepareWorkspaceKnowledgeGeneration(input) };
  }
  return { base, root, dbPath, artifactDir, engine, workspace, session, preview, trust, prepare };
}

test('actual engine stores trusted pending knowledge without manufacturing execution or publishing a candidate', async t => {
  const f = await fixture(t), prepared = f.prepare(), plan = await prepared.promise;
  assert.equal(f.engine.store.integrityCheck().schemaVersion, DB_VERSION); assert.equal(plan.state, 'pending'); assert.equal(plan.toolCount, 0); assert.equal(plan.source.sha256, prepared.projection.manifest.sha256);
  assert.equal(plan.target.kind, 'workspace-file'); assert.equal(f.engine.workspaceKnowledge.getGenerationPlan(f.workspace.id, plan.id)!.id, plan.id);
  assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 0); assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 0);
  assert.throws(() => f.engine.workspaceKnowledge.attachGenerationOwner(f.workspace.id, plan.id, 'invented-owner'));
  assert.equal(stored(f.dbPath, db => db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n), 0); assert.equal(existsSync(join(f.root, 'MOODCODE_MEMORY.md')), false);
  assert.throws(() => f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, 'a.ts'), { code: 'KNOWLEDGE_TARGET_REVISION_UNAVAILABLE' });
  f.engine.releaseWorkspaceKnowledgeSources(prepared.projection);
  await assert.rejects(f.engine.prepareWorkspaceKnowledgeGeneration({ ...prepared.input, requestId: 'released-source' }));
});

test('actual host rejects stale trust sources, forged projection, revoked trust and changed target preimage', async t => {
  const f = await fixture(t), first = f.prepare(); await first.promise;
  await assert.rejects(f.engine.prepareWorkspaceKnowledgeGeneration({ ...first.input, requestId: 'forged-projection', projection: { ...first.projection } }));
  writeFileSync(join(f.root, 'MOODCODE_MEMORY.md'), 'New actual target preimage.\n');
  await assert.rejects(f.engine.prepareWorkspaceKnowledgeGeneration({ ...first.input, requestId: 'changed-target' }));
  rmSync(join(f.root, 'MOODCODE_MEMORY.md'));
  const revoked = await f.engine.setWorkspaceTrust({ workspaceId: f.workspace.id, requestId: 'revoke-trust', expectedRevision: 1, decision: 'deny' }); assert.equal(revoked.revision, 2);
  await assert.rejects(f.engine.prepareWorkspaceKnowledgeGeneration({ ...first.input, requestId: 'revoked-trust' }), { code: 'WORKSPACE_UNTRUSTED' });
  writeFileSync(join(f.root, 'AGENTS.md'), 'Changed actual instruction guidance.\n');
  await assert.rejects(f.engine.setWorkspaceTrust({ workspaceId: f.workspace.id, requestId: 'stale-preview', expectedRevision: 2, decision: 'allow', preview: f.preview }));
  assert.equal(f.engine.workspaceKnowledge.getTrust(f.workspace.id)!.decision, 'deny');
});

test('current archive preserves trust/plans and pauses workspace knowledge after physical relocation', async t => {
  const f = await fixture(t), prepared = f.prepare(), plan = await prepared.promise, targetBefore = readFileSync(join(f.root, 'a.ts'), 'utf8');
  await f.engine.close();
  const archived = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.base, 'archive') });
  assert.equal(archived.manifest.databases.find(database => database.role === 'primary')!.schemaVersion, DB_VERSION);
  validateEngineArchive({ directory: archived.directory });
  const imported = await importEngineArchive({ directory: archived.directory, destination: join(f.base, 'imported') }), restored = createEngine({ dbPath: imported.dbPath, artifactDir: imported.artifactDir });
  try {
    assert.equal(imported.executionResumed, false); assert.equal(imported.sessionsPaused, 1);
    assert.equal(restored.workspaceKnowledge.getGenerationPlan(f.workspace.id, plan.id)!.sha256, plan.sha256);
    assert.equal(restored.workspaceKnowledge.getTrust(f.workspace.id)!.sha256, f.trust.sha256);
    assert.equal(restored.workspaceKnowledge.isImportPaused(f.workspace.id), true);
    const marker = JSON.parse(String(stored(imported.dbPath, db => db.prepare('SELECT data FROM knowledge_import_pauses WHERE id=?').get(f.workspace.id)!.data))); assert.equal(marker.state, 'paused'); assert.equal(marker.archiveSha256, archived.manifestSha256);
    assert.throws(() => restored.workspaceKnowledge.assertTrusted(f.workspace.id, 1), { code: 'KNOWLEDGE_IMPORT_PAUSED' });
    assert.equal(restored.store.getSnapshot(f.session.id).runs.length, 0); assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), targetBefore); assert.equal(existsSync(join(f.root, 'MOODCODE_MEMORY.md')), false);
  } finally { await restored.close(); }
});
