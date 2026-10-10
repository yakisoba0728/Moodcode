import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Message, type RunState } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { assertWorkspaceTrustSourcesCurrent, captureWorkspaceTrustSources } from '../workspace/trust.js';
import { KnowledgeHostAdapter, KNOWLEDGE_HOST_LIMITS, type KnowledgeHostAdapterPorts } from './host.js';
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL } from './store.js';
import { knowledgeHash, sha256, validateTarget } from './validation.js';
import type { KnowledgeHostBinding } from './types.js';

const stamp = '2026-10-07T03:00:00.000Z';
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
test('absent physical target preserves its positive native deletion revision and still rejects a changed head', t => {
  const f = fixture(t, { revision: 3 });
  const target = f.adapter.captureFileTarget('workspace', 'REVOKED.md');
  assert.deepEqual(target, { kind: 'workspace-file', path: 'REVOKED.md', revision: 3, sha256: null, device: null, inode: null });
  assert.deepEqual(validateTarget(target), target); f.adapter.assertTargetCurrent(f.binding(), target);
  f.counters.targetRevision = 4; assert.throws(() => f.adapter.assertTargetCurrent(f.binding(), target), hasCode('KNOWLEDGE_TARGET_CHANGED'));
  assert.throws(() => validateTarget({ kind: 'workspace-document', key: 'revoked', revision: 3, sha256: null }), hasCode('INVALID_KNOWLEDGE'));
});
function fixture(t: TestContext, options: { state?: RunState; content?: string; message?: Partial<Message>; revision?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-knowledge-host-'))), file = join(root, 'engine.sqlite'), store = new SqliteStore(file), otherRoot = join(root, 'other'); mkdirSync(otherRoot);
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp }); store.putWorkspace({ id: 'other', root: otherRoot, gitRoot: otherRoot, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Authored source; no native generation', createdAt: stamp }); store.createSession({ id: 'other-session', workspaceId: 'other', title: 'Foreign', createdAt: stamp });
  const run = store.admit({ sessionId: 'session', requestId: 'authored-source', prompt: 'Host-authored source only', config: { providerId: 'fixture', modelId: 'fixture-model', mode: 'build', limits: { ...DEFAULT_LIMITS } } });
  store.commit(run.runId, 'run.started', {}, { run: { state: 'running' } });
  const message: Message = { id: 'message', sessionId: 'session', runId: run.runId, role: 'assistant', content: options.content ?? 'Observed a completed authored change and check.', createdAt: stamp, ...options.message };
  store.commit(run.runId, 'message.completed', {}, { message });
  const runState = options.state ?? 'completed';
  if (['completed', 'failed', 'interrupted', 'cancelled'].includes(runState)) {
    if (runState === 'cancelled') store.commit(run.runId, 'run.cancelling', {}, { run: { state: 'cancelling' } });
    store.commit(run.runId, `run.${runState}`, {}, { run: { state: runState } });
  }
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON');
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='knowledge_candidates'").get()) db.exec(KNOWLEDGE_SCHEMA_SQL);
  writeFileSync(join(root, 'source.ts'), 'export const authored = true;\n'); writeFileSync(join(root, 'AGENTS.md'), 'Host-selected instruction source\n');
  const counters = { reads: 0, targetRevision: options.revision, bindingChanged: false, beforeVersion: undefined as (() => void) | undefined }, database = lstatSync(file, { bigint: true });
  function binding(workspaceId = 'workspace'): KnowledgeHostBinding { const selected = store.getWorkspace(workspaceId).root, metadata = lstatSync(selected, { bigint: true }); return { workspaceId, root: selected, rootDevice: metadata.dev.toString(), rootInode: metadata.ino.toString(), storageBindingSha256: sha256(counters.bindingChanged ? 'replacement-storage' : `${file}:${database.dev}:${database.ino}`) }; }
  const ports: KnowledgeHostAdapterPorts = { readTx: operation => { counters.reads++; db.exec('BEGIN'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, getWorkspace: id => store.getWorkspace(id), checkHostBinding: binding, ...(options.revision === undefined ? {} : { readFileTargetRevision: () => { counters.beforeVersion?.(); return counters.targetRevision!; } }) };
  const adapter = new KnowledgeHostAdapter(db, ports), selection = [{ kind: 'message' as const, sessionId: 'session', messageId: 'message' }, { kind: 'file' as const, path: 'source.ts' }];
  t.after(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); }); return { root, file, store, db, run, message, adapter, ports, binding, selection, counters };
}

test('actual SqliteStore completed messages and exact files produce immutable allowlisted source text/hash pins', t => {
  const f = fixture(t), before = f.store.readEvents('session', 0), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }), body = JSON.parse(projection.body) as Record<string, unknown>[];
  assert.equal(body.length, 2); assert.deepEqual(body[0], { kind: 'message', id: 'message', sessionId: 'session', runId: f.run.runId, role: 'assistant', content: f.message.content }); assert.deepEqual(body[1], { kind: 'file', path: 'source.ts', content: 'export const authored = true;\n' });
  assert.equal(projection.bodySha256, sha256(projection.body)); assert.equal(projection.bodyBytes, Buffer.byteLength(projection.body)); assert.equal(projection.manifest.sha256, projection.bodySha256); assert.equal(projection.manifest.pins[0]!.sha256, knowledgeHash(body[0])); assert.equal(projection.manifest.pins[1]!.sha256, sha256(String(body[1]!.content)));
  assert.ok(Object.isFrozen(projection) && Object.isFrozen(projection.binding) && Object.isFrozen(projection.manifest.pins[0])); f.adapter.assertProjectionFresh(projection); assert.deepEqual(f.store.readEvents('session', 0), before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0); f.adapter.releaseProjection(projection);
});

test('nullable selector Run expectations resolve to the actual completed message owner and cannot erase its pin', t => {
  const f = fixture(t), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'message', sessionId: 'session', messageId: 'message', runId: null }] });
  assert.equal((projection.manifest.pins[0]! as { runId: string }).runId, f.run.runId);
  const modified = { ...projection.manifest, pins: [{ ...projection.manifest.pins[0]!, runId: null }] }; assert.throws(() => f.adapter.assertSourcesCurrent(projection.binding, modified), hasCode('KNOWLEDGE_SOURCE_CHANGED'));
});

for (const state of ['running', 'failed', 'interrupted', 'cancelled'] as const) test(`actual ${state} source Run is excluded from completed-source capture`, t => {
  const f = fixture(t, { state }); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('KNOWLEDGE_SOURCE_UNSETTLED'));
});

test('workspace, session, expected Run and missing message selections cannot choose foreign source ownership', t => {
  const f = fixture(t), selector = f.selection[0]!;
  for (const selection of [[{ ...selector, sessionId: 'other-session' }], [{ ...selector, runId: 'foreign-run' }], [{ ...selector, messageId: 'missing' }]]) assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection }), hasCode('KNOWLEDGE_SOURCE_SCOPE_MISMATCH'));
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'other', selection: [selector] }), hasCode('KNOWLEDGE_SOURCE_SCOPE_MISMATCH'));
});

test('DB message owner columns and Run/session payload mismatches are rejected without loading unrelated fields', t => {
  const f = fixture(t); f.db.prepare("UPDATE messages SET data=json_set(data,'$.sessionId','foreign') WHERE id='message'").run();
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('KNOWLEDGE_SOURCE_SCOPE_MISMATCH'));
  f.db.prepare("UPDATE messages SET data=json_set(data,'$.sessionId','session') WHERE id='message'").run(); f.db.prepare("UPDATE runs SET data=json_set(data,'$.state','running') WHERE id=?").run(f.run.runId);
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('KNOWLEDGE_SOURCE_SCOPE_MISMATCH'));
});

test('source projection never selects opaque replay, schema inputs, config/credentials or auxiliary fields', t => {
  const f = fixture(t, { message: { providerReplay: { providerId: 'fixture', items: [{ token: 'opaque-token-do-not-project', raw: 'opaque-body' }] }, toolCalls: [{ id: 'tool', name: 'shell', input: { command: 'effect-metadata-do-not-project' } }] } });
  const projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] });
  for (const marker of ['opaque-token', 'opaque-body', 'effect-metadata', 'providerReplay', 'toolCalls', 'config', 'createdAt']) assert.equal(projection.body.includes(marker), false);
  assert.equal(projection.body.includes(f.message.content), true);
});

for (const field of ['attachments', 'documents'] as const) test(`actual ${field} source is explicitly unsupported by text-only projection`, t => {
  const f = fixture(t); f.db.prepare(`UPDATE messages SET data=json_set(data,'$.${field}',json('[{"id":"media"}]')) WHERE id='message'`).run();
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('KNOWLEDGE_SOURCE_MEDIA_UNSUPPORTED'));
});

test('actual file/message mutation and deleted source reject the captured manifest after capture', t => {
  const f = fixture(t), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }); writeFileSync(join(f.root, 'source.ts'), 'export const changed = true;\n');
  assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_CHANGED')); writeFileSync(join(f.root, 'source.ts'), 'export const authored = true;\n'); f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Different completed source text') WHERE id='message'").run();
  assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_CHANGED')); f.db.prepare("DELETE FROM messages WHERE id='message'").run(); assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_SCOPE_MISMATCH'));
});

test('physical file replacement with identical bytes and storage identity replacement invalidate old source captures', t => {
  const f = fixture(t), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'source.ts' }] }); renameSync(join(f.root, 'source.ts'), join(f.root, 'old.ts')); writeFileSync(join(f.root, 'source.ts'), 'export const authored = true;\n');
  assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_CHANGED')); f.counters.bindingChanged = true; assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_BINDING_MISMATCH'));
});

test('copied/proxy/cross-instance/released projection handles cannot acquire source freshness authority', t => {
  const f = fixture(t), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }), peer = new KnowledgeHostAdapter(f.db, f.ports);
  for (const clone of [{ ...projection }, new Proxy(projection, {})]) assert.throws(() => f.adapter.assertProjectionFresh(clone), hasCode('KNOWLEDGE_SOURCE_CAPTURE_INVALID'));
  assert.throws(() => peer.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_CAPTURE_INVALID')); f.adapter.releaseProjection(projection); assert.throws(() => f.adapter.assertProjectionFresh(projection), hasCode('KNOWLEDGE_SOURCE_CAPTURE_INVALID'));
});

test('source read cancellation blocks captures and remains binding to the original projection owner', t => {
  const f = fixture(t), controller = new AbortController(); controller.abort(); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }, controller.signal), hasCode('KNOWLEDGE_CANCELLED')); assert.equal(f.counters.reads, 0);
  const live = new AbortController(), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }, live.signal); live.abort(); assert.throws(() => f.adapter.assertProjectionFresh(projection, new AbortController().signal), hasCode('KNOWLEDGE_CANCELLED'));
});

test('source file cap is separate from instruction trust cap; raw bytes plus serialized escape overhead are bounded', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'large.ts'), 'x'.repeat(65_536)); const projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'large.ts' }] }); assert.equal((projection.manifest.pins[0]! as { bytes: number }).bytes, 65_536);
  assert.throws(() => captureWorkspaceTrustSources(f.binding(), ['large.ts']), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE')); writeFileSync(join(f.root, 'too-large.ts'), 'x'.repeat(KNOWLEDGE_HOST_LIMITS.fileBytes + 1)); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'too-large.ts' }] }), hasCode('KNOWLEDGE_LIMIT'));
  writeFileSync(join(f.root, 'escapes.ts'), '\u0001'.repeat(65_536)); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'escapes.ts' }] }), hasCode('KNOWLEDGE_LIMIT'));
});

test('message complete content and oversized opaque record are bounded without projecting truncated source', t => {
  const f = fixture(t, { content: 'x'.repeat(KNOWLEDGE_HOST_LIMITS.messageBytes + 1) }); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('KNOWLEDGE_LIMIT'));
  f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','short','$.providerReplay',?) WHERE id='message'").run('opaque'.repeat(180_000)); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!] }), hasCode('INVALID_KNOWLEDGE'));
});

test('source count, duplicate selectors, malicious hashes and executable JSON are rejected', t => {
  const f = fixture(t); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [] }), hasCode('KNOWLEDGE_LIMIT')); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [f.selection[0]!, f.selection[0]!] }), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ ...f.selection[0]!, sha256: sha256('caller') }] } as never), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => f.adapter.captureSources(new Proxy({ workspaceId: 'workspace', selection: f.selection }, {})), hasCode('INVALID_KNOWLEDGE')); assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: Array.from({ length: 65 }, (_, index) => ({ kind: 'file', path: `${index}.ts` })) }), hasCode('KNOWLEDGE_LIMIT'));
});

test('source paths reject final/parent symlinks, directories and invalid binary UTF-8 instead of following aliases', t => {
  const f = fixture(t); symlinkSync('source.ts', join(f.root, 'link.ts')); mkdirSync(join(f.root, 'folder')); writeFileSync(join(f.root, 'folder', 'file.ts'), 'text'); symlinkSync('folder', join(f.root, 'linked-folder')); writeFileSync(join(f.root, 'invalid.ts'), Buffer.from([0xff]));
  for (const relative of ['link.ts', 'linked-folder/file.ts', 'folder', 'invalid.ts']) assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: relative }] }), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
});

test('source and trust pins reject a FIFO without waiting for a writer', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), fifo = join(f.root, 'pipe.md');
  if (spawnSync('mkfifo', [fifo]).status !== 0) { t.skip('mkfifo fixture is unavailable'); return; }
  // A late writer releases a blocked synchronous open, so a regression fails instead of hanging the test process.
  const writer = spawn(process.execPath, ['-e', 'const fs = require("node:fs"); setTimeout(function release() { fs.closeSync(fs.openSync(process.argv[1], "w")); setImmediate(release); }, 5000);', fifo], { stdio: 'ignore' });
  t.after(() => { writer.kill('SIGKILL'); });
  const started = Date.now();
  assert.throws(() => f.adapter.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'pipe.md' }] }), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
  assert.throws(() => captureWorkspaceTrustSources(f.binding(), ['pipe.md']), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
  assert.ok(Date.now() - started < 2_500, 'FIFO pins must be rejected before open waits for a writer');
});

test('actual absent target is version zero with null preimage; existing target has no invented revision', t => {
  const f = fixture(t), absent = f.adapter.captureFileTarget('workspace', 'future/project-note.md'); assert.deepEqual(absent, { kind: 'workspace-file', path: 'future/project-note.md', revision: 0, sha256: null, device: null, inode: null }); f.adapter.assertTargetCurrent(f.binding(), absent);
  assert.throws(() => f.adapter.captureFileTarget('workspace', 'source.ts'), hasCode('KNOWLEDGE_TARGET_REVISION_UNAVAILABLE')); mkdirSync(join(f.root, 'future')); writeFileSync(join(f.root, 'future', 'project-note.md'), 'external created target'); assert.throws(() => f.adapter.assertTargetCurrent(f.binding(), absent), hasCode('KNOWLEDGE_TARGET_CHANGED'));
});

test('existing target actual host revision/hash/physical identity are independently rechecked with effect zero', t => {
  const f = fixture(t, { revision: 7 }), target = f.adapter.captureFileTarget('workspace', 'source.ts'), before = readFileSync(join(f.root, 'source.ts'), 'utf8'); assert.equal(target.revision, 7); assert.equal(target.sha256, sha256(before)); f.adapter.assertTargetCurrent(f.binding(), target); assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), before);
  f.counters.targetRevision = 8; assert.throws(() => f.adapter.assertTargetCurrent(f.binding(), target), hasCode('KNOWLEDGE_TARGET_CHANGED')); f.counters.targetRevision = 7; writeFileSync(join(f.root, 'source.ts'), 'external changed target'); assert.throws(() => f.adapter.assertTargetCurrent(f.binding(), target), hasCode('KNOWLEDGE_TARGET_CHANGED'));
});

test('target source changing inside revision observation cannot return its old preimage as fresh', t => {
  const f = fixture(t, { revision: 1 }); f.counters.beforeVersion = () => { f.counters.beforeVersion = undefined; writeFileSync(join(f.root, 'source.ts'), 'external changed during revision lookup'); };
  assert.throws(() => f.adapter.captureFileTarget('workspace', 'source.ts'), hasCode('KNOWLEDGE_TARGET_CHANGED'));
});

test('workspace-document storage remains explicitly unsupported and absent targets reject symlink parents', t => {
  const f = fixture(t); assert.throws(() => f.adapter.assertTargetCurrent(f.binding(), { kind: 'workspace-document', key: 'project-memory', revision: 0, sha256: null }), hasCode('KNOWLEDGE_WORKSPACE_DOCUMENT_UNSUPPORTED'));
  symlinkSync('other', join(f.root, 'linked-parent')); assert.throws(() => f.adapter.captureFileTarget('workspace', 'linked-parent/new.md'), hasCode('KNOWLEDGE_TARGET_CHANGED')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0);
});

test('actual SQLite host adapter can prepare only a pending source-pinned plan using the same writer transaction', t => {
  const f = fixture(t), projection = f.adapter.captureSources({ workspaceId: 'workspace', selection: f.selection }), target = f.adapter.captureFileTarget('workspace', 'new-memory.md'), binding = f.binding();
  const storage = new KnowledgeStorage(f.db, { writeTx: operation => { f.db.exec('BEGIN IMMEDIATE'); try { const value = operation(); f.db.exec('COMMIT'); return value; } catch (error) { f.db.exec('ROLLBACK'); throw error; } }, getWorkspace: id => f.store.getWorkspace(id), checkHostBinding: f.binding, assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent, assertSourcesCurrent: (owner, source) => f.adapter.assertSourcesCurrent(owner, source), assertTargetCurrent: (owner, current) => f.adapter.assertTargetCurrent(owner, current), now: () => Date.parse(stamp) });
  storage.setTrust({ workspaceId: 'workspace', requestId: 'trust', expectedRevision: 0, decision: 'allow', binding, sources: captureWorkspaceTrustSources(binding, ['AGENTS.md']), expiresAt: null });
  const readsBefore = f.counters.reads, request = { workspaceId: 'workspace', requestId: 'pending-plan', binding, expectedTrustRevision: 1, source: projection.manifest, target, providerId: 'future-provider', modelId: 'future-model', requestSha256: sha256('future exact host-authored request'), requestBytes: 96, maxOutputBytes: 1_024, expiresAt: '2026-10-07T03:01:00.000Z' }, plan = storage.prepareGeneration(request);
  assert.equal(plan.state, 'pending'); assert.equal(f.counters.reads, readsBefore); assert.throws(() => storage.attachGenerationOwner('workspace', plan.id, 'invented-owner'), hasCode('KNOWLEDGE_GENERATION_OWNER_UNAVAILABLE')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 0);
  writeFileSync(join(f.root, 'source.ts'), 'changed'); assert.throws(() => storage.prepareGeneration({ ...request, requestId: 'new-plan' }), hasCode('KNOWLEDGE_SOURCE_CHANGED')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 1);
});
