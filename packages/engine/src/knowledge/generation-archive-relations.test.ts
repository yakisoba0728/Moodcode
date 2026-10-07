import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { validateKnowledgeGenerationDatabase } from './generation-archive-relations.js';
import { validateKnowledgeGenerationArchiveRow } from './generation-store.js';
import { knowledgeHash, sha256 } from './validation.js';

const relationError = (error: unknown) => error instanceof EngineError && error.code === 'KNOWLEDGE_GENERATION_RELATION_INVALID';
function rehash<T extends { sha256: string }>(value: T): T {
  const { sha256: _old, ...body } = value;
  return { ...body, sha256: knowledgeHash(body) } as T;
}
function corrupt<T extends { id: string; sha256: string }>(db: DatabaseSync, table: string, value: T): T {
  const tampered = rehash(value);
  db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(tampered), tampered.id);
  return tampered;
}
async function fixture(t: TestContext, partial = false, generations = 1, failMarker = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-generation-relations-'))), root = join(base, 'repository');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Host approved instructions.\n'); writeFileSync(join(root, 'source.ts'), 'export const selected = 1;\n');
  const dbPath = join(base, 'engine.sqlite'); let calls = 0, coding = 0;
  const provider: ProviderAdapter = {
    id: 'actual-generation-relations',
    async *streamTurn() { coding++; throw new Error('No coding owner is permitted'); },
    async *streamGeneration() {
      calls++;
      yield { type: 'text.delta', delta: `Actual native output ${calls}.\n` };
      yield { type: 'usage', inputTokens: 13, ...(partial ? {} : { outputTokens: 5 }) };
      yield { type: 'progress', providerRequestId: `actual-request-${calls}` };
      if (partial) throw new Error('Actual producer failure after nullable usage');
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const engine = createEngine({ dbPath, artifactDir: join(base, 'artifacts'), providers: [provider], knowledgeGeneration: true });
  if (failMarker) {
    const fault = new DatabaseSync(dbPath);
    try { fault.exec(`CREATE TRIGGER reject_candidate_marker BEFORE UPDATE ON knowledge_generations
      WHEN json_extract(NEW.data,'$.candidate.state')='recorded' BEGIN SELECT RAISE(ABORT,'Actual candidate marker write failure'); END;`); }
    finally { fault.close(); }
  }
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: root } });
  assert.equal(response.ok, true); const workspace = response.result as unknown as Workspace;
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'allow', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }]);
  const built = engine.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const results = [];
  for (let index = 0; index < generations; index++) {
    const plan = await engine.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: `plan-${index}`, expectedTrustRevision: trust.revision, projection,
      target: engine.captureWorkspaceKnowledgeTarget(workspace.id, `MEMORY-${index}.md`), providerId: provider.id, modelId: 'fixture-model', requestSha256: built.requestSha256, requestBytes: built.requestBytes,
      maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    results.push(await engine.generateWorkspaceKnowledge({ workspaceId: workspace.id, planId: plan.id, requestId: `generation-${index}`, projection }));
  }
  await engine.close();
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  return { db, results, calls: () => calls, coding: () => coding };
}

test('actual completed native owner, exact candidate and nullable usage satisfy historical relationships without coding owners', async t => {
  const f = await fixture(t), result = f.results[0]!; let checks = 0;
  assert.equal(result.generation.state, 'completed'); assert.equal(result.generation.candidate.state, 'recorded');
  assert.equal(result.candidate!.generationOwnerId, result.generation.id); assert.equal(result.attempt!.cleanup!.confirmed, true);
  assert.equal(result.attempt!.usage.cachedInputTokens, null); assert.equal(result.attempt!.usage.reasoningTokens, null);
  const before = f.db.prepare('SELECT data FROM knowledge_generations').get()!.data;
  validateKnowledgeGenerationDatabase(f.db, () => { checks++; }); assert.ok(checks > 10);
  assert.equal(f.db.prepare('SELECT data FROM knowledge_generations').get()!.data, before);
  assert.equal(f.calls(), 1); assert.equal(f.coding(), 0);
  for (const table of ['sessions', 'runs', 'native_runs', 'provider_attempts']) {
    if (f.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table))
      assert.equal(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, 0);
  }
});

test('actual failed native partial output preserves unknown usage and confirmed cleanup without candidate authority', async t => {
  const f = await fixture(t, true), result = f.results[0]!;
  assert.equal(result.generation.state, 'failed'); assert.equal(result.candidate, null);
  assert.equal(result.attempt!.usage.inputTokens, 13); assert.equal(result.attempt!.usage.outputTokens, null);
  assert.equal(result.attempt!.output, 'Actual native output 1.\n'); assert.equal(result.attempt!.cleanup!.confirmed, true);
  validateKnowledgeGenerationDatabase(f.db, () => {});
});

test('actual candidate append followed by a marker transaction failure preserves a valid unpromoted crash-gap relation', async t => {
  const f = await fixture(t, false, 1, true), result = f.results[0]!;
  assert.equal(result.generation.state, 'completed'); assert.equal(result.generation.candidate.state, 'withheld');
  const actual = f.db.prepare('SELECT generation_owner_id,data FROM knowledge_candidates').get()!;
  assert.equal(actual.generation_owner_id, result.generation.id);
  assert.equal((JSON.parse(actual.data as string) as { body: string }).body, result.attempt!.output);
  validateKnowledgeGenerationDatabase(f.db, () => {});
  assert.equal(f.calls(), 1); assert.equal(f.coding(), 0);
  assert.equal(f.db.prepare('SELECT data FROM knowledge_generations').get()!.data, JSON.stringify(result.generation));
});

test('host deadline/cancel check interrupts validation without mutating original producer records', async t => {
  const f = await fixture(t), stop = new Error('Host validation deadline'); let checks = 0;
  const original = f.db.prepare('SELECT data FROM knowledge_generations').get()!.data;
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => { if (++checks === 4) throw stop; }), error => error === stop);
  assert.equal(f.db.prepare('SELECT data FROM knowledge_generations').get()!.data, original);
});

test('different individually valid native candidate ID cannot replace the actual owned candidate', async t => {
  const f = await fixture(t, false, 2), first = f.results[0]!, second = f.results[1]!;
  validateKnowledgeGenerationDatabase(f.db, () => {}); assert.notEqual(first.candidate!.id, second.candidate!.id);
  const generation = corrupt(f.db, 'knowledge_generations', { ...first.generation, candidate: { state: 'recorded' as const, candidateId: second.candidate!.id, reason: null } });
  validateKnowledgeGenerationArchiveRow({ table: 'knowledge_generations', key: generation.id, workspaceId: generation.workspaceId, data: generation });
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('individually valid dispatched generation paired with a prepared attempt cannot erase durable intent', async t => {
  const f = await fixture(t), actual = f.results[0]!;
  f.db.prepare('DELETE FROM knowledge_candidates WHERE id=?').run(actual.candidate!.id);
  const generation = corrupt(f.db, 'knowledge_generations', { ...actual.generation, state: 'dispatched' as const, candidate: { state: 'pending' as const, candidateId: null, reason: null } });
  f.db.prepare('UPDATE knowledge_generations SET state=? WHERE id=?').run(generation.state, generation.id);
  const attempt = corrupt(f.db, 'knowledge_generation_attempts', { ...actual.attempt!, state: 'prepared' as const, dispatchedAt: null, output: '', outputSha256: sha256(''), outputBytes: 0, observedTextBytes: 0,
    outputTruncated: false, observationBytes: 0, events: 0, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null }, providerRequestId: null, finishReason: null, streamDone: false, cleanup: null });
  f.db.prepare('UPDATE knowledge_generation_attempts SET state=? WHERE id=?').run(attempt.state, attempt.id);
  for (const [table, data] of [['knowledge_generations', generation], ['knowledge_generation_attempts', attempt]] as const)
    validateKnowledgeGenerationArchiveRow({ table, key: data.id, workspaceId: data.workspaceId, data });
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('individually valid prepared pair cannot retain observations made before any dispatch intent', async t => {
  const f = await fixture(t), actual = f.results[0]!;
  f.db.prepare('DELETE FROM knowledge_candidates WHERE id=?').run(actual.candidate!.id);
  const generation = corrupt(f.db, 'knowledge_generations', { ...actual.generation, state: 'prepared' as const, candidate: { state: 'pending' as const, candidateId: null, reason: null } });
  const attempt = corrupt(f.db, 'knowledge_generation_attempts', { ...actual.attempt!, state: 'prepared' as const, dispatchedAt: null, finishReason: null, streamDone: false, cleanup: null });
  f.db.prepare('UPDATE knowledge_generations SET state=? WHERE id=?').run(generation.state, generation.id);
  f.db.prepare('UPDATE knowledge_generation_attempts SET state=? WHERE id=?').run(attempt.state, attempt.id);
  for (const [table, data] of [['knowledge_generations', generation], ['knowledge_generation_attempts', attempt]] as const)
    validateKnowledgeGenerationArchiveRow({ table, key: data.id, workspaceId: data.workspaceId, data });
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('actual SQL indexed revision/state/plan/scope must agree with validated native JSON', async t => {
  const f = await fixture(t), generation = f.results[0]!.generation;
  f.db.exec('PRAGMA foreign_keys=OFF');
  for (const [column, value] of [['revision', generation.revision + 1], ['state', 'prepared'], ['plan_id', 'different-plan'], ['workspace_id', 'different-workspace']] as const) {
    const original = f.db.prepare(`SELECT ${column} AS value FROM knowledge_generations WHERE id=?`).get(generation.id)!.value;
    assert.ok(typeof original === 'string' || typeof original === 'number');
    f.db.prepare(`UPDATE knowledge_generations SET ${column}=? WHERE id=?`).run(value, generation.id);
    assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), error => error instanceof EngineError);
    f.db.prepare(`UPDATE knowledge_generations SET ${column}=? WHERE id=?`).run(original, generation.id);
  }
  validateKnowledgeGenerationDatabase(f.db, () => {});
});

test('individually hashed native owner must match original plan logical request bytes/hash/provider/model/binding', async t => {
  const f = await fixture(t), original = f.results[0]!.generation;
  for (const patch of [{ planSha256: 'f'.repeat(64) }, { logicalRequestBytes: original.logicalRequestBytes + 1 }, { logicalRequestSha256: 'e'.repeat(64) },
    { providerId: 'other-provider' }, { modelId: 'other-model' }, { binding: { ...original.binding, rootInode: '999999' } }]) {
    const changed = corrupt(f.db, 'knowledge_generations', { ...original, ...patch });
    validateKnowledgeGenerationArchiveRow({ table: 'knowledge_generations', key: changed.id, workspaceId: changed.workspaceId, data: changed });
    assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
  }
  corrupt(f.db, 'knowledge_generations', original); validateKnowledgeGenerationDatabase(f.db, () => {});
});

test('completed native output cannot exceed original event/observation/output ceilings or acquire a different epoch', async t => {
  const f = await fixture(t), g = f.results[0]!.generation, original = f.results[0]!.attempt!;
  for (const patch of [{ events: g.budget.maxEvents + 1 }, { observationBytes: g.budget.maxObservationBytes + 1 }, { runtimeEpoch: 'different-owned-epoch' }]) {
    const changed = corrupt(f.db, 'knowledge_generation_attempts', { ...original, ...patch });
    validateKnowledgeGenerationArchiveRow({ table: 'knowledge_generation_attempts', key: changed.id, workspaceId: changed.workspaceId, data: changed });
    assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
  }
  corrupt(f.db, 'knowledge_generation_attempts', original);
  const changed = corrupt(f.db, 'knowledge_generations', { ...g, budget: { ...g.budget, maxOutputBytes: original.outputBytes - 1 }, budgetSha256: knowledgeHash({ ...g.budget, maxOutputBytes: original.outputBytes - 1 }) });
  // Recompute creation hash too, so the rejection proves original retained-budget relations.
  corrupt(f.db, 'knowledge_generations', { ...changed, createSha256: knowledgeHash({ workspaceId: changed.workspaceId, planId: changed.planId, requestId: changed.requestId, budget: changed.budget,
    logicalRequestSha256: changed.logicalRequestSha256, logicalRequestBytes: changed.logicalRequestBytes }) });
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('individually valid completed rows cannot move producer completion past the original deadline', async t => {
  const f = await fixture(t), g = f.results[0]!.generation, a = f.results[0]!.attempt!;
  const updatedAt = new Date(g.deadline + 1).toISOString();
  const changedGeneration = corrupt(f.db, 'knowledge_generations', { ...g, updatedAt });
  const changedAttempt = corrupt(f.db, 'knowledge_generation_attempts', { ...a, updatedAt });
  for (const [table, data] of [['knowledge_generations', changedGeneration], ['knowledge_generation_attempts', changedAttempt]] as const)
    validateKnowledgeGenerationArchiveRow({ table, key: data.id, workspaceId: data.workspaceId, data });
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('exact actual candidate body/usage/plan provenance cannot be replaced by independently valid observations', async t => {
  const f = await fixture(t), candidate = f.results[0]!.candidate!;
  for (const patch of [{ body: 'A different bounded observation.', bodySha256: sha256('A different bounded observation.') }, { usage: { ...candidate.usage, inputTokens: candidate.usage.inputTokens! + 1 } }, { requestSha256: 'd'.repeat(64) }]) {
    corrupt(f.db, 'knowledge_candidates', { ...candidate, ...patch });
    assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
  }
});

test('orphan attempt is rejected even when archive author disabled SQLite foreign keys', async t => {
  const f = await fixture(t), g = f.results[0]!.generation;
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.prepare('DELETE FROM knowledge_generations WHERE id=?').run(g.id);
  assert.throws(() => validateKnowledgeGenerationDatabase(f.db, () => {}), relationError);
});

test('row byte metadata rejects oversized stored JSON before any payload-select execution', async t => {
  const f = await fixture(t), g = f.results[0]!.generation;
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.prepare('UPDATE knowledge_generations SET data=? WHERE id=?').run(JSON.stringify({ ...g, oversized: 'x'.repeat(70_000) }), g.id);
  let payloadReads = 0;
  const observed = new Proxy(f.db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => { if (sql.startsWith('SELECT CASE')) payloadReads++; return target.prepare(sql); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => validateKnowledgeGenerationDatabase(observed, () => {}), relationError);
  assert.equal(payloadReads, 0);
});
