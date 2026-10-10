import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError, type JsonObject, type Workspace } from '@moodcode/contracts';
import type { GrantDocumentPort } from '../permission/grants.js';
import type { ManagedWorktree } from '../worktrees/index.js';
import type { ChildTaskRecord } from './index.js';

export const CHILD_STORAGE_MIRROR_KIND = 'engine.child_owner';
const CHILD_STORAGE_LIMITS = { maxTasks: 32, maxRecordBytes: 32768, maxMetadataBytes: 8388608 } as const;
export interface ChildStoragePhysicalIdentity { path: string; dev: string; ino: string }
export interface ChildStorageHostIdentity {
  database: ChildStoragePhysicalIdentity | { memory: string };
  artifacts: ChildStoragePhysicalIdentity;
}
export interface ChildStorageBinding {
  schemaVersion: 1; nonce: string; phase: 'prepared' | 'admitted';
  hostIdentity: ChildStorageHostIdentity; childrenDirectory: string;
  relativePaths: { database: string; owner: string; artifacts: string };
  lineage: { sessionId: string; sourceRunId: string; parentRunId: string; parentTaskId?: string; taskId: string; taskRequestId: string; taskFingerprint: string; requestFingerprint: string; depth: number };
  worktree: { id: string; workspaceId: string; root: string; baseRoot: string; baseCommit: string; reference: string; fingerprint: string; device: string; inode: string };
  child: { sessionId: string; workspaceId: string; root: string; runId?: string };
  physical: { database: ChildStoragePhysicalIdentity; owner: ChildStoragePhysicalIdentity; artifacts: ChildStoragePhysicalIdentity };
  preparedAt: string; admittedAt?: string;
}
interface ChildStorageCloseProof { method: 'engine-close-resolved'; bindingSha256: string; closedAt: string }
export interface ChildStorageRecord { schemaVersion: 1; binding: ChildStorageBinding; sha256: string; confirmedClose?: ChildStorageCloseProof }
type ChildStorageSelectionStatus = 'eligible' | 'historical' | 'active' | 'legacy' | 'foreign' | 'relocated' | 'unconfirmed' | 'invalid' | 'missing' | 'limit' | 'archive-unsupported';
interface ChildStorageSelection {
  taskId: string; status: ChildStorageSelectionStatus; reasons: string[]; record?: ChildStorageRecord;
}
export interface ChildStorageSelectionReport {
  scope: 'managed-child-storage'; mode: 'source' | 'archive-historical'; complete: boolean;
  sessionId: string; sourceRunId: string; selections: ChildStorageSelection[];
  selectedMetadataBytes: number; physicalIO: null;
}
export interface ChildStorageSelectionOptions {
  sessionId: string; sourceRunId: string; taskIds: readonly string[];
  hostIdentity: ChildStorageHostIdentity; childrenDirectory: string; mode?: 'source' | 'archive-historical'; signal?: AbortSignal;
}
export interface ChildStorageSelectionBudget { maxMetadataBytes?: number; readonly remainingMetadataBytes?: number; readonly remainingRows?: number; charge?(bytes: number): void; chargeRows?(rows: number): void; check?(): void }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message: string): never { throw new EngineError('CHILD_STORAGE_BINDING_INVALID', message); }
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && Buffer.byteLength(value) <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail('Binding must contain plain records');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return fail('Binding must contain data properties');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('Binding fields are unsupported');
}
function denseIds(value: unknown): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > CHILD_STORAGE_LIMITS.maxTasks) return fail('Task filters must be a bounded dense array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail('Task filters have unsupported properties');
  for (let index = 0; index < value.length; index++) if (!descriptors[String(index)] || !('value' in descriptors[String(index)]!) || !descriptors[String(index)]!.enumerable || typeof descriptors[String(index)]!.value !== 'string' || !/^child_[a-f0-9]{32}$/.test(descriptors[String(index)]!.value)) fail('Task filters must contain task identifiers');
  if (new Set(value).size !== value.length) fail('Task filters contain duplicate identifiers');
  return [...value];
}
function taskRecord(value: unknown): ChildTaskRecord {
  const task = plain(value);
  if (typeof task.id !== 'string' || !/^child_[a-f0-9]{32}$/.test(task.id) || ![task.requestId,task.sessionId,task.parentRunId,task.rootRunId,task.worktreeId].every(id) || typeof task.worktreeId !== 'string' || !/^worktree_[a-f0-9]{32}$/.test(task.worktreeId) || !sha(task.fingerprint) || !Number.isSafeInteger(task.depth) || Number(task.depth) < 1 || Number(task.depth) > 3 || typeof task.state !== 'string' || !['starting','running','cancelling','completed','failed','cancelled','uncertain'].includes(task.state) || (task.childRunId !== undefined && !id(task.childRunId)) || (task.parentTaskId !== undefined && (typeof task.parentTaskId !== 'string' || !/^child_[a-f0-9]{32}$/.test(task.parentTaskId)))) fail('Task journal member identity is invalid');
  const allocation = plain(task.budget);
  if (['turns','toolCalls','outputBytes','durationMs'].some(name => !Number.isSafeInteger(allocation[name]) || Number(allocation[name]) < 0)) fail('Task journal member budget is invalid');
  return task as unknown as ChildTaskRecord;
}
function physical(value: unknown): ChildStoragePhysicalIdentity {
  const object = plain(value); keys(object, ['path', 'dev', 'ino']);
  if (!path(object.path) || ![object.dev, object.ino].every(value => typeof value === 'string' && /^\d{1,30}$/.test(value))) fail('Physical storage identity is invalid');
  return object as unknown as ChildStoragePhysicalIdentity;
}
export function validateChildStorageHostIdentity(value: unknown): ChildStorageHostIdentity {
  const object = plain(value); keys(object, ['database', 'artifacts']); physical(object.artifacts);
  const database = plain(object.database);
  if (Object.hasOwn(database, 'memory')) { keys(database, ['memory']); if (!id(database.memory)) fail('Memory host identity is invalid'); }
  else physical(database);
  return structuredClone(object) as unknown as ChildStorageHostIdentity;
}
export function childStorageKind(taskId: string): string {
  if (!/^child_[a-f0-9]{32}$/.test(taskId)) return fail('Task identity is invalid');
  return `child.storage.${taskId}`;
}
export function childStorageBindingSha256(binding: ChildStorageBinding): string { return hash(binding); }
export function validateChildStorageRecord(value: unknown): ChildStorageRecord {
  const record = plain(value); keys(record, ['schemaVersion', 'binding', 'sha256'], ['confirmedClose']);
  const binding = plain(record.binding); keys(binding, ['schemaVersion','nonce','phase','hostIdentity','childrenDirectory','relativePaths','lineage','worktree','child','physical','preparedAt'], ['admittedAt']);
  if (record.schemaVersion !== 1 || binding.schemaVersion !== 1 || !id(binding.nonce) || typeof binding.phase !== 'string' || !['prepared','admitted'].includes(binding.phase) || !path(binding.childrenDirectory) || !date(binding.preparedAt)) fail('Binding schema or phase is invalid');
  validateChildStorageHostIdentity(binding.hostIdentity);
  const lineage = plain(binding.lineage); keys(lineage, ['sessionId','sourceRunId','parentRunId','taskId','taskRequestId','taskFingerprint','requestFingerprint','depth'], ['parentTaskId']);
  if (![lineage.sessionId,lineage.sourceRunId,lineage.parentRunId,lineage.taskRequestId].every(id) || !sha(lineage.taskFingerprint) || !sha(lineage.requestFingerprint) || !Number.isSafeInteger(lineage.depth) || Number(lineage.depth) < 1 || Number(lineage.depth) > 3 || (lineage.parentTaskId !== undefined && (typeof lineage.parentTaskId !== 'string' || !/^child_[a-f0-9]{32}$/.test(lineage.parentTaskId)))) fail('Lineage identity is invalid');
  if (typeof lineage.taskId !== 'string') fail('Task identity is invalid');
  childStorageKind(lineage.taskId);
  const relativePaths = plain(binding.relativePaths); keys(relativePaths, ['database','owner','artifacts']);
  if (relativePaths.database !== `${lineage.taskId}/engine.sqlite` || relativePaths.owner !== `${lineage.taskId}/engine.sqlite.owner.sqlite` || relativePaths.artifacts !== `${lineage.taskId}/artifacts`) fail('Storage paths must use the managed task allowlist');
  const own = plain(binding.physical); keys(own, ['database','owner','artifacts']);
  for (const name of ['database','owner','artifacts'] as const) if (physical(own[name]).path !== join(String(binding.childrenDirectory), String(relativePaths[name]))) fail('Physical path differs from the configured managed base');
  const worktree = plain(binding.worktree); keys(worktree, ['id','workspaceId','root','baseRoot','baseCommit','reference','fingerprint','device','inode']);
  if (typeof worktree.id !== 'string' || !/^worktree_[a-f0-9]{32}$/.test(worktree.id) || !id(worktree.workspaceId) || !path(worktree.root) || !path(worktree.baseRoot) || !id(worktree.baseCommit) || !id(worktree.reference) || !sha(worktree.fingerprint) || ![worktree.device,worktree.inode].every(value => typeof value === 'string' && /^\d{1,30}$/.test(value))) fail('Historical worktree identity is invalid');
  if (worktree.root !== join(String(binding.childrenDirectory), 'worktrees', worktree.id)) fail('Worktree is outside its configured base');
  const child = plain(binding.child); keys(child, ['sessionId','workspaceId','root'], ['runId']);
  if (!id(child.sessionId) || !id(child.workspaceId) || child.root !== worktree.root || child.workspaceId !== `workspace_${createHash('sha256').update(String(child.root)).digest('hex')}` || child.sessionId === lineage.sessionId) fail('Child workspace/session is invalid');
  if (binding.phase === 'admitted' ? !id(child.runId) || !date(binding.admittedAt) : child.runId !== undefined || binding.admittedAt !== undefined) fail('Admission proof is incomplete');
  if (!sha(record.sha256) || record.sha256 !== hash(binding)) fail('Binding digest does not match');
  if (record.confirmedClose !== undefined) { const close = plain(record.confirmedClose); keys(close, ['method','bindingSha256','closedAt']); if (binding.phase !== 'admitted' || close.method !== 'engine-close-resolved' || close.bindingSha256 !== record.sha256 || !date(close.closedAt)) fail('Close proof is invalid'); }
  if (Buffer.byteLength(JSON.stringify(record)) > CHILD_STORAGE_LIMITS.maxRecordBytes) fail('Binding exceeds its byte bound');
  return structuredClone(record) as unknown as ChildStorageRecord;
}
/** Captures ordinary file/directory identities without following a symlink at any component. */
export function childStoragePhysicalIdentity(target: string, directory = false): ChildStoragePhysicalIdentity {
  if (!path(target)) return fail('Physical target must be absolute');
  let current: string = sep;
  for (const component of target.slice(sep.length).split(sep).filter(Boolean)) { current = join(current, component); if (lstatSync(current).isSymbolicLink()) fail('Managed storage ancestors must not be symlinks'); }
  const stat = lstatSync(target, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) fail('Managed storage must use an ordinary unique file or directory');
  if (realpathSync(target) !== target) fail('Managed storage must be canonical');
  return { path: target, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
export function prepareChildStorageBinding(root: GrantDocumentPort, child: GrantDocumentPort, input: {
  task: ChildTaskRecord; requestFingerprint: string; hostIdentity: ChildStorageHostIdentity; childrenDirectory: string;
  worktree: ManagedWorktree; workspace: Workspace; childSessionId: string;
}): ChildStorageRecord {
  const { task, worktree, workspace } = input;
  if (worktree.ownerId !== task.id || worktree.state !== 'ready' || worktree.relocation || !worktree.device || !worktree.inode || task.worktreeId !== worktree.id || task.sessionId !== worktree.sessionId || workspace.root !== worktree.root) fail('Prepared binding requires exact managed worktree ownership');
  const directory = realpathSync(input.childrenDirectory), relativePaths = { database: `${task.id}/engine.sqlite`, owner: `${task.id}/engine.sqlite.owner.sqlite`, artifacts: `${task.id}/artifacts` };
  const binding: ChildStorageBinding = { schemaVersion: 1, nonce: randomUUID(), phase: 'prepared', hostIdentity: validateChildStorageHostIdentity(input.hostIdentity), childrenDirectory: directory, relativePaths,
    lineage: { sessionId: task.sessionId, sourceRunId: task.rootRunId, parentRunId: task.parentRunId, ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}), taskId: task.id, taskRequestId: task.requestId, taskFingerprint: task.fingerprint, requestFingerprint: input.requestFingerprint, depth: task.depth },
    worktree: { id: worktree.id, workspaceId: worktree.workspaceId, root: worktree.root, baseRoot: worktree.baseRoot, baseCommit: worktree.baseCommit, reference: worktree.reference, fingerprint: worktree.fingerprint, device: worktree.device, inode: worktree.inode },
    child: { sessionId: input.childSessionId, workspaceId: workspace.id, root: workspace.root },
    physical: { database: childStoragePhysicalIdentity(join(directory, relativePaths.database)), owner: childStoragePhysicalIdentity(join(directory, relativePaths.owner)), artifacts: childStoragePhysicalIdentity(join(directory, relativePaths.artifacts), true) }, preparedAt: new Date().toISOString() };
  const record = validateChildStorageRecord({ schemaVersion: 1, binding, sha256: hash(binding) });
  // Separate durable intent writes. A partial phase stays explicit and is never repaired implicitly.
  root.putSessionDocument(task.sessionId, childStorageKind(task.id), 0, record as unknown as JsonObject);
  child.putSessionDocument(input.childSessionId, CHILD_STORAGE_MIRROR_KIND, 0, record as unknown as JsonObject);
  return record;
}
function exactDocument(documents: GrantDocumentPort, sessionId: string, kind: string, expected: ChildStorageRecord) {
  const document = documents.getSessionDocument(sessionId, kind);
  if (!document || JSON.stringify(validateChildStorageRecord(document.data)) !== JSON.stringify(expected)) fail('Stored binding differs from its exact phase');
  return document;
}
export function admitChildStorageBinding(root: GrantDocumentPort, child: GrantDocumentPort, prepared: ChildStorageRecord, runId: string): ChildStorageRecord {
  const before = validateChildStorageRecord(prepared);
  if (before.binding.phase !== 'prepared' || !id(runId)) fail('Admission requires a prepared binding and exact Run');
  const rootDocument = exactDocument(root, before.binding.lineage.sessionId, childStorageKind(before.binding.lineage.taskId), before);
  const mirrorDocument = exactDocument(child, before.binding.child.sessionId, CHILD_STORAGE_MIRROR_KIND, before);
  const binding: ChildStorageBinding = { ...before.binding, phase: 'admitted', child: { ...before.binding.child, runId }, admittedAt: new Date().toISOString() };
  const admitted = validateChildStorageRecord({ schemaVersion: 1, binding, sha256: hash(binding) });
  root.putSessionDocument(binding.lineage.sessionId, childStorageKind(binding.lineage.taskId), rootDocument.revision, admitted as unknown as JsonObject);
  child.putSessionDocument(binding.child.sessionId, CHILD_STORAGE_MIRROR_KIND, mirrorDocument.revision, admitted as unknown as JsonObject);
  return admitted;
}
export function confirmChildStorageClosed(root: GrantDocumentPort, admitted: ChildStorageRecord): ChildStorageRecord {
  const record = validateChildStorageRecord(admitted);
  if (record.binding.phase !== 'admitted' || record.confirmedClose) fail('Close proof requires an admitted binding');
  const document = exactDocument(root, record.binding.lineage.sessionId, childStorageKind(record.binding.lineage.taskId), record);
  const closed = validateChildStorageRecord({ ...record, confirmedClose: { method: 'engine-close-resolved', bindingSha256: record.sha256, closedAt: new Date().toISOString() } });
  root.putSessionDocument(record.binding.lineage.sessionId, childStorageKind(record.binding.lineage.taskId), document.revision, closed as unknown as JsonObject);
  return closed;
}

/** Pure root-primary selection. This function never opens a child path or grants execution authority. */
export function readChildStorageSelection(database: DatabaseSync, value: ChildStorageSelectionOptions, budget: ChildStorageSelectionBudget = {}): ChildStorageSelectionReport {
  const options = plain(value); keys(options, ['sessionId','sourceRunId','taskIds','hostIdentity','childrenDirectory'], ['mode','signal']);
  if (!id(value.sessionId) || !id(value.sourceRunId) || !path(value.childrenDirectory) || (value.mode !== undefined && value.mode !== 'source' && value.mode !== 'archive-historical') || (value.signal !== undefined && (types.isProxy(value.signal) || !(value.signal instanceof AbortSignal)))) fail('Selection owner/filter is invalid');
  const taskIds = denseIds(value.taskIds);
  value = { sessionId: value.sessionId, sourceRunId: value.sourceRunId, taskIds, hostIdentity: value.hostIdentity, childrenDirectory: value.childrenDirectory, ...(value.mode ? { mode: value.mode } : {}), ...(value.signal ? { signal: value.signal } : {}) };
  const hostIdentity = validateChildStorageHostIdentity(value.hostIdentity), mode = value.mode ?? 'source';
  let used = 0; const max = budget.maxMetadataBytes ?? CHILD_STORAGE_LIMITS.maxMetadataBytes;
  if (!Number.isSafeInteger(max) || max < 1 || max > CHILD_STORAGE_LIMITS.maxMetadataBytes) fail('Selection budget is invalid');
  const check = () => { if (value.signal?.aborted) throw new EngineError('CANCELLED', 'Child storage selection cancelled'); budget.check?.(); };
  const document = (kind: string, cap: number): unknown => {
    check(); if (budget.remainingRows !== undefined && budget.remainingRows < 2) throw new EngineError('CHILD_STORAGE_SELECTION_LIMIT', 'Selected child rows exceed their bound');
    budget.chargeRows?.(1);
    const row = database.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=? LIMIT 1').get(value.sessionId, kind);
    if (!row) return undefined; const bytes = Number(row.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > cap || used + bytes > max || budget.remainingMetadataBytes !== undefined && bytes > budget.remainingMetadataBytes) throw new EngineError('CHILD_STORAGE_SELECTION_LIMIT', 'Selected child metadata exceeds its bound');
    budget.chargeRows?.(1);
    budget.charge?.(bytes); used += bytes;
    const body = database.prepare('SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))=? LIMIT 1').get(value.sessionId, kind, bytes);
    if (!body || typeof body.data !== 'string') fail('Selected metadata changed');
    return JSON.parse(body.data);
  };
  check();
  const ownerBytes = Buffer.byteLength(JSON.stringify({ matched: 1 }));
  if (ownerBytes > max || budget.remainingMetadataBytes !== undefined && ownerBytes > budget.remainingMetadataBytes || budget.remainingRows !== undefined && budget.remainingRows < 1) throw new EngineError('CHILD_STORAGE_SELECTION_LIMIT', 'Selected owner metadata exceeds its bound');
  budget.chargeRows?.(1); budget.charge?.(ownerBytes); used += ownerBytes;
  const owner = database.prepare("SELECT 1 AS matched FROM runs JOIN sessions ON sessions.id=runs.session_id JOIN workspaces ON workspaces.id=runs.workspace_id WHERE runs.id=? AND runs.session_id=? AND length(CAST(runs.id AS BLOB))<=256 AND length(CAST(runs.session_id AS BLOB))<=256 AND length(CAST(runs.workspace_id AS BLOB))<=256 AND sessions.workspace_id=runs.workspace_id AND json_extract(runs.data,'$.id')=runs.id AND json_extract(runs.data,'$.sessionId')=runs.session_id AND json_extract(runs.data,'$.workspaceId')=runs.workspace_id AND json_extract(sessions.data,'$.id')=sessions.id AND json_extract(sessions.data,'$.workspaceId')=sessions.workspace_id AND json_extract(workspaces.data,'$.id')=workspaces.id LIMIT 1").get(value.sourceRunId, value.sessionId);
  if (!owner) throw new EngineError('CHILD_STORAGE_OWNER_MISMATCH', 'Source Run/session owner is invalid');
  const report: ChildStorageSelectionReport = { scope: 'managed-child-storage', mode, complete: true, sessionId: value.sessionId, sourceRunId: value.sourceRunId, selections: [], selectedMetadataBytes: 0, physicalIO: null };
  if (taskIds.length === 0) { report.selectedMetadataBytes = used; return report; }
  let tasks: ChildTaskRecord[] = [], worktrees: ManagedWorktree[] = [];
  try {
    const taskJournal = plain(document('engine.child_tasks', 245760)), worktreeJournal = plain(document('engine.worktrees', 204800));
    if (taskJournal.schemaVersion !== 1 || worktreeJournal.schemaVersion !== 1 || !Array.isArray(taskJournal.tasks) || taskJournal.tasks.length > 32 || !Array.isArray(worktreeJournal.records) || worktreeJournal.records.length > 128) fail('Task/worktree journal is unsupported');
    tasks = taskJournal.tasks.map(taskRecord); worktrees = worktreeJournal.records.map(item => plain(item)) as unknown as ManagedWorktree[];
    if (new Set(tasks.map(task => task.id)).size !== tasks.length || new Set(worktrees.map(worktree => worktree.id)).size !== worktrees.length) fail('Task/worktree journal contains duplicate identities');
  } catch (error) {
    if (error instanceof EngineError && !['CHILD_STORAGE_BINDING_INVALID','CHILD_STORAGE_SELECTION_LIMIT'].includes(error.code)) throw error;
    report.complete = false; report.selections = taskIds.map(taskId => ({ taskId, status: error instanceof EngineError && error.code === 'CHILD_STORAGE_SELECTION_LIMIT' ? 'limit' : 'invalid', reasons: [error instanceof EngineError ? error.code : 'CHILD_STORAGE_BINDING_INVALID'] })); report.selectedMetadataBytes = used; return report;
  }
  for (const taskId of taskIds) {
    check(); let selection: ChildStorageSelection = { taskId, status: 'invalid', reasons: [] };
    try {
      const task = tasks.find(task => task.id === taskId);
      if (!task) { selection = { taskId, status: 'missing', reasons: ['CHILD_TASK_NOT_FOUND'] }; }
      else if (task.sessionId !== value.sessionId || task.rootRunId !== value.sourceRunId) { selection = { taskId, status: 'foreign', reasons: ['CHILD_STORAGE_OWNER_MISMATCH'] }; }
      else {
        const raw = document(childStorageKind(taskId), CHILD_STORAGE_LIMITS.maxRecordBytes);
        if (!raw) selection = { taskId, status: 'legacy', reasons: ['CHILD_STORAGE_BINDING_MISSING'] };
        else {
          const record = validateChildStorageRecord(raw), binding = record.binding, lineage = binding.lineage;
          const requestBinding = plain(document(`child.request.${hash(task.requestId).slice(0, 32)}`, 1024));
          keys(requestBinding, ['fingerprint']);
          const worktree = worktrees.find(item => item.id === task.worktreeId);
          if (!worktree || lineage.sessionId !== task.sessionId || lineage.sourceRunId !== task.rootRunId || lineage.parentRunId !== task.parentRunId || lineage.parentTaskId !== task.parentTaskId || lineage.depth !== task.depth || lineage.taskId !== task.id || lineage.taskRequestId !== task.requestId || lineage.taskFingerprint !== task.fingerprint || requestBinding.fingerprint !== lineage.requestFingerprint || binding.worktree.id !== worktree.id || worktree.sessionId !== task.sessionId) fail('Task/request/worktree provenance differs');
          let ancestor = task;
          for (let depth = task.depth; depth > 1; depth--) {
            const parent = tasks.find(item => item.id === ancestor.parentTaskId);
            if (!parent || parent.sessionId !== value.sessionId || parent.rootRunId !== value.sourceRunId || parent.depth !== depth - 1 || parent.childRunId !== ancestor.parentRunId) fail('Nested child ancestry is invalid');
            ancestor = parent;
          }
          if (ancestor.parentTaskId !== undefined || ancestor.parentRunId !== value.sourceRunId || ancestor.depth !== 1) fail('Root child ancestry is invalid');
          const historical = binding.worktree;
          if (historical.workspaceId !== worktree.workspaceId || historical.baseRoot !== worktree.baseRoot || historical.baseCommit !== worktree.baseCommit || historical.reference !== worktree.reference || historical.fingerprint !== worktree.fingerprint || historical.device !== worktree.device || historical.inode !== worktree.inode) fail('Historical worktree provenance differs');
          selection.record = record;
          if (['starting','running','cancelling'].includes(task.state)) { selection.status = 'active'; selection.reasons = ['CHILD_STORAGE_ACTIVE']; }
          else if (!['completed','failed','cancelled'].includes(task.state) || binding.phase !== 'admitted' || !record.confirmedClose || binding.child.runId !== task.childRunId) { selection.status = 'unconfirmed'; selection.reasons = ['CHILD_STORAGE_CLOSE_UNCONFIRMED']; }
          else if (mode === 'archive-historical') {
            const external = relative(binding.hostIdentity.artifacts.path, binding.childrenDirectory);
            if (external !== 'children') { selection.status = 'archive-unsupported'; selection.reasons = ['CHILD_STORAGE_EXTERNAL_ARCHIVE_UNSUPPORTED']; }
            else if (worktree.relocation && (worktree.relocation.ownershipVerified !== false || worktree.relocation.originalRoot !== historical.root || !id(worktree.relocation.archiveId) || !sha(worktree.relocation.manifestSha256))) fail('Archive relocation marker is invalid');
            else if (!worktree.relocation && worktree.root !== historical.root) fail('Historical worktree root differs');
            else { selection.status = 'historical'; selection.reasons = ['CHILD_STORAGE_HISTORICAL_ONLY']; }
          } else if (worktree.relocation || worktree.root !== historical.root || binding.childrenDirectory !== value.childrenDirectory || JSON.stringify(binding.hostIdentity) !== JSON.stringify(hostIdentity)) { selection.status = 'relocated'; selection.reasons = ['CHILD_STORAGE_SCOPE_CHANGED']; }
          else { selection.status = 'eligible'; }
        }
      }
    } catch (error) { if (error instanceof EngineError && !['CHILD_STORAGE_BINDING_INVALID','CHILD_STORAGE_SELECTION_LIMIT'].includes(error.code)) throw error; selection = { taskId, status: error instanceof EngineError && error.code === 'CHILD_STORAGE_SELECTION_LIMIT' ? 'limit' : 'invalid', reasons: [error instanceof EngineError ? error.code : 'CHILD_STORAGE_BINDING_INVALID'] }; }
    if (!['eligible','historical'].includes(selection.status)) report.complete = false;
    report.selections.push(selection);
  }
  report.selectedMetadataBytes = used; return report;
}
