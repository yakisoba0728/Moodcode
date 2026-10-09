import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL } from '../knowledge/store.js';
import { KNOWLEDGE_LIMITS, knowledgeHash, sha256 } from '../knowledge/validation.js';
import type { KnowledgeHostBinding, KnowledgeStoragePorts } from '../knowledge/types.js';
import { WorkspaceTrustService, assertPhysicalKnowledgeRoot, assertWorkspaceTrustSourcesCurrent, captureWorkspaceTrustSources } from './trust.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-workspace-trust-'))), root = join(directory, 'workspace'); mkdirSync(root); writeFileSync(join(root, 'AGENTS.md'), 'Host-authored trusted instructions.\n');
  const db = new DatabaseSync(join(directory, 'state.sqlite')); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES('workspace')"); db.exec(KNOWLEDGE_SCHEMA_SQL);
  const now = Date.parse('2026-10-07T02:00:00.000Z'), identity = lstatSync(join(directory, 'state.sqlite'), { bigint: true }), storageBindingSha256 = sha256(`${identity.dev}:${identity.ino}`);
  function binding(): KnowledgeHostBinding { const metadata = lstatSync(root, { bigint: true }); return { workspaceId: 'workspace', root, rootDevice: metadata.dev.toString(), rootInode: metadata.ino.toString(), storageBindingSha256 }; }
  const ports: KnowledgeStoragePorts = { writeTx: operation => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, getWorkspace: id => ({ id, root }), checkHostBinding: binding, assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent, assertSourcesCurrent() {}, assertTargetCurrent() {}, now: () => now };
  const store = new KnowledgeStorage(db, ports), service = new WorkspaceTrustService(store);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); }); return { directory, root, db, store, service, binding, now };
}

test('host preview captures immutable physical source hash/size without instruction text or authority', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']);
  assert.equal(preview.sources[0]!.sha256, sha256('Host-authored trusted instructions.\n')); assert.equal(preview.sources[0]!.bytes, Buffer.byteLength('Host-authored trusted instructions.\n'));
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.binding) && Object.isFrozen(preview.sources) && Object.isFrozen(preview.sources[0])); assert.equal('text' in preview.sources[0]!, false); assert.equal(f.store.getTrust('workspace'), undefined);
  assert.equal(preview.sha256, knowledgeHash({ workspaceId: preview.workspaceId, binding: preview.binding, sources: preview.sources }));
});

test('host allow uses exactly the issued preview and revocation appends its own CAS revision', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']), accepted = f.service.set({ workspaceId: 'workspace', requestId: 'approve', expectedRevision: 0, decision: 'allow', preview });
  assert.equal(accepted.decision, 'allow'); assert.deepEqual(accepted.sources, preview.sources); assert.deepEqual(f.store.assertTrusted('workspace', 1), accepted);
  const revoke = f.service.set({ workspaceId: 'workspace', requestId: 'revoke', expectedRevision: 1, decision: 'deny' }); assert.equal(revoke.revision, 2); assert.deepEqual(revoke.sources, []); assert.equal(revoke.previousId, accepted.id);
  assert.throws(() => f.store.assertTrusted('workspace', 2), hasCode('WORKSPACE_UNTRUSTED'));
});

test('copied, foreign-service, proxy and wrong-workspace previews cannot approve trust', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']), peer = new WorkspaceTrustService(f.store), input = { workspaceId: 'workspace', requestId: 'approve', expectedRevision: 0, decision: 'allow' as const };
  for (const forged of [{ ...preview }, structuredClone(preview)]) assert.throws(() => f.service.set({ ...input, preview: forged }), hasCode('WORKSPACE_TRUST_PREVIEW_INVALID'));
  assert.throws(() => f.service.set({ ...input, preview: new Proxy(preview, {}) }), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => peer.set({ ...input, preview }), hasCode('WORKSPACE_TRUST_PREVIEW_INVALID')); assert.throws(() => f.service.set({ ...input, workspaceId: 'other', preview }), hasCode('WORKSPACE_TRUST_PREVIEW_INVALID')); assert.equal(f.store.getTrust('workspace'), undefined);
});

test("source change, deletion and replacement after preview block its original host approval", (t) => {
  const f = fixture(t),
    preview = f.service.preview("workspace", ["AGENTS.md"]),
    input = {
      workspaceId: "workspace",
      requestId: "approve",
      expectedRevision: 0,
      decision: "allow" as const,
      preview,
    };
  writeFileSync(join(f.root, "AGENTS.md"), "Unapproved replacement text\n");
  assert.throws(
    () => f.service.set(input),
    hasCode("KNOWLEDGE_SOURCE_CHANGED"),
  );
  // Keep the actual preview inode allocated while its original path is missing.
  renameSync(join(f.root, "AGENTS.md"), join(f.root, "retained-old-inode.md"));
  const retained = lstatSync(join(f.root, "retained-old-inode.md"), { bigint: true });
  assert.deepEqual(
    [retained.dev.toString(), retained.ino.toString()],
    [preview.sources[0]!.device, preview.sources[0]!.inode],
  );
  assert.throws(
    () => f.service.set(input),
    hasCode("KNOWLEDGE_SOURCE_UNAVAILABLE"),
  );
  writeFileSync(
    join(f.root, "AGENTS.md"),
    "Host-authored trusted instructions.\n",
  );
  const replacement = lstatSync(join(f.root, "AGENTS.md"), { bigint: true });
  assert.notDeepEqual(
    [replacement.dev.toString(), replacement.ino.toString()],
    [preview.sources[0]!.device, preview.sources[0]!.inode],
  );
  assert.throws(
    () => f.service.set(input),
    hasCode("KNOWLEDGE_SOURCE_CHANGED"),
  );
  assert.equal(f.store.getTrust("workspace"), undefined);
});

test('physical root replacement invalidates trust even when instruction content matches', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']); renameSync(f.root, join(f.directory, 'old-workspace')); mkdirSync(f.root); writeFileSync(join(f.root, 'AGENTS.md'), 'Host-authored trusted instructions.\n');
  assert.throws(() => assertPhysicalKnowledgeRoot(preview.binding), hasCode('KNOWLEDGE_BINDING_MISMATCH')); assert.throws(() => f.service.set({ workspaceId: 'workspace', requestId: 'approve', expectedRevision: 0, decision: 'allow', preview }), hasCode('KNOWLEDGE_BINDING_MISMATCH'));
});

for (const selected of ['../outside.md', '/absolute.md', 'folder/../AGENTS.md', './AGENTS.md', 'folder//file.md', 'folder\\file.md', 'C:/file.md', '']) test(`exact trust paths reject unsafe spelling ${JSON.stringify(selected)}`, t => {
  const f = fixture(t); assert.throws(() => f.service.preview('workspace', [selected]), hasCode('INVALID_KNOWLEDGE_PATH'));
});

test('trust source final symlinks and symlinked directories are rejected, including within-root links', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'real')); writeFileSync(join(f.root, 'real', 'AGENTS.md'), 'Actual instruction bytes'); symlinkSync('real/AGENTS.md', join(f.root, 'linked.md')); symlinkSync('real', join(f.root, 'linked-directory'));
  assert.throws(() => f.service.preview('workspace', ['linked.md']), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE')); assert.throws(() => f.service.preview('workspace', ['linked-directory/AGENTS.md']), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
});

test('hardlinked, directory, missing and dangling trust sources are unavailable', t => {
  const f = fixture(t); linkSync(join(f.root, 'AGENTS.md'), join(f.root, 'hardlink.md')); mkdirSync(join(f.root, 'directory.md')); symlinkSync('missing.md', join(f.root, 'dangling.md'));
  for (const selected of ['AGENTS.md', 'hardlink.md', 'directory.md', 'missing.md', 'dangling.md']) assert.throws(() => f.service.preview('workspace', [selected]), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
});

test('trust source byte, count, duplicate and binary limits reject before approval', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'oversized.md'), 'a'.repeat(KNOWLEDGE_LIMITS.trustFileBytes + 1)); writeFileSync(join(f.root, 'bad-utf8.md'), Buffer.from([0xff, 0xfe])); writeFileSync(join(f.root, 'nul.md'), 'a\0b');
  for (const selected of ['oversized.md', 'bad-utf8.md', 'nul.md']) assert.throws(() => f.service.preview('workspace', [selected]), hasCode('KNOWLEDGE_SOURCE_UNAVAILABLE'));
  assert.throws(() => f.service.preview('workspace', ['AGENTS.md', 'AGENTS.md']), hasCode('KNOWLEDGE_LIMIT')); assert.throws(() => f.service.preview('workspace', Array.from({ length: 33 }, (_, index) => `${index}.md`)), hasCode('KNOWLEDGE_LIMIT'));
});

test('exact byte cap, empty source files and Unicode instruction text use actual UTF-8 byte/hash observations', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'cap.md'), 'a'.repeat(KNOWLEDGE_LIMITS.trustFileBytes)); writeFileSync(join(f.root, 'empty.md'), ''); writeFileSync(join(f.root, '설명.md'), '프로젝트 지침 😀\n');
  const sources = captureWorkspaceTrustSources(f.binding(), ['cap.md', 'empty.md', '설명.md']); assert.equal(sources[0]!.bytes, KNOWLEDGE_LIMITS.trustFileBytes); assert.equal(sources[1]!.sha256, sha256('')); assert.equal(sources[2]!.bytes, Buffer.byteLength('프로젝트 지침 😀\n')); assertWorkspaceTrustSourcesCurrent(f.binding(), sources);
});

test('empty host trust selection still checks canonical physical workspace identity', t => {
  const f = fixture(t), binding = f.binding(); assert.deepEqual(captureWorkspaceTrustSources(binding, []), []); assert.throws(() => captureWorkspaceTrustSources({ ...binding, rootInode: '0' }, []), hasCode('KNOWLEDGE_BINDING_MISMATCH'));
});

test('canonical root aliases and root symlinks cannot masquerade as the approved physical root', t => {
  const f = fixture(t), alias = join(f.directory, 'alias'); symlinkSync(f.root, alias);
  assert.throws(() => assertPhysicalKnowledgeRoot({ ...f.binding(), root: alias }), hasCode('KNOWLEDGE_BINDING_MISMATCH'));
});

test('trust decisions reject executable JSON without invoking getters or updating trust', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']), input = { workspaceId: 'workspace', requestId: 'approve', expectedRevision: 0, decision: 'allow' as const, preview }; let called = 0;
  Object.defineProperty(input, 'requestId', { get() { called++; return 'side-effect'; }, enumerable: true }); assert.throws(() => f.service.set(input), hasCode('INVALID_KNOWLEDGE')); assert.equal(called, 0); assert.equal(f.store.getTrust('workspace'), undefined);
});

test('explicit expiry is persisted; revocation cannot carry an approval preview or expiry', t => {
  const f = fixture(t), preview = f.service.preview('workspace', ['AGENTS.md']), expiry = new Date(f.now + 60_000).toISOString(); assert.equal(f.service.set({ workspaceId: 'workspace', requestId: 'approve', expectedRevision: 0, decision: 'allow', preview, expiresAt: expiry }).expiresAt, expiry);
  assert.throws(() => f.service.set({ workspaceId: 'workspace', requestId: 'bad-revoke', expectedRevision: 1, decision: 'deny', preview }), hasCode('INVALID_KNOWLEDGE')); assert.throws(() => f.service.set({ workspaceId: 'workspace', requestId: 'bad-revoke', expectedRevision: 1, decision: 'deny', expiresAt: expiry }), hasCode('INVALID_KNOWLEDGE'));
});
