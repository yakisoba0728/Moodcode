import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createChildDocumentReadFrame, openChildDocumentReader } from './child-document-reader.js';
import { validateChildStorageRecord } from '../child-tasks/storage-binding.js';
import { SqliteStore } from './index.js';

// Only the parent's explicitly authored temporary fixture is accepted. This
// process never discovers child paths or reads a real project's credentials.
const [recordPath, mode] = process.argv.slice(2);
if (!recordPath || !['reader', 'reader-copy', 'reader-backup', 'owner-only', 'writer', 'writer-hot'].includes(mode!)) throw new Error('Invalid owner crash fixture');
const bytes = readFileSync(recordPath);
if (bytes.length > 32_768) throw new Error('Fixture record exceeds its bound');
const record = validateChildStorageRecord(JSON.parse(bytes.toString('utf8')));
let close: () => void | Promise<void>;
let keepAlive: () => void;
let ready: Record<string, unknown>;

if (mode === 'reader-copy') {
  const originalRead = fs.readSync, originalMkdtemp = fs.mkdtempSync;
  let mirrorDirectory: string | undefined;
  fs.mkdtempSync = ((prefix: string, options?: Parameters<typeof fs.mkdtempSync>[1]) => {
    const result = originalMkdtemp(prefix, options);
    if (prefix.includes('moodcode-child-document-reader-')) mirrorDirectory = String(result);
    return result;
  }) as typeof fs.mkdtempSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null): number => {
    if (mirrorDirectory && buffer.byteLength === 262_144 && position === 262_144) {
      const pin = fs.fstatSync(fd, { bigint: true });
      if (String(pin.dev) !== record.binding.physical.database.dev || String(pin.ino) !== record.binding.physical.database.ino) throw new Error('Copy crash fixture source mismatch');
      const mirrorPath = join(mirrorDirectory, 'data', 'engine.sqlite');
      process.send?.({ stage: 'reader-copy-ready', mirrorPath, mirrorDirectory, copiedBytes: fs.statSync(mirrorPath).size });
      // The previous chunk was written, while the source FD, output FD, and
      // actual owner read transaction are still open. Parent sends SIGKILL.
      process.kill(process.pid, 'SIGSTOP');
    }
    return originalRead(fd, buffer, offset, length, position);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
}

if (mode?.startsWith('reader')) {
  const frame = createChildDocumentReadFrame(), reader = openChildDocumentReader({ mode: 'source', record }, frame);
  try {
    const index = reader.readIndex();
    const mirrorPath = String(reader.db.prepare('PRAGMA database_list').all().find(row => row.name === 'child')!.file);
    let backupPath: string | undefined;
    if (mode === 'reader-backup') {
      backupPath = join(dirname(recordPath), `reader-backup-${process.pid}.sqlite`);
      await backup(reader.db, backupPath, { source: 'child' });
      // Check the retained immutable handle again after the actual SQLite
      // backup, without reopening the anonymous source copy by pathname.
      if (JSON.stringify(reader.readIndex()) !== JSON.stringify(index)) throw new Error('Held reader changed after backup');
    }
    ready = { stage: `${mode}-ready`, mirrorPath, mirrorDirectory: dirname(dirname(mirrorPath)), documentIds: index.documentIds, complete: index.complete, stats: frame.stats(), ...(backupPath ? { backupPath } : {}) };
  } catch (error) { reader.close(); throw error; }
  close = () => reader.close();
  // Keep the actual SQLite handles reachable without extending or reasserting
  // the read frame's validity while the parent controls the crash handshake.
  keepAlive = () => { reader.db.prepare('SELECT 1 AS reachable').get(); };
} else if (mode === 'owner-only') {
  const owner = new DatabaseSync(record.binding.physical.owner.path, { timeout: 0 });
  owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  close = () => owner.close();
  keepAlive = () => { owner.prepare('SELECT 1 AS reachable').get(); };
  ready = { stage: 'owner-only-ready' };
} else {
  const store = new SqliteStore(record.binding.physical.database.path);
  if (mode === 'writer-hot') store.putSessionDocument(record.binding.child.sessionId, 'owner.crash_probe', 0, { note: 'Authored temporary writer WAL observation' });
  close = () => store.closeAsync();
  keepAlive = () => { store.getRun(record.binding.child.runId!); };
  ready = { stage: `${mode}-ready` };
}
const timer = setInterval(keepAlive, 250);
process.on('message', async message => {
  if (message !== 'close') return;
  clearInterval(timer);
  try { await close(); process.send?.({ stage: 'closed' }, () => process.disconnect?.()); }
  catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.(); }
});
process.send?.(ready);
