import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { DocumentAttachmentStore, INPUT_DOCUMENT_KIND } from '../documents/store.js';
import { png } from '../media/fixtures.js';
import { wav } from '../media/segment-fixtures.js';
import { MediaSegmentStore, SEGMENT_DOCUMENT_KIND } from '../media/segment-store.js';
import { IMAGE_DOCUMENT_KIND, ImageAttachmentStore } from '../media/store.js';
import { SqliteStore } from './index.js';
import type { SessionBlobDocuments } from './session-blob-store.js';

type Options = { directory: string; documents: SessionBlobDocuments };
interface Store { add(): Promise<{ id: string }>; resolve(): Promise<unknown[]> }
const kinds: { code: string; kind: string; key: string; create(options: Options): Store }[] = [
  { code: 'IMAGE', kind: IMAGE_DOCUMENT_KIND, key: 'attachments', create: options => { const store = new ImageAttachmentStore(options); return { add: () => store.import('session', png(), 'image/png'), resolve: () => store.resolve('session', []) }; } },
  { code: 'DOCUMENT', kind: INPUT_DOCUMENT_KIND, key: 'documents', create: options => { const store = new DocumentAttachmentStore(options); return { add: () => store.import('session', Buffer.from('%PDF-1.7\nfixture\n')), resolve: () => store.resolve('session', []) }; } },
  { code: 'MEDIA', kind: SEGMENT_DOCUMENT_KIND, key: 'attachments', create: options => { const store = new MediaSegmentStore(options); return { add: () => store.import('session', wav(), 'audio/wav', [{ startMs: 0, endMs: 100 }]), resolve: () => store.resolve('session', []) }; } },
];
const code = (expected: string) => (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, expected); return true; };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-session-blobs-'))), documents = new SqliteStore(join(root, 'engine.sqlite'));
  documents.putWorkspace({ id: 'workspace', root: join(root, 'workspace'), gitRoot: join(root, 'workspace'), branch: null, createdAt: new Date().toISOString() });
  documents.createSession({ id: 'session', workspaceId: 'workspace', title: 'session', createdAt: new Date().toISOString() });
  t.after(() => { documents.close(); return rm(root, { recursive: true, force: true }); });
  return { directory: join(root, 'blobs'), documents };
}

for (const k of kinds) test(`${k.code} import keeps its persisted index shape and rejects a staging inode substituted at link time`, async t => {
  const f = await fixture(t), store = k.create({ directory: f.directory, documents: f.documents }), ref = await store.add();
  assert.deepEqual(Object.keys(f.documents.getSessionDocument('session', k.kind)!.data), ['version', 'owner', k.key]);
  assert.deepEqual(await readdir(f.directory), [ref.id + '.blob']);
  const link = fsPromises.link;
  t.mock.method(fsPromises, 'link', async (staging: string, destination: string) => {
    await writeFile(staging + '.planted', 'planted'); await rename(staging + '.planted', staging); return link(staging, destination);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(store.add(), code(k.code + '_PATH_UNSAFE')); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.documents.getSessionDocument('session', k.kind)!.revision, 1);
  const planted = (await readdir(f.directory)).filter(name => !name.startsWith(ref.id));
  assert.equal(planted.length, 2);
  for (const name of planted) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'planted');
});

for (const k of kinds) test(`${k.code} options and index proxies or extra index keys fail before any trap runs`, async t => {
  const f = await fixture(t); let traps = 0;
  const trap = { get() { traps++; throw new Error('private trap'); }, getPrototypeOf() { traps++; throw new Error('private trap'); } };
  assert.throws(() => k.create(new Proxy({ directory: f.directory, documents: f.documents }, trap)), code(k.code + '_INVALID_CONFIG'));
  const index = (data: unknown) => k.create({ directory: f.directory, documents: { getSession: id => f.documents.getSession(id), getWorkspace: id => f.documents.getWorkspace(id), getSessionDocument: () => data as never, putSessionDocument: () => assert.fail('no write') } });
  await assert.rejects(index(new Proxy({ revision: 1, data: {} }, trap)).resolve(), code(k.code + '_INVALID_INDEX'));
  const owner = { sessionId: 'session', workspaceId: 'workspace', workspaceRoot: f.documents.getWorkspace('workspace').root };
  await assert.rejects(index({ revision: 1, data: { version: 1, owner, [k.key]: [], extra: true } }).resolve(), code(k.code + '_INVALID_INDEX'));
  assert.deepEqual(await index({ revision: 1, data: { version: 1, owner, [k.key]: [] } }).resolve(), []);
  assert.equal(traps, 0);
});
