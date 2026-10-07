import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter } from '../../ports.js';
import type { KnowledgePublicationRecord } from '../publication-types.js';

/** Observe the real primary SQL COMMIT. This worker never writes native rows itself. */
const [directoryArgument, phaseArgument, operationArgument] = process.argv.slice(2);
if (!directoryArgument || !['prepared', 'before-commit', 'after-commit'].includes(phaseArgument!) || !['publish', 'revoke'].includes(operationArgument!))
  throw new Error('Invalid publication crash boundary');
const directory = directoryArgument, phase = phaseArgument!, operation = operationArgument!;
const config = JSON.parse(readFileSync(join(directory, 'publication-crash-config.json'), 'utf8')) as {
  workspaceId: string; candidateId: string; originalPublicationId: string | null; requestId: string;
};
const provider: ProviderAdapter = { id: 'publication-crash-fixture',
  async *streamTurn() { appendFileSync(join(directory, 'unexpected-provider.log'), 'coding\n'); throw new Error('Publication cannot dispatch a coding producer'); },
  streamGeneration() { appendFileSync(join(directory, 'unexpected-provider.log'), 'generation\n'); throw new Error('Publication cannot replay generation'); },
};
const dbPath = join(directory, 'engine.sqlite');
const engine = createEngine({ dbPath, artifactDir: join(directory, 'artifacts'), providers: [provider], knowledgeGeneration: true, knowledgePublication: true,
  defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxTurns: 3, maxDurationMs: 10000 } } });
const db = Reflect.get(engine.store, 'db') as DatabaseSync;
assert.ok(db instanceof DatabaseSync, 'Crash instrumentation must observe the actual primary engine connection');
const originalExec = db.exec.bind(db);
function requestRecord(connection: DatabaseSync): KnowledgePublicationRecord | null {
  const row = connection.prepare('SELECT data FROM knowledge_publications WHERE workspace_id=? AND request_id=?').get(config.workspaceId, config.requestId);
  return row ? JSON.parse(String(row.data)) as KnowledgePublicationRecord : null;
}
function snapshot(connection: DatabaseSync) {
  return Object.fromEntries(['knowledge_publications', 'workspace_document_revisions', 'workspace_document_heads', 'knowledge_publication_receipts'].map(table =>
    [table, connection.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)))]));
}
let stopped = false;
function stop(record: KnowledgePublicationRecord): never {
  assert.equal(stopped, false); stopped = true;
  const committedDb = new DatabaseSync(dbPath, { readOnly: true });
  let committed: ReturnType<typeof snapshot>;
  try { committed = snapshot(committedDb); } finally { committedDb.close(); }
  const readyPath = join(directory, 'publication-crash-ready.json');
  writeFileSync(`${readyPath}.tmp`, JSON.stringify({ phase, operation, record, insideTransaction: db.isTransaction, frame: snapshot(db), committed }), { mode: 0o600 });
  renameSync(`${readyPath}.tmp`, readyPath);
  process.kill(process.pid, 'SIGSTOP');
  throw new Error('Parent must SIGKILL the stopped worker');
}
db.exec = function instrumentActualCommit(sql: string): void {
  const commit = sql.trim().toUpperCase() === 'COMMIT';
  if (commit && phase === 'before-commit') {
    const record = requestRecord(db);
    if (record?.state === 'completed') {
      assert.equal(db.isTransaction, true);
      assert.ok(db.prepare('SELECT id FROM knowledge_publication_receipts WHERE workspace_id=? AND request_id=?').get(config.workspaceId, config.requestId));
      assert.ok(db.prepare('SELECT id FROM workspace_document_revisions WHERE workspace_id=? AND publication_id=?').get(config.workspaceId, record.id));
      stop(record);
    }
  }
  originalExec(sql);
  if (commit) {
    const record = requestRecord(db);
    if (record && (phase === 'prepared' && record.state === 'prepared' || phase === 'after-commit' && record.state === 'completed')) {
      assert.equal(db.isTransaction, false); stop(record);
    }
  }
};
const preview = operation === 'publish'
  ? engine.previewWorkspaceKnowledgePublication({ workspaceId: config.workspaceId, candidateId: config.candidateId })
  : engine.previewWorkspaceKnowledgeRevocation({ workspaceId: config.workspaceId, publicationId: config.originalPublicationId! });
const decision = { workspaceId: config.workspaceId, requestId: config.requestId, approved: true as const, preview };
if (operation === 'publish') await engine.publishWorkspaceKnowledge(decision);
else await engine.revokeWorkspaceKnowledge(decision);
throw new Error(`Original SQL did not reach ${operation}/${phase}`);
