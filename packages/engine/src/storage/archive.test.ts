import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { getRecoveryStatus, readRecoveryAcknowledgments, recoverEngine } from '../recovery/index.js';
import { ReviewJournal } from '../review/audit.js';
import { SqliteStore } from './index.js';
import { DB_VERSION } from './migrations.js';
import { exportEngineArchive, importEngineArchive, validateEngineArchive } from './archive.js';
import { restoreV1Fixture } from './fixtures/v1-fixture.js';
import { V1_DATABASE_FIXTURE } from './fixtures/v1-database.js';
import { ImageAttachmentStore } from '../media/store.js';
import { png } from '../media/fixtures.js';

const code = (value: string) => (error: unknown) => error instanceof EngineError && error.code === value;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-engine-archive-'))), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts'), destination = join(directory, 'archive');
  mkdirSync(artifactDir, { mode: 0o700 }); restoreV1Fixture(dbPath, directory);
  mkdirSync(join(artifactDir, 'nested')); writeFileSync(join(artifactDir, 'nested', 'result.bin'), Buffer.from([0, 255, 128, 13]));
  const stores: SqliteStore[] = [];
  t.after(async () => { for (const store of stores) await store.closeAsync(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, artifactDir, destination, stores, source: { dbPath, artifactDir, destination } };
}
const rows = (path: string, table: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); } finally { db.close(); } };
test('input image bytes and owner metadata survive offline archive without rebinding session ownership',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);
  const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId);
  const media=new ImageAttachmentStore({directory:join(f.artifactDir,'input-media'),documents:store});
  const bytes=png(),ref=await media.import(run.sessionId,bytes,'image/png');
  store.createSession({id:'other-image-session',workspaceId:run.workspaceId,title:'Other',createdAt:new Date().toISOString()});
  store.close();
  const archive=await exportEngineArchive(f.source);
  assert.ok(archive.manifest.artifacts.some(file=>file.file===`artifacts/input-media/${ref.id}.blob`));
  const imported=await importEngineArchive({directory:f.destination,destination:join(f.directory,'imported-images')});
  const restored=new SqliteStore(imported.dbPath);f.stores.push(restored);
  const resolved=new ImageAttachmentStore({directory:join(imported.artifactDir,'input-media'),documents:restored});
  assert.deepEqual(Buffer.from((await resolved.resolve(run.sessionId,[ref]))[0]!.data,'base64'),bytes);
  await assert.rejects(resolved.resolve('other-image-session',[ref]),code('RECORD_SCOPE_MISMATCH'));
});
async function killAtBoundary(t: TestContext, f: ReturnType<typeof fixture>, mode: 'export' | 'import', source: string, destination: string, phase: 'staging' | 'publish'): Promise<void> {
  const scratch = join(f.directory, `scratch-${mode}`); mkdirSync(scratch);
  const sourceMode = import.meta.url.endsWith('.ts');
  const childPath = fileURLToPath(new URL(`./fixtures/archive-child.${sourceMode ? 'ts' : 'js'}`, import.meta.url));
  const child = spawn(process.execPath, [...(sourceMode ? ['--import', 'tsx'] : []), childPath, mode, source, destination, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, TMPDIR: scratch } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let errors = ''; child.stderr?.on('data', value => { errors = (errors + String(value)).slice(-4096); });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const stopped = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Archive child did not reach ${phase}: ${errors}`)), 10_000);
    child.once('message', value => { clearTimeout(timeout); assert.equal((value as { phase: string }).phase, phase); resolve(); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Archive child exited before ${phase}: ${errors}`)); });
  });
  await stopped; child.kill('SIGKILL'); await closed;
}

test('whole archive preserves v1 primary/review/ledger/artifacts, verifies hashes and imports with migration and paused sessions', async t => {
  const f = fixture(t), originalEvents = rows(f.dbPath, 'events'), originalReview = rows(f.dbPath + '.review.sqlite', 'review_operations'), originalLedger = rows(f.dbPath + '.recovery.sqlite', 'recovery_audit');
  const terminalPath = join(f.artifactDir, 'terminals.sqlite'), terminal = new DatabaseSync(terminalPath);
  terminal.exec("PRAGMA journal_mode=DELETE; CREATE TABLE terminal_fixture(id TEXT PRIMARY KEY, state TEXT NOT NULL); INSERT INTO terminal_fixture VALUES('terminal','interrupted'); PRAGMA user_version=1"); terminal.close();
  const terminalBytes = readFileSync(terminalPath);
  const archive = await exportEngineArchive(f.source);
  assert.deepEqual(archive.manifest.databases.map(item => item.role), ['primary', 'review', 'ledger']);
  assert.equal(archive.manifest.databases[0]?.schemaVersion, 1);
  assert.equal(archive.manifest.recoveryAcknowledgmentsRebound, false);
  assert.deepEqual(validateEngineArchive({ directory: f.destination }).manifest, archive.manifest);
  assert.deepEqual(rows(f.dbPath, 'events'), originalEvents, 'Export does not migrate or modify the source');
  const imported = await importEngineArchive({ directory: f.destination, destination: join(f.directory, 'imported') });
  assert.equal(imported.migratedFromVersion, 1); assert.equal(imported.schemaVersion, DB_VERSION);
  assert.equal(imported.executionResumed, false);
  assert.deepEqual(rows(imported.dbPath, 'events'), originalEvents);
  assert.deepEqual(rows(imported.dbPath + '.review.sqlite', 'review_operations'), originalReview);
  assert.deepEqual(rows(imported.dbPath + '.recovery.sqlite', 'recovery_audit'), originalLedger);
  assert.deepEqual(readFileSync(join(imported.artifactDir, 'nested', 'result.bin')), Buffer.from([0, 255, 128, 13]));
  assert.deepEqual(readFileSync(join(imported.artifactDir, 'terminals.sqlite')), terminalBytes, 'Closed DELETE-mode terminal journals remain opaque bytes, not a rewritten engine schema');
  const store = new SqliteStore(imported.dbPath); f.stores.push(store);
  assert.equal(store.getSessionControl(V1_DATABASE_FIXTURE.ids.sessionId).reason, 'recovery_required');
  assert.equal(store.getSessionControl(V1_DATABASE_FIXTURE.ids.sessionId).paused, true);
  assert.equal(store.integrityCheck().ok, true);
  assert.deepEqual(imported.artifactPathMapping, { from: f.artifactDir, to: imported.artifactDir });
});

test('an actual source recovery acknowledgement is kept verbatim and never grants a copied file authority', async t => {
  const f = fixture(t), journal = new ReviewJournal(f.dbPath + '.review.sqlite');
  journal.recoverPending(); journal.close();
  const status = await getRecoveryStatus(f.source);
  await recoverEngine({ ...f.source, fingerprint: status.fingerprint!, acknowledged: true });
  const original = readRecoveryAcknowledgments(f.source);
  assert.equal(original.length, 2);
  const ledger = rows(f.dbPath + '.recovery.sqlite', 'recovery_audit');
  const archive = await exportEngineArchive(f.source);
  const actualAudit = JSON.parse(String(ledger.at(-1)!.data));
  assert.equal(archive.manifest.source.bindingScope, actualAudit.scope);
  const imported = await importEngineArchive({ directory: f.destination, destination: join(f.directory, 'imported') });
  assert.deepEqual(rows(imported.dbPath + '.recovery.sqlite', 'recovery_audit'), ledger);
  assert.deepEqual(readRecoveryAcknowledgments(imported), [], 'New DB/review/artifact inode identities cannot reuse the original scope');
  assert.deepEqual(readRecoveryAcknowledgments(f.source), original);
});

test('native inbox, dispatched attempts, durable Part prefixes and stopped effect records survive export/import', async t => {
  const f = fixture(t), store = new SqliteStore(f.dbPath); f.stores.push(store);
  const run = store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId), now = new Date().toISOString();
  const accepted = store.acceptInput({ sessionId: run.sessionId, requestId: 'archive-pending', prompt: 'wait for recovery', config: run.config, delivery: 'queue' });
  const turn = { schemaVersion: 2 as const, id: 'archive-turn', sessionId: run.sessionId, runId: run.id, index: 0, inputIds: [run.inputId], state: 'created' as const, createdAt: now };
  store.putTurn(turn);
  const attempt = { schemaVersion: 2 as const, id: 'archive-attempt', sessionId: run.sessionId, runId: run.id, turnId: turn.id, index: 0, providerId: run.config.providerId, modelId: run.config.modelId, state: 'prepared' as const, createdAt: now };
  store.putAttempt(attempt); store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: now });
  const usage=store.putAttemptUsage(attempt.id,{inputTokens:23,outputTokens:2});
  store.putPart({ schemaVersion: 2, id: 'archive-part', sessionId: run.sessionId, runId: run.id, turnId: turn.id, messageId: 'archive-message', index: 0, revision: 0, state: 'open', type: 'text', text: 'durable prefix', createdAt: now });
  const nativeEvents = store.readSessionEvents(run.sessionId, 0); store.close();
  const effect = new DatabaseSync(f.dbPath + '.effects.sqlite');
  effect.exec('CREATE TABLE command_execution(id INTEGER PRIMARY KEY,owner_pid INTEGER NOT NULL,group_pid INTEGER,active INTEGER NOT NULL,updated_at TEXT NOT NULL) STRICT');
  effect.prepare('INSERT INTO command_execution VALUES(1,?,NULL,0,?)').run(process.pid, now); effect.close();
  const originalEffect = rows(f.dbPath + '.effects.sqlite', 'command_execution');
  const archive = await exportEngineArchive(f.source);
  assert.equal(archive.manifest.databases.find(item => item.role === 'effect')?.schemaVersion, 0);
  const imported = await importEngineArchive({ directory: f.destination, destination: join(f.directory, 'imported') });
  const restored = new SqliteStore(imported.dbPath); f.stores.push(restored);
  assert.equal(restored.getInput(accepted.inputId).state, 'pending');
  assert.equal(restored.getAttempt(attempt.id).state, 'dispatched');
  assert.deepEqual(restored.putAttemptUsage(attempt.id,{inputTokens:23}),usage);
  assert.equal(restored.listParts(turn.id)[0]?.type, 'text');
  assert.deepEqual(restored.readSessionEvents(run.sessionId, 0).slice(0, nativeEvents.length), nativeEvents);
  assert.deepEqual(rows(imported.dbPath + '.effects.sqlite', 'command_execution'), originalEffect);
  assert.throws(() => restored.promoteInput(accepted.inputId), code('SESSION_PAUSED'));
  restored.recoverInterrupted();
  assert.equal(restored.getAttempt(attempt.id).state, 'uncertain');
  assert.equal(restored.getTurn(turn.id).state, 'uncertain');
  assert.equal(restored.listParts(turn.id)[0]?.state, 'interrupted');
});

test('an active effect marker prevents an inconsistent archive and releases owner/source leases', async t => {
  const f = fixture(t), effect = new DatabaseSync(f.dbPath + '.effects.sqlite');
  effect.exec('CREATE TABLE command_execution(id INTEGER PRIMARY KEY,owner_pid INTEGER NOT NULL,group_pid INTEGER,active INTEGER NOT NULL,updated_at TEXT NOT NULL) STRICT');
  effect.prepare('INSERT INTO command_execution VALUES(1,?,NULL,1,?)').run(process.pid, new Date().toISOString()); effect.close();
  await assert.rejects(exportEngineArchive(f.source), code('ARCHIVE_EFFECT_ACTIVE'));
  assert.equal(existsSync(f.destination), false);
  assert.equal(rows(f.dbPath + '.effects.sqlite', 'command_execution')[0]?.active, 1);
  const store = new SqliteStore(f.dbPath); f.stores.push(store);
  assert.equal(store.integrityCheck().ok, true);
});

test('live primary/review owners reject archive admission and release all earlier leases after a later lease fails', async t => {
  const f = fixture(t), journal = new ReviewJournal(f.dbPath + '.review.sqlite');
  await assert.rejects(exportEngineArchive(f.source), code('RECOVERY_OWNER_BUSY'));
  assert.equal(existsSync(f.destination), false);
  const store = new SqliteStore(f.dbPath); f.stores.push(store); store.close();
  journal.close();
  await exportEngineArchive(f.source);
});

test('artifact symlinks fail without a published partial archive and leave the source owner available', async t => {
  const f = fixture(t); symlinkSync(join(f.artifactDir, 'nested', 'result.bin'), join(f.artifactDir, 'alias'));
  await assert.rejects(exportEngineArchive(f.source), code('ARCHIVE_PATH_UNSUPPORTED'));
  assert.equal(existsSync(f.destination), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.moodcode-archive-')), false);
  const store = new SqliteStore(f.dbPath); f.stores.push(store);
  assert.equal(store.integrityCheck().ok, true);
});

test('manifest/member tampering and future schema metadata reject import before creating a destination', async t => {
  const f = fixture(t); await exportEngineArchive(f.source);
  const member = join(f.destination, 'data', 'artifacts', 'nested', 'result.bin');
  writeFileSync(member, 'changed');
  await assert.rejects(importEngineArchive({ directory: f.destination, destination: join(f.directory, 'bad-import') }), code('ARCHIVE_HASH_MISMATCH'));
  assert.equal(existsSync(join(f.directory, 'bad-import')), false);
  writeFileSync(member, Buffer.from([0, 255, 128, 13]));
  const path = join(f.destination, 'data', 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.databases[0].schemaVersion = DB_VERSION + 1; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => validateEngineArchive({ directory: f.destination }), code('DB_VERSION_UNSUPPORTED'));
  manifest.databases[0].schemaVersion = 1; manifest.artifacts[0].file = '../foreign'; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => validateEngineArchive({ directory: f.destination }), code('ARCHIVE_MANIFEST_INVALID'));
});

test('archive/import cancellation and existing destinations preserve source data and competing content', async t => {
  const f = fixture(t), events = rows(f.dbPath, 'events');
  await assert.rejects(exportEngineArchive({ ...f.source, signal: AbortSignal.abort() }), code('ARCHIVE_ABORTED'));
  assert.equal(existsSync(f.destination), false);
  const controller = new AbortController(), pending = exportEngineArchive({ ...f.source, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, code('ARCHIVE_ABORTED'));
  assert.equal(existsSync(f.destination), false);
  assert.deepEqual(rows(f.dbPath, 'events'), events);
  await exportEngineArchive(f.source);
  const destination = join(f.directory, 'kept'); mkdirSync(destination); writeFileSync(join(destination, 'user.txt'), 'keep');
  await assert.rejects(importEngineArchive({ directory: f.destination, destination }), code('ARCHIVE_DESTINATION_EXISTS'));
  assert.equal(readFileSync(join(destination, 'user.txt'), 'utf8'), 'keep');
  await assert.rejects(importEngineArchive({ directory: f.destination, destination: join(f.directory, 'cancelled-import'), signal: AbortSignal.abort() }), code('ARCHIVE_ABORTED'));
  assert.equal(existsSync(join(f.directory, 'cancelled-import')), false);
});

test('SIGKILL during export releases database leases and never publishes a partial payload', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), originalEvents = rows(f.dbPath, 'events');
  await killAtBoundary(t, f, 'export', f.directory, f.destination, 'staging');
  assert.equal(existsSync(f.destination), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.moodcode-archive-')), true, 'The private incomplete staging tree is retained for explicit cleanup');
  assert.deepEqual(rows(f.dbPath, 'events'), originalEvents);
  const store = new SqliteStore(f.dbPath); f.stores.push(store); store.close();
  await exportEngineArchive(f.source);
  assert.equal(validateEngineArchive({ directory: f.destination }).manifest.archiveVersion, 1);
});

test('SIGKILL before import publication leaves an invalid empty container and retrying into a new bundle succeeds', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); await exportEngineArchive(f.source);
  const destination = join(f.directory, 'interrupted-import');
  await killAtBoundary(t, f, 'import', f.destination, destination, 'publish');
  assert.deepEqual(readdirSync(destination), []);
  assert.throws(() => validateEngineArchive({ directory: destination }));
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.moodcode-import-')), true);
  const imported = await importEngineArchive({ directory: f.destination, destination: join(f.directory, 'retry-import') });
  const store = new SqliteStore(imported.dbPath); f.stores.push(store);
  assert.equal(store.integrityCheck().ok, true);
  assert.equal(store.getSessionControl(V1_DATABASE_FIXTURE.ids.sessionId).paused, true);
});

test('PDF indexes and blobs survive archive with stable owner refs and new physical recovery binding',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId);
  const {DocumentAttachmentStore}=await import('../documents/store.js'),bytes=Buffer.from('%PDF-2.0\nArchived opaque bytes\n');
  const documents=new DocumentAttachmentStore({directory:join(f.artifactDir,'input-documents'),documents:store}),ref=await documents.import(run.sessionId,bytes);
  const before=store.getSessionDocument(run.sessionId,'input_documents');store.createSession({id:'foreign-document-session',workspaceId:run.workspaceId,title:'Foreign',createdAt:new Date().toISOString()});store.close();
  const writer=new DatabaseSync(f.dbPath);try {
    const original=writer.prepare('SELECT data FROM runs WHERE id=?').get(run.id)!;
    writer.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(original.data)),documents:[ref]}),run.id);
    const originalInput=writer.prepare('SELECT data FROM inputs WHERE id=?').get(run.inputId)!;
    writer.prepare('UPDATE inputs SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(originalInput.data)),documents:[ref]}),run.inputId);
    writer.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)').run('archived-document-message',run.sessionId,run.id,JSON.stringify({id:'archived-document-message',sessionId:run.sessionId,runId:run.id,role:'user',content:'Read PDF',createdAt:new Date().toISOString(),documents:[ref]}));
  } finally {writer.close();}
  const archived=await exportEngineArchive(f.source);assert.ok(archived.manifest.artifacts.some(item=>item.file===`artifacts/input-documents/${ref.id}.blob`));assert.equal(archived.manifest.recoveryAcknowledgmentsRebound,false);
  validateEngineArchive({directory:f.destination});const imported=await importEngineArchive({directory:f.destination,destination:join(f.directory,'imported-documents')});const restored=new SqliteStore(imported.dbPath);f.stores.push(restored);
  assert.deepEqual(restored.getSessionDocument(run.sessionId,'input_documents'),before);const resolver=new DocumentAttachmentStore({directory:join(imported.artifactDir,'input-documents'),documents:restored});assert.deepEqual(Buffer.from((await resolver.resolve(run.sessionId,[ref]))[0]!.data,'base64'),bytes);await assert.rejects(resolver.resolve('foreign-document-session',[ref]),code('RECORD_SCOPE_MISMATCH'));
  assert.equal(imported.executionResumed,false);assert.equal(restored.getSessionControl(run.sessionId).paused,true);assert.deepEqual(readRecoveryAcknowledgments(imported),[]);
});
test('archive refuses corrupted indexed PDF bytes before publishing a destination',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId),{DocumentAttachmentStore}=await import('../documents/store.js');const bytes=Buffer.from('%PDF-1.7\nprivate bytes\n'),ref=await new DocumentAttachmentStore({directory:join(f.artifactDir,'input-documents'),documents:store}).import(run.sessionId,bytes);store.close();
  const corrupt=Buffer.from(bytes);corrupt[12]=42;writeFileSync(join(f.artifactDir,'input-documents',ref.id+'.blob'),corrupt);await assert.rejects(exportEngineArchive(f.source),code('ARCHIVE_DOCUMENT_INTEGRITY_FAILED'));assert.equal(existsSync(f.destination),false);
});
test('archive rejects input document refs owned by a different session even when files and manifest hashes match',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId),{DocumentAttachmentStore}=await import('../documents/store.js');const ref=await new DocumentAttachmentStore({directory:join(f.artifactDir,'input-documents'),documents:store}).import(run.sessionId,Buffer.from('%PDF-1.7\nopaque\n'));
  const other=store.createSession({id:'other-document-session',workspaceId:run.workspaceId,title:'Other',createdAt:new Date().toISOString()});store.close();const writer=new DatabaseSync(f.dbPath);
  try {writer.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)').run('forged-document-message',other.id,run.id,JSON.stringify({id:'forged-document-message',sessionId:other.id,runId:run.id,role:'user',content:'text',createdAt:new Date().toISOString(),documents:[ref]}));} finally {writer.close();}
  await assert.rejects(exportEngineArchive(f.source),code('ARCHIVE_DOCUMENT_REFERENCE_INVALID'));assert.equal(existsSync(f.destination),false);
});
test('archive rejects cross-owner PDF index payload without rewriting archived engine history',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId),{DocumentAttachmentStore}=await import('../documents/store.js');await new DocumentAttachmentStore({directory:join(f.artifactDir,'input-documents'),documents:store}).import(run.sessionId,Buffer.from('%PDF-1.7\nopaque\n'));
  const doc=store.getSessionDocument(run.sessionId,'input_documents')!;store.putSessionDocument(run.sessionId,'input_documents',doc.revision,{...doc.data,owner:{sessionId:'different-owner',workspaceId:run.workspaceId,workspaceRoot:f.directory}});store.close();const originalEvents=rows(f.dbPath,'events');await assert.rejects(exportEngineArchive(f.source),code('ARCHIVE_DOCUMENT_INDEX_INVALID'));assert.deepEqual(rows(f.dbPath,'events'),originalEvents);assert.equal(existsSync(f.destination),false);
});

 test('archive rejects total indexed PDF bytes above its budget before opening any blob',async t=>{
  const f=fixture(t),store=new SqliteStore(f.dbPath);f.stores.push(store);const run=store.getRun(V1_DATABASE_FIXTURE.ids.activeRunId),workspace=store.getWorkspace(run.workspaceId);
  for(let s=0;s<33;s++){
    const session=store.createSession({id:'archive-document-cap-'+s,workspaceId:run.workspaceId,title:'bounded',createdAt:new Date().toISOString()});
    const documents=Array.from({length:32},(_,i)=>({id:'doc_'+(s*32+i).toString(16).padStart(32,'0'),kind:'document',mimeType:'application/pdf',bytes:524288,sha256:'a'.repeat(64)}));
    store.putSessionDocument(session.id,'input_documents',0,{version:1,owner:{sessionId:session.id,workspaceId:workspace.id,workspaceRoot:workspace.root},documents});
  }
  store.close();await assert.rejects(exportEngineArchive(f.source),code('ARCHIVE_FILE_LIMIT'));assert.equal(existsSync(f.destination),false);assert.equal(existsSync(join(f.artifactDir,'input-documents')),false);
});
