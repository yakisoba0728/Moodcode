import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JsonObject } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ChildTaskRecord } from '../child-tasks/index.js';
import type { ManagedWorktree } from '../worktrees/index.js';
import { admitChildStorageBinding, childStoragePhysicalIdentity, confirmChildStorageClosed, prepareChildStorageBinding } from '../child-tasks/storage-binding.js';
import type { GrantDocumentPort } from '../permission/grants.js';
import { createChildDocumentReadFrame, readChildDocumentIndex } from './child-document-reader.js';
import { SqliteStore } from './index.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const posixOnly = { skip: process.platform === 'win32' };
interface Ready { stage: string; mirrorPath?: string; mirrorDirectory?: string; documentIds?: string[]; complete?: boolean; stats?: { rawMirrorBytes: number }; copiedBytes?: number; backupPath?: string }
interface FileProof { path: string; dev: string; ino: string; size: number; nlink: string; mode: number; mtimeNs: string; ctimeNs: string; sha256?: string }

async function treeProof(root: string): Promise<FileProof[]> {
  const output: FileProof[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path, { bigint: true });
    assert.ok(!stat.isSymbolicLink(), 'The authored fixture inventory never follows symlinks');
    output.push({ path, dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), nlink: String(stat.nlink), mode: Number(stat.mode & 0o777n), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), ...(stat.isFile() ? { sha256: sha(await readFile(path)) } : {}) });
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root); return output;
}

async function fixture(t: TestContext, options: { initializedOwner?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-child-owner-crash-review-'))), artifacts = join(root, 'artifacts'), children = join(artifacts, 'children');
  const taskId = 'child_' + randomUUID().replaceAll('-', ''), worktreeId = 'worktree_' + randomUUID().replaceAll('-', ''), worktreeRoot = join(children, 'worktrees', worktreeId), childRoot = join(children, taskId), childArtifacts = join(childRoot, 'artifacts'), dbPath = join(childRoot, 'engine.sqlite');
  await mkdir(worktreeRoot, { recursive: true }); await writeFile(join(root, 'engine.sqlite'), '');
  const engine = createEngine({ dbPath, artifactDir: childArtifacts, tools: [] });
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const operation of cleanup.reverse()) await operation(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString(), workspaceId = 'workspace_' + sha(worktreeRoot), workspace = { id: workspaceId, root: worktreeRoot, gitRoot: worktreeRoot, branch: null, createdAt };
  engine.store.putWorkspace(workspace); engine.store.createSession({ id: 'reader-child', workspaceId, title: 'Explicit owner crash fixture', createdAt });
  const documents = new Map<string, { revision: number; data: JsonObject }>();
  const rootPort: GrantDocumentPort = {
    getSessionDocument(sessionId, kind) { return structuredClone(documents.get(sessionId + ':' + kind) ?? null); },
    putSessionDocument(sessionId, kind, expectedRevision, data) { const key = sessionId + ':' + kind; assert.equal(documents.get(key)?.revision ?? 0, expectedRevision); const value = { revision: expectedRevision + 1, data: structuredClone(data) }; documents.set(key, value); return structuredClone(value); },
  };
  const task = { id: taskId, requestId: 'source-request', sessionId: 'reader-parent', parentRunId: 'source-run', rootRunId: 'source-run', depth: 1, worktreeId, toolNames: [], budget: { turns: 1, toolCalls: 1, outputBytes: 4096, durationMs: 5000 }, state: 'starting', fingerprint: 'a'.repeat(64), createdAt, updatedAt: createdAt, deliveryState: 'none', deliveryRequestId: 'result' } as ChildTaskRecord;
  const stat = await lstat(worktreeRoot, { bigint: true }), worktree = { id: worktreeId, requestId: 'worktree', sessionId: task.sessionId, workspaceId: 'parent-workspace', baseRoot: root, root: worktreeRoot, baseCommit: 'b'.repeat(40), reference: 'HEAD', state: 'ready', revision: 1, createdAt, updatedAt: createdAt, fingerprint: 'c'.repeat(64), device: String(stat.dev), inode: String(stat.ino), ownerId: taskId } as ManagedWorktree;
  const prepared = prepareChildStorageBinding(rootPort, engine.store, { task, requestFingerprint: 'd'.repeat(64), hostIdentity: { database: childStoragePhysicalIdentity(join(root, 'engine.sqlite')), artifacts: childStoragePhysicalIdentity(artifacts, true) }, childrenDirectory: children, worktree, workspace, childSessionId: 'reader-child' });
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'reader-child', requestId: taskId, prompt: 'Complete only the authored local owner fixture.', config: engine.getCapabilities().defaults });
  const admitted = admitChildStorageBinding(rootPort, engine.store, prepared, receipt.runId);
  const ref = await engine.importDocument('reader-child', Buffer.from('%PDF-1.7\nAuthored crash lease observation.\n'));
  assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed'); await engine.close();
  if (options.initializedOwner) {
    // A valid DELETE-mode header avoids conflating a live exclusive owner
    // lease with the journal created when SQLite initializes an empty file.
    const owner = new DatabaseSync(dbPath + '.owner.sqlite');
    try { owner.exec('PRAGMA journal_mode=DELETE; CREATE TABLE fixture_owner_header(value INTEGER)'); } finally { owner.close(); }
  }
  const record = confirmChildStorageClosed(rootPort, admitted), recordPath = join(root, 'record.json'); await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(dbPath + suffix), false, 'Fixture begins with the original last-owner checkpoint complete');

  async function launch(mode: 'reader' | 'reader-copy' | 'reader-backup' | 'owner-only' | 'writer' | 'writer-hot') {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : import.meta.url.endsWith('.mjs') ? 'mjs' : 'js';
    const path = fileURLToPath(new URL(`./child-storage-owner-crash-review.fixture.${extension}`, import.meta.url));
    const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), path, recordPath, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr?.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-8192); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let mirrorPin: { path: string; dev: string; ino: string } | undefined;
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited;
      if (mirrorPin && existsSync(mirrorPin.path)) {
        // Explicit test cleanup only: this exact private directory was observed
        // from this process and its inode is rechecked, never discovered/pruned.
        const pin = await lstat(mirrorPin.path, { bigint: true });
        assert.equal(String(pin.dev), mirrorPin.dev); assert.equal(String(pin.ino), mirrorPin.ino); assert.ok(pin.isDirectory() && !pin.isSymbolicLink());
        await rm(mirrorPin.path, { recursive: true });
      }
    });
    const ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owner fixture did not reach ${mode}: ${diagnostics}`)), 15_000);
      const failed = () => { clearTimeout(timer); reject(new Error(`Owner fixture exited before ${mode}: ${diagnostics}`)); };
      child.once('exit', failed); child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('message', message => { clearTimeout(timer); child.removeListener('exit', failed); resolve(message as Ready); });
    });
    assert.equal(ready.stage, `${mode}-ready`);
    if (ready.mirrorDirectory && existsSync(ready.mirrorDirectory)) {
      assert.ok(basename(ready.mirrorDirectory).startsWith('moodcode-child-document-reader-')); assert.equal(await realpath(dirname(ready.mirrorDirectory)), await realpath(tmpdir()));
      const pin = await lstat(ready.mirrorDirectory, { bigint: true }); mirrorPin = { path: ready.mirrorDirectory, dev: String(pin.dev), ino: String(pin.ino) };
    }
    return { child, ready, exited, diagnostics: () => diagnostics };
  }
  return { root, childRoot, childArtifacts, dbPath, record, ref, launch };
}

async function kill(child: ChildProcess, exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>) {
  assert.equal(child.kill('SIGKILL'), true); const result = await exited; assert.equal(result.signal, 'SIGKILL'); assert.equal(result.code, null);
}

test('SIGKILL releases the held reader owner lease without writing source files; private mirror remnants are measured separately', posixOnly, async t => {
  const f = await fixture(t), before = await treeProof(f.childRoot), main = await readFile(f.dbPath), reader = await f.launch('reader');
  assert.equal(reader.ready.complete, true); assert.deepEqual(reader.ready.documentIds, [f.ref.id]); assert.equal(reader.ready.stats?.rawMirrorBytes, main.length);
  assert.equal(main[18], 2, 'A checkpointed WAL-mode header alone is not a hot original');
  assert.throws(() => new SqliteStore(f.dbPath), code('DB_LOCKED'), 'The actual process reader holds the original owner SHARED lease');
  assert.deepEqual(await treeProof(f.childRoot), before, 'Reader startup plus failed writer acquisition leave DB, owner, artifacts, and directory metadata unchanged');
  await kill(reader.child, reader.exited);
  assert.deepEqual(await treeProof(f.childRoot), before, 'SIGKILL itself does not write the original checkpoint or owner file');
  const mirrorPath = reader.ready.mirrorPath!, mirrorDirectory = reader.ready.mirrorDirectory!, residual = existsSync(mirrorDirectory) ? await treeProof(mirrorDirectory) : [];
  const files = residual.filter(file => file.sha256), remainingBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length) { assert.equal(files.length, 1); assert.equal(files[0]!.path, mirrorPath); assert.equal(files[0]!.mode, 0o600); assert.equal(files[0]!.sha256, sha(main)); assert.equal(remainingBytes, main.length); assert.equal(residual[0]!.mode, 0o700); }
  assert.equal(files.length, 0, 'Validated POSIX reader has unlinked only its own private copy before returning');
  t.diagnostic(JSON.stringify({ phase: 'after-reader-sigkill', originalCheckpointBytes: main.length, originalFilesUnchanged: true, privateMirrorPath: mirrorPath, residualFiles: files.length, residualBytes: remainingBytes, residualDirectoryExists: residual.length > 0, automaticKillCleanupClaimed: false }));
  const writer = new SqliteStore(f.dbPath); try { assert.equal(writer.getRun(f.record.binding.child.runId!).state, 'completed'); } finally { await writer.closeAsync(); }
  assert.equal((readChildDocumentIndex({ mode: 'source', record: f.record }, createChildDocumentReadFrame())).status, 'observed', 'An explicitly opened then cleanly closed successor writer preserves the original read-only lineage');
});

test('one killed reader does not release another process reader lease; last reader death allows a new real writer', posixOnly, async t => {
  const f = await fixture(t), first = await f.launch('reader'), second = await f.launch('reader'), before = await treeProof(f.childRoot);
  assert.notEqual(first.ready.mirrorPath, second.ready.mirrorPath);
  await kill(first.child, first.exited); assert.throws(() => new SqliteStore(f.dbPath), code('DB_LOCKED'));
  assert.deepEqual(await treeProof(f.childRoot), before); await kill(second.child, second.exited); assert.deepEqual(await treeProof(f.childRoot), before);
  const writer = new SqliteStore(f.dbPath); await writer.closeAsync();
});

test('a live owner-only process and a reowned child remain unauthorized despite the old confirmed-close record', posixOnly, async t => {
  const f = await fixture(t, { initializedOwner: true }), before = await treeProof(f.childRoot), owner = await f.launch('owner-only'), ownerFrame = createChildDocumentReadFrame();
  const busy = readChildDocumentIndex({ mode: 'source', record: f.record }, ownerFrame);
  assert.equal(busy.status, 'unchecked'); assert.deepEqual(busy.reasons, ['CHILD_DOCUMENT_STORAGE_OWNER_BUSY']); assert.equal(ownerFrame.stats().rawMirrorBytes, 0); assert.equal(ownerFrame.stats().selectedMetadataBytes, 0);
  assert.deepEqual(await treeProof(f.childRoot), before); await kill(owner.child, owner.exited);
  assert.equal(readChildDocumentIndex({ mode: 'source', record: f.record }, createChildDocumentReadFrame()).status, 'observed');
  const saved = f.dbPath + '.old-inode'; await rename(f.dbPath, saved); await writeFile(f.dbPath, await readFile(saved));
  const replacedBefore = await treeProof(f.childRoot), replacedFrame = createChildDocumentReadFrame(), replaced = readChildDocumentIndex({ mode: 'source', record: f.record }, replacedFrame);
  assert.equal(replaced.status, 'unchecked'); assert.deepEqual(replaced.reasons, ['CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED']); assert.equal(replacedFrame.stats().rawMirrorBytes, 0); assert.equal(replacedFrame.stats().selectedMetadataBytes, 0); assert.deepEqual(await treeProof(f.childRoot), replacedBefore);
});

test('SIGKILL before ATTACH leaves a measured partial private copy but releases owner lease without touching the original', posixOnly, async t => {
  const f = await fixture(t), main = await readFile(f.dbPath); assert.ok(main.length > 262_144);
  const before = await treeProof(f.childRoot), reader = await f.launch('reader-copy');
  assert.equal(reader.ready.copiedBytes, 262_144); assert.throws(() => new SqliteStore(f.dbPath), code('DB_LOCKED')); assert.deepEqual(await treeProof(f.childRoot), before);
  await kill(reader.child, reader.exited); assert.deepEqual(await treeProof(f.childRoot), before);
  const residual = await treeProof(reader.ready.mirrorDirectory!), files = residual.filter(file => file.sha256);
  assert.equal(files.length, 1); assert.equal(files[0]!.size, 262_144); assert.equal(files[0]!.mode, 0o600); assert.equal(residual[0]!.mode, 0o700); assert.equal(files[0]!.sha256, sha(main.subarray(0, 262_144)));
  t.diagnostic(JSON.stringify({ phase: 'copy-before-attach-sigkill', privateMirrorPath: reader.ready.mirrorPath, residualFiles: files.length, residualBytes: files[0]!.size, originalFilesUnchanged: true, automaticKillCleanupClaimed: false }));
  const successor = new SqliteStore(f.dbPath); await successor.closeAsync();
});

test('actual held immutable reader can back up after POSIX unlink and keeps ownership until explicit close', posixOnly, async t => {
  const f = await fixture(t), before = await treeProof(f.childRoot), reader = await f.launch('reader-backup');
  assert.equal(existsSync(reader.ready.mirrorDirectory!), false); assert.equal(reader.ready.complete, true); assert.deepEqual(reader.ready.documentIds, [f.ref.id]); assert.throws(() => new SqliteStore(f.dbPath), code('DB_LOCKED'));
  assert.deepEqual(await treeProof(f.childRoot), before); assert.equal(dirname(reader.ready.backupPath!), f.root);
  const db = new DatabaseSync(':memory:');
  try {
    const uri = pathToFileURL(reader.ready.backupPath!); uri.search = '?mode=ro&immutable=1'; db.prepare('ATTACH DATABASE ? AS child').run(uri.href);
    const index = db.prepare("SELECT data FROM child.session_documents WHERE session_id='reader-child' AND kind='input_documents'").get();
    assert.ok(index && String(index.data).includes(f.ref.id));
    assert.equal(db.prepare('SELECT state FROM child.runs WHERE id=?').get(f.record.binding.child.runId!)?.state, 'completed');
  } finally { db.close(); }
  reader.child.send('close'); const result = await reader.exited; assert.equal(result.code, 0, reader.diagnostics()); assert.equal(result.signal, null);
  assert.deepEqual(await treeProof(f.childRoot), before); const successor = new SqliteStore(f.dbPath); await successor.closeAsync();
});

test('hard-killed real writer leaves hot WAL unknown to the reader even after its OS owner lock releases', posixOnly, async t => {
  const f = await fixture(t), writer = await f.launch('writer-hot');
  assert.equal(existsSync(f.dbPath + '-wal'), true); assert.ok((await lstat(f.dbPath + '-wal')).size > 32); assert.equal(existsSync(f.dbPath + '-shm'), true);
  const live = createChildDocumentReadFrame(), liveObservation = readChildDocumentIndex({ mode: 'source', record: f.record }, live);
  assert.equal(liveObservation.status, 'unchecked'); assert.deepEqual(liveObservation.reasons, ['CHILD_DOCUMENT_STORAGE_HOT_DATABASE']); assert.equal(live.stats().rawMirrorBytes, 0);
  await kill(writer.child, writer.exited);
  const killed = await treeProof(f.childRoot), afterCrash = createChildDocumentReadFrame(), crashObservation = readChildDocumentIndex({ mode: 'source', record: f.record }, afterCrash);
  assert.equal(crashObservation.status, 'unchecked'); assert.deepEqual(crashObservation.reasons, ['CHILD_DOCUMENT_STORAGE_HOT_DATABASE']); assert.equal(afterCrash.stats().selectedMetadataBytes, 0); assert.equal(afterCrash.stats().rawMirrorBytes, 0); assert.deepEqual(await treeProof(f.childRoot), killed, 'Source reader neither recovers the hot original nor claims confirmed cleanup');
  t.diagnostic(JSON.stringify({ phase: 'after-writer-sigkill', originalWalBytes: killed.find(file => file.path === f.dbPath + '-wal')!.size, reader: crashObservation.status, reasons: crashObservation.reasons, automaticCheckpoint: false }));
  const successor = new SqliteStore(f.dbPath); try { assert.equal(successor.getSessionDocument('reader-child', 'owner.crash_probe')?.data.note, 'Authored temporary writer WAL observation'); } finally { await successor.closeAsync(); }
  assert.equal(existsSync(f.dbPath + '-wal'), false); assert.equal(existsSync(f.dbPath + '-shm'), false);
  assert.equal(readChildDocumentIndex({ mode: 'source', record: f.record }, createChildDocumentReadFrame()).status, 'observed', 'Only the explicit temporary successor writer performed WAL recovery and last-owner checkpoint');
});

test('native unfinished state remains unchecked after clean file close; quiescent file ownership never proves provider outcome', posixOnly, async t => {
  const f = await fixture(t), db = new DatabaseSync(f.dbPath);
  try {
    db.exec("UPDATE session_turns SET state='streaming',data=json_remove(json_set(data,'$.state','streaming'),'$.completedAt'); UPDATE provider_attempts SET state='dispatched',data=json_remove(json_set(data,'$.state','dispatched'),'$.completedAt')");
  } finally { db.close(); }
  const before = await treeProof(f.childRoot), frame = createChildDocumentReadFrame(), observation = readChildDocumentIndex({ mode: 'source', record: f.record }, frame);
  assert.equal(observation.status, 'unchecked'); assert.deepEqual(observation.reasons, ['CHILD_DOCUMENT_STORAGE_NOT_QUIESCENT']); assert.equal(frame.stats().selectedMetadataBytes, 0); assert.ok(frame.stats().rawMirrorBytes > 0, 'Private SQL metadata checks require a bounded file mirror, not source JSON bodies'); assert.deepEqual(await treeProof(f.childRoot), before);
});
