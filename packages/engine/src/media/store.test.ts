import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { ImageAttachmentStore, IMAGE_DOCUMENT_KIND, type ImageDocuments } from './store.js';
import { DEFAULT_IMAGE_LIMITS, digest, type ImageLimits } from './validation.js';
import { gif, jpeg, png, pngChunk, webp } from './fixtures.js';

function code(expected: string) { return (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, expected); assert.equal(error.cause, undefined); assert.equal(error.details, undefined); return true; }; }
async function fixture(t: TestContext, limits?: Partial<ImageLimits>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-input-image-'))), directory = join(root, 'artifacts', 'input-media');
  const documents = new SqliteStore(join(root, 'engine.sqlite'));
  documents.putWorkspace({ id: 'workspace', root: join(root, 'workspace'), gitRoot: join(root, 'workspace'), branch: null, createdAt: new Date().toISOString() });
  documents.putWorkspace({ id: 'other-workspace', root: join(root, 'other-workspace'), gitRoot: join(root, 'other-workspace'), branch: null, createdAt: new Date().toISOString() });
  for (const [id, workspaceId] of [['session', 'workspace'], ['same-workspace-session', 'workspace'], ['other-session', 'other-workspace']] as const) documents.createSession({ id, workspaceId, title: id, createdAt: new Date().toISOString() });
  t.after(() => { documents.close(); return rm(root, { recursive: true, force: true }); });
  return { root, directory, documents, store: new ImageAttachmentStore({ directory, documents, limits }) };
}

test('real SQLite admission stores metadata only and bytes round-trip after opening another host', async t => {
  const f = await fixture(t), bytes = png(), ref = await f.store.import('session', bytes, 'image/png');
  assert.match(ref.id, /^img_[a-f0-9]{32}$/u); assert.equal(ref.bytes, bytes.length); assert.equal(ref.sha256, digest(bytes));
  const index = f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND)!; assert.equal(index.revision, 1);
  assert.deepEqual(index.data.attachments, [ref]); assert.deepEqual(index.data.owner, { sessionId: 'session', workspaceId: 'workspace', workspaceRoot: join(f.root, 'workspace') });
  assert.ok(!JSON.stringify(index).includes(bytes.toString('base64'))); assert.ok(!JSON.stringify(f.documents.readSessionEvents('session', 0)).includes(bytes.toString('base64')));
  const again = new ImageAttachmentStore({ directory: f.directory, documents: f.documents });
  assert.deepEqual(await again.resolve('session', [ref]), [{ attachment: ref, data: bytes.toString('base64') }]);
  assert.equal((await lstat(join(f.directory, ref.id + '.blob'))).mode & 0o777, 0o600);
});
test('import snapshots caller bytes before async file work; returned references cannot mutate the index', async t => {
  const f = await fixture(t), bytes = png(), expected = Buffer.from(bytes), pending = f.store.import('session', bytes, 'image/png'); bytes.fill(0);
  const ref = await pending, copy = { ...ref }; ref.sha256 = '0'.repeat(64);
  assert.deepEqual(Buffer.from((await f.store.resolve('session', [copy]))[0]!.data, 'base64'), expected);
  await assert.rejects(f.store.resolve('session', [ref]), code('RECORD_SCOPE_MISMATCH'));
});
for (const session of ['same-workspace-session', 'other-session']) test(`known complete reference is unavailable to ${session}`, async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png'); await assert.rejects(f.store.resolve(session, [ref]), code('RECORD_SCOPE_MISMATCH'));
});
for (const [mime, bytes] of [['image/png', png()], ['image/jpeg', jpeg()], ['image/gif', gif()], ['image/webp', webp()]] as const) test(`${mime} bounded container round-trip`, async t => {
  const f = await fixture(t), ref = await f.store.import('session', bytes, mime); assert.deepEqual(Buffer.from((await f.store.resolve('session', [ref]))[0]!.data, 'base64'), bytes);
});
test('MIME mismatch, SVG/HTML, remote URL/path, truncated container and empty input are rejected before storage', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.import('session', png(), 'image/jpeg'), code('IMAGE_MIME_MISMATCH'));
  for (const bytes of [Buffer.from('<svg></svg>'), Buffer.from('<html>'), Buffer.from('https://image.invalid/x'), Buffer.from('/private/image.png')]) await assert.rejects(f.store.import('session', bytes, 'image/png'), code('IMAGE_MIME_MISMATCH'));
  await assert.rejects(f.store.import('session', png().subarray(0, -1), 'image/png'), code('IMAGE_INVALID_FORMAT'));
  await assert.rejects(f.store.import('session', Buffer.alloc(0), 'image/png'), code('IMAGE_LIMIT_EXCEEDED'));
  assert.equal(f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND), null);
});
test('GIF/APNG/WebP animation is explicitly rejected without decoding pixels', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.import('session', gif(true), 'image/gif'), code('IMAGE_ANIMATION_UNSUPPORTED'));
  await assert.rejects(f.store.import('session', png(1, 1, pngChunk('acTL', Buffer.alloc(8))), 'image/png'), code('IMAGE_ANIMATION_UNSUPPORTED'));
  await assert.rejects(f.store.import('session', webp(true), 'image/webp'), code('IMAGE_ANIMATION_UNSUPPORTED'));
});
test('dimension/pixel/compressed-byte guards reject oversized images before any pixel decode', async t => {
  const f = await fixture(t);
  for (const bytes of [png(9000, 1), png(5000, 5000), png(0, 1)]) await assert.rejects(f.store.import('session', bytes, 'image/png'), code('IMAGE_DIMENSIONS_EXCEEDED'));
  await assert.rejects(f.store.import('session', Buffer.alloc(DEFAULT_IMAGE_LIMITS.maxImageBytes + 1), 'image/png'), code('IMAGE_LIMIT_EXCEEDED'));
});
test('per-input count/bytes, duplicate refs and per-session count are bounded', async t => {
  const f = await fixture(t, { maxSessionImages: 5, maxInputBytes: 100 }); const refs = [];
  for (let i = 0; i < 5; i++) refs.push(await f.store.import('session', png(), 'image/png'));
  await assert.rejects(f.store.resolve('session', refs), code('IMAGE_LIMIT_EXCEEDED'));
  await assert.rejects(f.store.resolve('session', [refs[0]!, refs[1]!]), code('IMAGE_LIMIT_EXCEEDED'));
  await assert.rejects(f.store.resolve('session', [refs[0]!, refs[0]!]), code('IMAGE_INVALID_REFERENCE'));
  await assert.rejects(f.store.import('session', png(), 'image/png'), code('IMAGE_LIMIT_EXCEEDED'));
  assert.equal((await readdir(f.directory)).length, 5);
});
test('session bytes cap is enforced atomically with no leaked visible file', async t => {
  const f = await fixture(t, { maxSessionBytes: png().length }); await f.store.import('session', png(), 'image/png');
  await assert.rejects(f.store.import('session', png(), 'image/png'), code('IMAGE_LIMIT_EXCEEDED')); assert.equal((await readdir(f.directory)).length, 1);
});
test('blob changes, growth, missing content and hardlink/symlink substitution fail closed', async t => {
  const f = await fixture(t), original = png(), ref = await f.store.import('session', original, 'image/png'), path = join(f.directory, ref.id + '.blob');
  const changed = Buffer.from(original); changed[changed.length - 5] = changed[changed.length - 5]! ^ 1; await writeFile(path, changed);
  await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_INTEGRITY_FAILED'));
  await writeFile(path, Buffer.concat([original, Buffer.from([0])])); await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_INTEGRITY_FAILED'));
  await rm(path); await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_STORAGE_FAILED'));
  const outside = join(f.root, 'outside.png'); await writeFile(outside, original); await symlink(outside, path);
  await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_PATH_UNSAFE')); assert.deepEqual(await readFile(outside), original);
  await rm(path); await link(outside, path); await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_PATH_UNSAFE'));
});
test('index owner/hash/bytes poisoning never upgrades a forged ref to valid bytes', async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png'), old = f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND)!;
  f.documents.putSessionDocument('session', IMAGE_DOCUMENT_KIND, old.revision, { ...old.data, owner: { sessionId: 'other-session', workspaceId: 'workspace', workspaceRoot: join(f.root, 'workspace') } });
  await assert.rejects(f.store.resolve('session', [ref]), code('RECORD_SCOPE_MISMATCH'));
  f.documents.putSessionDocument('session', IMAGE_DOCUMENT_KIND, old.revision + 1, { ...old.data, attachments: [{ ...ref, sha256: '0'.repeat(64) }] });
  await assert.rejects(f.store.resolve('session', [ref]), code('RECORD_SCOPE_MISMATCH'));
  await assert.rejects(f.store.resolve('session', [{ ...ref, sha256: '0'.repeat(64) }]), code('IMAGE_INTEGRITY_FAILED'));
});
test('root/ancestor symlink and replaced root identities cannot be followed', async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png');
  await rename(f.directory, f.directory + '-old'); await symlink(f.directory + '-old', f.directory);
  await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_PATH_UNSAFE'));
  const other = new ImageAttachmentStore({ directory: join(f.directory, 'child'), documents: f.documents }); await assert.rejects(other.import('session', png(), 'image/png'), code('IMAGE_PATH_UNSAFE'));
  await rm(f.directory); await rename(f.directory + '-old', f.directory);
});
test('cancellation before/during publication leaves no index; cancellation after durable CAS preserves success', async t => {
  const f = await fixture(t), cancelled = new AbortController(); cancelled.abort('PRIVATE_CANCEL_REASON');
  await assert.rejects(f.store.import('session', png(), 'image/png', cancelled.signal), code('IMAGE_CANCELLED'));
  await assert.rejects(f.store.resolve('session', [], cancelled.signal), code('IMAGE_CANCELLED'));
  let committed = false; const controller = new AbortController();
  const documents: ImageDocuments = { getSession: id => f.documents.getSession(id), getWorkspace: id => f.documents.getWorkspace(id), getSessionDocument: (id, kind) => f.documents.getSessionDocument(id, kind),
    putSessionDocument: (id, kind, revision, data) => { const result = f.documents.putSessionDocument(id, kind, revision, data); committed = true; controller.abort(); return result; } };
  const store = new ImageAttachmentStore({ directory: f.directory, documents }); const ref = await store.import('session', png(), 'image/png', controller.signal); assert.equal(committed, true);
  assert.equal((await f.store.resolve('session', [ref])).length, 1);
});
test('pre-CAS cancellation and rejected CAS clean up only the generated blob', async t => {
  const f = await fixture(t), controller = new AbortController(); let calls = 0;
  const documents: ImageDocuments = { getSession: id => { if (++calls === 2) controller.abort(); return f.documents.getSession(id); }, getWorkspace: id => f.documents.getWorkspace(id), getSessionDocument: (id, kind) => f.documents.getSessionDocument(id, kind),
    putSessionDocument: () => { throw new EngineError('REVISION_CONFLICT', 'private implementation details'); } };
  const store = new ImageAttachmentStore({ directory: f.directory, documents }); await assert.rejects(store.import('session', png(), 'image/png', controller.signal), code('IMAGE_CANCELLED'));
  assert.equal(f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND), null); assert.deepEqual(await readdir(f.directory), []);
  const rejected = new ImageAttachmentStore({ directory: f.directory, documents: { ...documents, getSession: id => f.documents.getSession(id) } });
  await assert.rejects(rejected.import('session', png(), 'image/png'), code('REVISION_CONFLICT')); assert.deepEqual(await readdir(f.directory), []);
});
test('concurrent stores use CAS to preserve both accepted refs', async t => {
  const f = await fixture(t), other = new ImageAttachmentStore({ directory: f.directory, documents: f.documents });
  const refs = await Promise.all([f.store.import('session', png(), 'image/png'), other.import('session', png(), 'image/png')]);
  assert.equal(f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND)!.revision, 2); assert.equal((await f.store.resolve('session', refs)).length, 2);
});
test('host-supplied limits can only tighten fixed hard bounds', async t => {
  const f = await fixture(t);
  for (const limits of [{ maxImageBytes: DEFAULT_IMAGE_LIMITS.maxImageBytes + 1 }, { maxInputImages: 0 }, { maxPixels: Infinity }, { unknown: 1 }]) assert.throws(() => new ImageAttachmentStore({ directory: f.directory, documents: f.documents, limits: limits as Partial<ImageLimits> }), code('IMAGE_INVALID_CONFIG'));
  assert.throws(() => new ImageAttachmentStore({ directory: 'relative', documents: f.documents }), code('IMAGE_INVALID_CONFIG'));
});
test('refs must be plain dense data, never path traversal or accessors', async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png'); let accessed = false;
  const getter = { ...ref }; Object.defineProperty(getter, 'id', { enumerable: true, get() { accessed = true; return ref.id; } });
  await assert.rejects(f.store.resolve('session', [getter]), code('IMAGE_INVALID_REFERENCE')); assert.equal(accessed, false);
  await assert.rejects(f.store.resolve('session', [{ ...ref, id: '../outside' }]), code('IMAGE_INVALID_REFERENCE'));
  const sparse = [ref]; delete sparse[0]; await assert.rejects(f.store.resolve('session', sparse), code('IMAGE_INVALID_REFERENCE'));
});
test('resolve notices cancellation after the actual file read and never releases late bytes', async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png'), controller = new AbortController(); let owners = 0;
  const documents: ImageDocuments = { getSession: id => { if (++owners === 2) controller.abort('PRIVATE_LATE_REASON'); return f.documents.getSession(id); }, getWorkspace: id => f.documents.getWorkspace(id),
    getSessionDocument: (id, kind) => f.documents.getSessionDocument(id, kind), putSessionDocument: (id, kind, revision, data) => f.documents.putSessionDocument(id, kind, revision, data) };
  const store = new ImageAttachmentStore({ directory: f.directory, documents }); await assert.rejects(store.resolve('session', [ref], controller.signal), code('IMAGE_CANCELLED'));
  assert.equal(owners, 2); assert.equal(f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND)!.revision, 1);
});
test('fresh CAS retry preserves a concurrent revision instead of overwriting its metadata', async t => {
  const f = await fixture(t), old = await f.store.import('session', png(), 'image/png'); let attempted = false;
  const documents: ImageDocuments = { getSession: id => f.documents.getSession(id), getWorkspace: id => f.documents.getWorkspace(id), getSessionDocument: (id, kind) => f.documents.getSessionDocument(id, kind),
    putSessionDocument: (id, kind, revision, data) => { if (!attempted) { attempted = true; const current = f.documents.getSessionDocument(id, kind)!; f.documents.putSessionDocument(id, kind, current.revision, current.data); throw new EngineError('REVISION_CONFLICT', 'synthetic concurrent host revision'); } return f.documents.putSessionDocument(id, kind, revision, data); } };
  const ref = await new ImageAttachmentStore({ directory: f.directory, documents }).import('session', png(), 'image/png');
  assert.equal(f.documents.getSessionDocument('session', IMAGE_DOCUMENT_KIND)!.revision, 3); assert.equal((await f.store.resolve('session', [old, ref])).length, 2);
});
test('a new regular directory replacing the pinned root fails even without a symlink', async t => {
  const f = await fixture(t), ref = await f.store.import('session', png(), 'image/png'); await rename(f.directory, f.directory + '-old'); await mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(f.store.resolve('session', [ref]), code('IMAGE_PATH_UNSAFE')); await assert.rejects(f.store.import('session', png(), 'image/png'), code('IMAGE_PATH_UNSAFE'));
});
