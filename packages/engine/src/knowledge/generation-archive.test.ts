import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { JsonObject, Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';
import { DB_VERSION } from '../storage/migrations.js';
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from '../storage/archive.js';

async function fixture(t: TestContext, uncertain = false) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), 'moodcode-generation-archive-')),
    ),
    root = join(base, 'repo'),
    dbPath = join(base, 'engine.sqlite'),
    artifactDir = join(base, 'artifacts');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Use reviewed project guidance.\n');
  writeFileSync(join(root, 'source.ts'), 'export const observed = 1;\n');
  let calls = 0,
    coding = 0;
  const provider: ProviderAdapter = {
    id: 'archive-generation',
    async *streamTurn() {
      coding++;
      throw new Error('Generation has no coding owner');
    },
    streamGeneration() {
      calls++;
      if (!uncertain)
        return (async function* () {
          yield {
            type: 'text.delta',
            delta: 'Historical pending project note.\n',
          } as const;
          yield { type: 'usage', inputTokens: 11, outputTokens: 4 } as const;
          yield { type: 'finish', reason: 'stop' } as const;
        })();
      let next = 0;
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (next++ === 0)
            return {
              done: false,
              value: {
                type: 'text.delta',
                delta: 'Actual bounded partial output.',
              },
            };
          if (next === 2)
            return {
              done: false,
              value: { type: 'usage', inputTokens: 9, outputTokens: 2 },
            };
          throw new Error('Producer failed after real output');
        },
        async return() {
          return {
            done: false,
            value: { type: 'text.delta', delta: 'Still active' },
          };
        },
      };
      return iterator;
    },
  };
  const engine = createEngine({
      dbPath,
      artifactDir,
      providers: [provider],
      knowledgeGeneration: true,
    }),
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  });
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: 'workspace.open',
    payload: { path: root } as JsonObject,
  });
  assert.equal(response.ok, true);
  const workspace = response.result as unknown as Workspace;
  const trust = await engine.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: 'allow',
    expectedRevision: 0,
    decision: 'allow',
    preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']),
  });
  const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [
    { kind: 'file', path: 'source.ts' },
  ]);
  const built = engine.previewWorkspaceKnowledgeGeneration({
    providerId: provider.id,
    modelId: 'fixture',
    projection,
  });
  const plan = await engine.prepareWorkspaceKnowledgeGeneration({
    workspaceId: workspace.id,
    requestId: 'plan',
    expectedTrustRevision: trust.revision,
    projection,
    target: engine.captureWorkspaceKnowledgeTarget(workspace.id, 'MEMORY.md'),
    providerId: provider.id,
    modelId: 'fixture',
    requestSha256: built.requestSha256,
    requestBytes: built.requestBytes,
    maxOutputBytes: 1024,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const generated = await engine.generateWorkspaceKnowledge({
    workspaceId: workspace.id,
    planId: plan.id,
    requestId: 'generation',
    projection,
  });
  await engine.close();
  return {
    base,
    root,
    dbPath,
    artifactDir,
    workspace,
    trust,
    plan,
    generated,
    engines,
    provider,
    calls: () => calls,
    coding: () => coding,
  };
}

test('DB11 archive preserves actual native generation output/usage/candidate and imports as paused historical evidence', async (t) => {
  const f = await fixture(t);
  assert.equal(f.generated.generation.state, 'completed');
  assert.ok(f.generated.candidate);
  const archived = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, 'archive'),
  });
  assert.equal(
    archived.manifest.databases.find((item) => item.role === 'primary')!
      .schemaVersion,
    DB_VERSION,
  );
  validateEngineArchive({ directory: archived.directory });
  const imported = await importEngineArchive({
    directory: archived.directory,
    destination: join(f.base, 'imported'),
  });
  const engine = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [f.provider],
    knowledgeGeneration: true,
  });
  f.engines.add(engine);
  const restored = engine.getWorkspaceKnowledgeGeneration(
    f.workspace.id,
    f.generated.generation.id,
  );
  assert.equal(restored.generation.sha256, f.generated.generation.sha256);
  assert.equal(restored.attempt!.sha256, f.generated.attempt!.sha256);
  assert.equal(restored.candidate!.sha256, f.generated.candidate!.sha256);
  assert.deepEqual(restored.attempt!.usage, {
    inputTokens: 11,
    outputTokens: 4,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
  assert.equal(
    engine.workspaceKnowledge.getTrust(f.workspace.id)!.sha256,
    f.trust.sha256,
  );
  assert.equal(
    engine.workspaceKnowledge.getGenerationPlan(f.workspace.id, f.plan.id)!
      .sha256,
    f.plan.sha256,
  );
  assert.equal(
    engine.workspaceKnowledge.getImportPause(f.workspace.id)!.state,
    'paused',
  );
  assert.throws(() =>
    engine.workspaceKnowledge.attachGenerationOwner(
      f.workspace.id,
      f.plan.id,
      restored.generation.id,
    ),
  );
  assert.equal(imported.executionResumed, false);
  assert.equal(f.calls(), 1);
  assert.equal(f.coding(), 0);
  assert.equal(existsSync(join(f.root, 'MEMORY.md')), false);
});

test('uncertain actual host stream survives archive with exact partial output and nullable usage without cleanup or authority rebinding', async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.generated.generation.state, 'uncertain');
  assert.equal(f.generated.candidate, null);
  const archived = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, 'archive-uncertain'),
  });
  const imported = await importEngineArchive({
    directory: archived.directory,
    destination: join(f.base, 'imported-uncertain'),
  });
  const engine = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [f.provider],
  });
  f.engines.add(engine);
  const restored = engine.getWorkspaceKnowledgeGeneration(
    f.workspace.id,
    f.generated.generation.id,
  );
  assert.equal(restored.generation.sha256, f.generated.generation.sha256);
  assert.equal(restored.attempt!.sha256, f.generated.attempt!.sha256);
  assert.equal(restored.attempt!.output, 'Actual bounded partial output.');
  assert.equal(restored.attempt!.cleanup!.confirmed, false);
  assert.equal(restored.executionBlocked, true);
  assert.deepEqual(restored.attempt!.usage, {
    inputTokens: 9,
    outputTokens: 2,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
  assert.equal(
    engine.store.hasUncertainKnowledgeGeneration(f.workspace.id),
    true,
  );
  assert.equal(f.calls(), 1);
  assert.equal(f.coding(), 0);
  assert.equal(
    engine.workspaceKnowledge.getImportPause(f.workspace.id)!.state,
    'paused',
  );
  assert.equal(restored.candidate, null);
});

test('archive refuses a bounded native row whose output was changed without its actual hash', async (t) => {
  const f = await fixture(t),
    db = new DatabaseSync(f.dbPath);
  try {
    db.prepare(
      "UPDATE knowledge_generation_attempts SET data=json_set(data,'$.output',?) WHERE id=?",
    ).run('Altered archived producer output.', f.generated.attempt!.id);
  } finally {
    db.close();
  }
  await assert.rejects(
    exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, 'invalid-archive'),
    }),
    { code: 'ARCHIVE_KNOWLEDGE_INVALID' },
  );
  assert.equal(existsSync(join(f.base, 'invalid-archive')), false);
  assert.equal(f.calls(), 1);
  assert.equal(f.coding(), 0);
});
