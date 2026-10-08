import { knowledgeHash } from '../knowledge/validation.js';
import { validateResidentRecord } from '../child-tasks/resident.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import { CHILD_STORAGE_MIRROR_KIND, validateChildStorageRecord, type ChildStoragePhysicalIdentity, type ChildStorageRecord } from '../child-tasks/storage-binding.js';
import { inspectInputDocumentIndex, type InputDocumentIndexReport } from './input-document-index.js';
import { DB_VERSION } from './migrations.js';

export const CHILD_DOCUMENT_READ_LIMITS = Object.freeze({ maxMetadataBytes: 8_388_608, maxRefs: 2048, maxRows: 8192, maxChildren: 64, maxDatabaseBytes: 33_554_432, maxMirrorBytes: 268_435_456, maxDurationMs: 2000 });
export type ChildDocumentReadLimits = { [K in keyof typeof CHILD_DOCUMENT_READ_LIMITS]: number };
export const MAX_ARCHIVE_DOCUMENT_BUDGET_MS = 30_000;
const archiveFrameScope = Symbol('archive-document-budget');
export function validateArchiveDocumentBudgetMs(value: unknown): number {
  if (value === undefined) return CHILD_DOCUMENT_READ_LIMITS.maxDurationMs;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ARCHIVE_DOCUMENT_BUDGET_MS
  )
    throw new EngineError(
      'INVALID_ARCHIVE_DOCUMENT_BUDGET',
      'Archive document budget must be an integer from 1 to 30000 milliseconds.',
    );
  return value;
}
function fail(code: string): never { throw new EngineError(code, 'Child document inspection could not verify its bounded read-only scope.'); }
function plain(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (types.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
  return value as Record<string, unknown>;
}
export interface ChildDocumentReadStats { selectedMetadataBytes: number; selectedRefs: number; selectedRows: number; openedChildren: number; rawMirrorBytes: number; elapsedMs: number; exhaustedReason: string | null }
/** One operation-wide budget. Counters are observations, not physical I/O measurements. */
export class ChildDocumentReadFrame {
  readonly limits: ChildDocumentReadLimits;
  readonly signal?: AbortSignal;
  private readonly start = performance.now();
  private metadata = 0; private refs = 0; private rows = 0; private children = 0; private mirrors = 0; private exhausted: string | null = null;
  constructor(value: { signal?: AbortSignal; limits?: Partial<ChildDocumentReadLimits> } = {}, archiveScope?: typeof archiveFrameScope) {
    if (archiveScope !== undefined && archiveScope !== archiveFrameScope) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
    const options = plain(value, ['signal', 'limits']);
    if (types.isProxy(options.signal) || options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
    const limits = options.limits === undefined ? {} : plain(options.limits, Object.keys(CHILD_DOCUMENT_READ_LIMITS));
    const selected = { ...CHILD_DOCUMENT_READ_LIMITS, ...limits };
    for (const key of Object.keys(CHILD_DOCUMENT_READ_LIMITS) as (keyof ChildDocumentReadLimits)[]) if (!Number.isSafeInteger(selected[key]) || selected[key] < 1 || selected[key] > (key === 'maxDurationMs' && archiveScope === archiveFrameScope ? MAX_ARCHIVE_DOCUMENT_BUDGET_MS : CHILD_DOCUMENT_READ_LIMITS[key])) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
    this.limits = Object.freeze(selected) as ChildDocumentReadLimits; this.signal = options.signal as AbortSignal | undefined;
  }
  private stop(code: string): never { this.exhausted ??= code; return fail(code); }
  check = (): void => {
    if (this.exhausted) fail(this.exhausted);
    if (this.signal?.aborted) this.stop('CHILD_DOCUMENT_STORAGE_ABORTED');
    if (performance.now() - this.start >= this.limits.maxDurationMs) this.stop('CHILD_DOCUMENT_STORAGE_TIME_LIMIT');
  };
  private amount(value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS'); this.check(); }
  charge = (bytes: number): void => { this.amount(bytes); if (bytes > this.remainingMetadataBytes) this.stop('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'); this.metadata += bytes; };
  chargeRefs = (count: number): void => { this.amount(count); if (count > this.remainingRefs) this.stop('CHILD_DOCUMENT_STORAGE_REFERENCE_LIMIT'); this.refs += count; };
  chargeRows = (count: number): void => { this.amount(count); if (count > this.limits.maxRows - this.rows) this.stop('CHILD_DOCUMENT_STORAGE_ROW_LIMIT'); this.rows += count; };
  chargeMirror = (bytes: number): void => { this.amount(bytes); if (bytes > this.limits.maxMirrorBytes - this.mirrors) this.stop('CHILD_DOCUMENT_STORAGE_MIRROR_LIMIT'); this.mirrors += bytes; };
  chargeChild = (): void => { this.check(); if (this.children >= this.limits.maxChildren) this.stop('CHILD_DOCUMENT_STORAGE_CHILD_LIMIT'); this.children++; };
  chargeIndex = (index: InputDocumentIndexReport): void => { this.charge(index.sampledJsonBytes); this.chargeRefs(index.refs.length); this.chargeRows(index.sampledDocuments * 3); };
  get remainingMetadataBytes(): number { return this.limits.maxMetadataBytes - this.metadata; }
  get remainingRefs(): number { return this.limits.maxRefs - this.refs; }
  get remainingRows(): number { return this.limits.maxRows - this.rows; }
  stats(): ChildDocumentReadStats { return { selectedMetadataBytes: this.metadata, selectedRefs: this.refs, selectedRows: this.rows, openedChildren: this.children, rawMirrorBytes: this.mirrors, elapsedMs: performance.now() - this.start, exhaustedReason: this.exhausted }; }
}
export function createChildDocumentReadFrame(value?: ConstructorParameters<typeof ChildDocumentReadFrame>[0]): ChildDocumentReadFrame { return new ChildDocumentReadFrame(value); }
/** Archive callers may select a longer document proof deadline; inspector ceilings remain unchanged. */
export function createArchiveDocumentReadFrame(
  value: { signal?: AbortSignal; archiveDocumentBudgetMs?: number } = {},
): ChildDocumentReadFrame {
  const options = plain(value, ['signal', 'archiveDocumentBudgetMs']);
  return new ChildDocumentReadFrame(
    {
      signal: options.signal as AbortSignal | undefined,
      limits: {
        maxDurationMs: validateArchiveDocumentBudgetMs(
          options.archiveDocumentBudgetMs,
        ),
      },
    },
    archiveFrameScope,
  );
}
export interface ChildArchiveMember { file: string; bytes: number; sha256: string }
export interface ChildDocumentHistoricalFiles { database: { path: string; bytes: number; sha256: string }; artifacts: { path: string }; allowedMembers: readonly ChildArchiveMember[]; artifactPrefix: string }
export type ChildDocumentReaderInput = { mode: 'source'; record: ChildStorageRecord } | { mode: 'archive-historical'; record: ChildStorageRecord; archive: ChildDocumentHistoricalFiles };
export interface ChildDocumentReader { db: DatabaseSync; sourceName: 'child'; schemaVersion: number; artifactPath: string; check(): void; readIndex(): InputDocumentIndexReport; close(): void }
export interface ChildDocumentIndexObservation { status: 'observed' | 'unchecked'; reasons: string[]; index?: InputDocumentIndexReport }
interface PinnedPath { path: string; stat: BigIntStats }
function equalIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function stableFile(a: BigIntStats, b: BigIntStats): boolean { return b.isFile() && !b.isSymbolicLink() && equalIdentity(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink; }
function safePath(path: string): PinnedPath[] {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path.includes('\0') || Buffer.byteLength(path) > 8192) fail('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH');
  let current = parse(path).root; const pins: PinnedPath[] = [];
  for (const part of ['', ...path.slice(current.length).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) fail('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH');
    pins.push({ path: current, stat });
  }
  if (realpathSync(path) !== path) fail('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH');
  return pins;
}
function pinned(path: string, identity: ChildStoragePhysicalIdentity | undefined, directory: boolean): PinnedPath[] {
  const pins = safePath(path), last = pins.at(-1)!;
  if (directory ? !last.stat.isDirectory() : !last.stat.isFile() || last.stat.nlink !== 1n) fail('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH');
  if (identity && (identity.path !== path || identity.dev !== String(last.stat.dev) || identity.ino !== String(last.stat.ino))) fail('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED');
  return pins;
}
function checkPins(pins: readonly PinnedPath[]): void {
  for (const pin of pins) { const current = lstatSync(pin.path, { bigint: true }); if (!equalIdentity(pin.stat,current) || current.isSymbolicLink() || pin.stat.isDirectory() && !current.isDirectory()) fail('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED'); }
}
function noSidecars(path: string): void { for (const suffix of ['-wal','-shm','-journal']) if (lstatSync(path + suffix, { throwIfNoEntry: false })) fail('CHILD_DOCUMENT_STORAGE_HOT_DATABASE'); }
function header(path: string, expected: BigIntStats, owner: boolean, limit: number): void {
  if (expected.size > BigInt(limit) || !owner && expected.size < 100n) fail('CHILD_DOCUMENT_STORAGE_DATABASE_LIMIT');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true }); if (!stableFile(expected,opened)) fail('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED');
    if (owner && opened.size === 0n) return;
    const buffer = Buffer.alloc(100); if (readSync(fd,buffer,0,buffer.length,0) !== 100 || !buffer.subarray(0,16).equals(Buffer.from('SQLite format 3\0')) || ![1,2].includes(buffer[18]!) || buffer[18] !== buffer[19] || owner && buffer[18] !== 1) fail('CHILD_DOCUMENT_STORAGE_INVALID_DATABASE');
    if (!stableFile(expected,fstatSync(fd,{bigint:true}))) fail('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED');
  } finally { closeSync(fd); }
}
function archiveFiles(value: ChildDocumentHistoricalFiles): ChildDocumentHistoricalFiles {
  const object = plain(value,['database','artifacts','allowedMembers','artifactPrefix']), database = plain(object.database,['path','bytes','sha256']), artifacts = plain(object.artifacts,['path']);
  if (typeof database.path !== 'string' || typeof artifacts.path !== 'string' || !Number.isSafeInteger(database.bytes) || Number(database.bytes) < 100 || typeof database.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(database.sha256)
    || typeof object.artifactPrefix !== 'string' || object.artifactPrefix.length > 4096 || object.artifactPrefix.includes('\\') || object.artifactPrefix.split('/').some(part => !part || part === '.' || part === '..')
    || types.isProxy(object.allowedMembers) || !Array.isArray(object.allowedMembers) || Object.getPrototypeOf(object.allowedMembers) !== Array.prototype || object.allowedMembers.length > 4096 || Reflect.ownKeys(object.allowedMembers).length !== object.allowedMembers.length + 1) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID');
  const names = new Set<string>();
  for (let i=0;i<object.allowedMembers.length;i++) { const descriptor=Object.getOwnPropertyDescriptor(object.allowedMembers,String(i)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID'); const item = plain(descriptor.value,['file','bytes','sha256']); if (typeof item.file !== 'string' || names.has(item.file) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256) || !item.file.startsWith(String(object.artifactPrefix).replace(/\/artifacts$/u,'') + '/')) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID'); names.add(item.file); }
  const databaseMember = object.allowedMembers.find((member: ChildArchiveMember) => member.file === String(object.artifactPrefix).replace(/\/artifacts$/u,'') + '/engine.sqlite');
  if (!databaseMember || databaseMember.bytes !== database.bytes || databaseMember.sha256 !== database.sha256 || basename(String(database.path)) !== 'engine.sqlite' || basename(String(artifacts.path)) !== 'artifacts' || dirname(String(database.path)) !== dirname(String(artifacts.path))) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID');
  return structuredClone(value);
}

/** Held source-owner lease plus private immutable DB mirror. No source DB is opened by SQLite. */
function openReader(value: ChildDocumentReaderInput, frame: ChildDocumentReadFrame): ChildDocumentReader {
  plain(value,['mode','record','archive']); frame.check();
  if (value.mode === 'source' && Object.hasOwn(value,'archive')) fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
  if (frame.remainingMetadataBytes === 0 || frame.remainingRefs === 0) fail('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT');
  if (frame.remainingRows < 3) fail('CHILD_DOCUMENT_STORAGE_ROW_LIMIT');
  const record = validateChildStorageRecord(value.record), binding = record.binding;
  if (binding.phase !== 'admitted' || !record.confirmedClose || !binding.child.runId) fail('CHILD_DOCUMENT_STORAGE_CLOSE_UNCONFIRMED');
  if (value.mode !== 'source' && value.mode !== 'archive-historical') fail('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS');
  const archive = value.mode === 'archive-historical' ? archiveFiles(value.archive) : undefined;
  if (archive && archive.artifactPrefix !== `artifacts/children/${binding.lineage.taskId}/artifacts`) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID');
  const databasePath = archive?.database.path ?? binding.physical.database.path, artifactPath = archive?.artifacts.path ?? binding.physical.artifacts.path;
  const databasePins = pinned(databasePath, archive ? undefined : binding.physical.database, false), artifactPins = pinned(artifactPath, archive ? undefined : binding.physical.artifacts, true), initial = databasePins.at(-1)!.stat;
  noSidecars(databasePath); header(databasePath,initial,false,frame.limits.maxDatabaseBytes);
  let owner: DatabaseSync | undefined, db: DatabaseSync | undefined, temporary: string | undefined, closed = false;
  let ownerPins: PinnedPath[] = [];
  const check = (): void => {
    if (closed) fail('CHILD_DOCUMENT_STORAGE_READER_CLOSED'); frame.check(); checkPins([...databasePins,...artifactPins,...ownerPins]); noSidecars(databasePath);
    if (!stableFile(initial,lstatSync(databasePath,{bigint:true}))) fail('CHILD_DOCUMENT_STORAGE_SOURCE_CHANGED');
    if (!archive) { noSidecars(binding.physical.owner.path); if (!stableFile(ownerPins.at(-1)!.stat,lstatSync(binding.physical.owner.path,{bigint:true}))) fail('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED'); }
  };
  const close = (): void => {
    if (closed) return; closed = true; const errors: unknown[] = [];
    try { db?.close(); } catch (error) { errors.push(error); }
    try { owner?.close(); } catch (error) { errors.push(error); }
    try { if (temporary) rmSync(temporary,{recursive:true,force:true}); } catch (error) { errors.push(error); }
    if (errors.length) fail('CHILD_DOCUMENT_STORAGE_READER_CLEANUP_FAILED');
  };
  try {
    if (!archive) {
      ownerPins = pinned(binding.physical.owner.path,binding.physical.owner,false); noSidecars(binding.physical.owner.path); header(binding.physical.owner.path,ownerPins.at(-1)!.stat,true,1_048_576);
      owner = new DatabaseSync(binding.physical.owner.path,{readOnly:true,timeout:0}); owner.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN'); owner.prepare('SELECT count(*) AS tables FROM sqlite_schema').get();
    }
    check(); frame.chargeChild(); frame.chargeMirror(Number(initial.size));
    temporary = realpathSync(mkdtempSync(join(tmpdir(),'moodcode-child-document-reader-'))); mkdirSync(join(temporary,'data'),{mode:0o700});
    const mirror = join(temporary,'data','engine.sqlite'), input = openSync(databasePath,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); let output: number | undefined;
    try {
      if (!stableFile(initial,fstatSync(input,{bigint:true}))) fail('CHILD_DOCUMENT_STORAGE_SOURCE_CHANGED');
      output = openSync(mirror,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),0o600);
      const buffer = Buffer.allocUnsafe(262_144), hash = createHash('sha256'); let position = 0;
      while (position < Number(initial.size)) { check(); const count = readSync(input,buffer,0,Math.min(buffer.length,Number(initial.size)-position),position); if (!count) fail('CHILD_DOCUMENT_STORAGE_SOURCE_CHANGED'); hash.update(buffer.subarray(0,count)); for (let wrote=0;wrote<count;) { const countWritten = writeSync(output,buffer,wrote,count-wrote); if (!countWritten) fail('CHILD_DOCUMENT_STORAGE_SOURCE_CHANGED'); wrote += countWritten; } position += count; }
      if (!stableFile(initial,fstatSync(input,{bigint:true}))) fail('CHILD_DOCUMENT_STORAGE_SOURCE_CHANGED');
      if (archive && (archive.database.bytes !== position || archive.database.sha256 !== hash.digest('hex'))) fail('CHILD_DOCUMENT_STORAGE_ARCHIVE_HASH_MISMATCH');
    } finally { if (output !== undefined) closeSync(output); closeSync(input); }
    check(); db = new DatabaseSync(':memory:',{timeout:0}); db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON'); const uri = pathToFileURL(mirror); uri.search='?mode=ro&immutable=1'; db.prepare('ATTACH DATABASE ? AS child').run(uri.href); db.exec('BEGIN');
    frame.chargeRows(1);
    const version = Number(db.prepare('PRAGMA child.user_version').get()?.user_version); if (!Number.isSafeInteger(version) || version < 2 || version > DB_VERSION) fail('CHILD_DOCUMENT_STORAGE_UNSUPPORTED_SCHEMA');
    frame.chargeRows(4);
    const schema = db.prepare("SELECT name,type,coalesce(sql LIKE 'CREATE VIRTUAL TABLE%',1) AS virtual FROM child.sqlite_schema WHERE name IN ('runs','sessions','workspaces','session_documents') LIMIT 5").all();
    if (schema.length !== 4 || schema.some(row=>row.type!=='table'||row.virtual!==0)) fail('CHILD_DOCUMENT_STORAGE_INVALID_DATABASE');
    frame.chargeRows(1);
    const counts = db.prepare('SELECT (SELECT count(*) FROM child.runs) AS runs,(SELECT count(*) FROM child.runs) BETWEEN 1 AND 32 AND (SELECT count(*) FROM child.sessions)=1 AND (SELECT count(*) FROM child.workspaces)=1 AS valid').get();
    if (counts?.valid!==1) fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');
    if(Number(counts.runs)>1){
      frame.chargeRows(1);const retained=db.prepare("SELECT data FROM child.session_documents WHERE session_id=? AND kind='engine.resident_child' AND length(CAST(data AS BLOB))<=65536").get(binding.child.sessionId);if(!retained)fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');
      const resident=validateResidentRecord(JSON.parse(String(retained.data)));if(resident.taskId!==binding.lineage.taskId||resident.initialRunId!==binding.child.runId||resident.childSessionId!==binding.child.sessionId||resident.storageSha256!==record.sha256||resident.runs.length!==Number(counts.runs))fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');
      for(const run of resident.runs){frame.check();frame.chargeRows(1);const row=db.prepare("SELECT id,session_id,workspace_id,state,data FROM child.runs WHERE id=? AND length(CAST(data AS BLOB))<=262144").get(run.runId);if(!row||row.session_id!==binding.child.sessionId||row.workspace_id!==binding.child.workspaceId||!['completed','failed','cancelled'].includes(String(row.state)))fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');const actual=JSON.parse(String(row.data));if(actual.id!==row.id||actual.state!==row.state||knowledgeHash(actual.config)!==run.configSha256)fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');}
    }
    frame.chargeRows(1);
    const unfinished = db.prepare(`SELECT EXISTS(SELECT 1 FROM child.session_turns WHERE state IN ('created','streaming','awaiting_tools'))
      OR EXISTS(SELECT 1 FROM child.provider_attempts WHERE state IN ('prepared','dispatched','streaming'))
      OR EXISTS(SELECT 1 FROM child.message_parts WHERE state='open') AS present`).get();
    if (unfinished?.present!==0) fail('CHILD_DOCUMENT_STORAGE_NOT_QUIESCENT');
    // Owner and phase checks return only SQL booleans and bounded headers before any JSON body.
    frame.chargeRows(1);
    const own = db.prepare(`SELECT r.id=? AND r.session_id=? AND r.workspace_id=? AND r.state IN ('completed','failed','cancelled')
      AND s.id=r.session_id AND s.workspace_id=r.workspace_id AND w.id=r.workspace_id AND w.root=?
      AND json_extract(r.data,'$.id')=r.id AND json_extract(r.data,'$.sessionId')=s.id AND json_extract(r.data,'$.workspaceId')=w.id AND json_extract(r.data,'$.state')=r.state AND json_extract(r.data,'$.requestId')=?
      AND json_extract(s.data,'$.id')=s.id AND json_extract(s.data,'$.workspaceId')=w.id AND json_extract(w.data,'$.id')=w.id AND json_extract(w.data,'$.root')=w.root AS valid
      FROM child.runs r JOIN child.sessions s ON s.id=r.session_id JOIN child.workspaces w ON w.id=r.workspace_id WHERE r.id=? LIMIT 1`).get(binding.child.runId,binding.child.sessionId,binding.child.workspaceId,binding.child.root,binding.lineage.taskId,binding.child.runId);
    if (own?.valid !== 1) fail('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH');
    frame.chargeRows(1);
    const foreign = db.prepare("SELECT EXISTS(SELECT 1 FROM child.session_documents WHERE kind IN ('input_documents',?) AND session_id<>?) AS present").get(CHILD_STORAGE_MIRROR_KIND,binding.child.sessionId);
    if (foreign?.present !== 0) fail('CHILD_DOCUMENT_STORAGE_FOREIGN_INDEX');
    frame.chargeRows(1);
    const mirrorMetadata = db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM child.session_documents WHERE session_id=? AND kind=? LIMIT 1').get(binding.child.sessionId,CHILD_STORAGE_MIRROR_KIND);
    const bytes = Number(mirrorMetadata?.bytes); if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32_768) fail('CHILD_DOCUMENT_STORAGE_MIRROR_MISMATCH'); frame.charge(bytes); frame.chargeRows(1);
    const mirrorBody = db.prepare('SELECT data FROM child.session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))=? LIMIT 1').get(binding.child.sessionId,CHILD_STORAGE_MIRROR_KIND,bytes);
    const expectedMirror = {schemaVersion:record.schemaVersion,binding:record.binding,sha256:record.sha256};
    if (!mirrorBody || typeof mirrorBody.data !== 'string' || JSON.stringify(validateChildStorageRecord(JSON.parse(mirrorBody.data))) !== JSON.stringify(expectedMirror)) fail('CHILD_DOCUMENT_STORAGE_MIRROR_MISMATCH');
    check();
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // SQLite holds the immutable private file open. Removing its owned pathname
      // avoids leaving this complete copy after a later hard kill; copy-time
      // interruption and platforms that retain open filenames remain separate.
      rmSync(temporary,{recursive:true,force:true}); temporary = undefined;
    }
    let index: InputDocumentIndexReport | undefined;
    return { db,sourceName:'child',schemaVersion:version,artifactPath,check,close,readIndex() {
      check(); if (index) return structuredClone(index);
      if (frame.remainingMetadataBytes === 0 || frame.remainingRefs === 0) fail('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT');
      if (frame.remainingRows < 3) fail('CHILD_DOCUMENT_STORAGE_ROW_LIMIT');
      index = inspectInputDocumentIndex(db!,{maxDocuments:1,maxRefs:Math.min(frame.remainingRefs,2048),maxJsonBytes:Math.min(frame.remainingMetadataBytes,4_194_304),...(frame.signal ? {signal:frame.signal}:{})});
      frame.chargeIndex(index); check();
      if (index.refs.some(ref => ref.sessionId !== binding.child.sessionId || ref.workspaceId !== binding.child.workspaceId)) fail('CHILD_DOCUMENT_STORAGE_FOREIGN_INDEX');
      return structuredClone(index);
    } };
  } catch (error) {
    close(); if (error instanceof EngineError) throw error;
    const sqlite = (error as {errcode?:number})?.errcode; if (sqlite !== undefined && [5,6].includes(sqlite & 255)) fail('CHILD_DOCUMENT_STORAGE_OWNER_BUSY');
    const code = (error as NodeJS.ErrnoException)?.code; fail(code === 'ENOENT' ? 'CHILD_DOCUMENT_STORAGE_MISSING' : code === 'EACCES' || code === 'EPERM' ? 'CHILD_DOCUMENT_STORAGE_PERMISSION_DENIED' : 'CHILD_DOCUMENT_STORAGE_INVALID_DATABASE');
  }
}
export function openChildDocumentReader(value: ChildDocumentReaderInput,frame:ChildDocumentReadFrame):ChildDocumentReader {
  try { return openReader(value,frame); }
  catch(error) { if(error instanceof EngineError)throw error;const code=(error as NodeJS.ErrnoException)?.code;fail(code==='ENOENT'?'CHILD_DOCUMENT_STORAGE_MISSING':code==='EACCES'||code==='EPERM'?'CHILD_DOCUMENT_STORAGE_PERMISSION_DENIED':'CHILD_DOCUMENT_STORAGE_INSPECTION_FAILED'); }
}
export function readChildDocumentIndex(input: ChildDocumentReaderInput,frame:ChildDocumentReadFrame):ChildDocumentIndexObservation {
  let reader: ChildDocumentReader | undefined;
  try { reader=openChildDocumentReader(input,frame); const index=reader.readIndex(); return {status:'observed',reasons:index.complete ? [] : index.reasons,index}; }
  catch(error) { return {status:'unchecked',reasons:[error instanceof EngineError ? error.code : 'CHILD_DOCUMENT_STORAGE_INSPECTION_FAILED']}; }
  finally { reader?.close(); }
}
