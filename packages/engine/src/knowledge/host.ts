import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { assertPhysicalKnowledgeRoot } from '../workspace/trust.js';
import type { KnowledgeHostBinding, KnowledgeSourceManifest, KnowledgeSourcePin, KnowledgeTarget } from './types.js';
import { canonicalKnowledge, exactKnowledgePath, identifier, immutableKnowledgeJson, integer, knowledgeError, knowledgeHash, sha256, validateBinding, validateSource, validateTarget } from './validation.js';

export const KNOWLEDGE_HOST_LIMITS = Object.freeze({ fileBytes: 131_072, messageBytes: 262_144, sourceBytes: 262_144, messageRecordBytes: 1_048_576, sourcePins: 64, projections: 128 });
export type KnowledgeSourceSelection =
  | { readonly kind: 'message'; readonly sessionId: string; readonly messageId: string; readonly runId?: string | null }
  | { readonly kind: 'file'; readonly path: string };
export interface KnowledgeSourceProjection {
  readonly workspaceId: string;
  readonly binding: KnowledgeHostBinding;
  readonly manifest: KnowledgeSourceManifest;
  readonly body: string;
  readonly bodySha256: string;
  readonly bodyBytes: number;
}
export interface KnowledgeHostAdapterPorts {
  readonly readTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => { readonly id: string; readonly root: string };
  readonly checkHostBinding: (workspaceId: string) => KnowledgeHostBinding;
  /** Existing file targets need an actual host version owner; none is invented from existence. */
  readonly readFileTargetRevision?: (binding: KnowledgeHostBinding, path: string) => number;
  /** Actual workspace-owned document head; Session documents cannot supply this port. */
  readonly readWorkspaceDocumentTarget?: (binding: KnowledgeHostBinding, key: string) => Extract<KnowledgeTarget, { kind: 'workspace-document' }>;
}
type ProjectionEntry = { readonly kind: 'message'; readonly id: string; readonly sessionId: string; readonly runId: string; readonly role: 'user' | 'assistant' | 'tool'; readonly content: string }
  | { readonly kind: 'file'; readonly path: string; readonly content: string };
type FileObservation = { readonly content: string; readonly sha256: string; readonly bytes: number; readonly device: string; readonly inode: string };
type Capture = { readonly signal?: AbortSignal };
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) knowledgeError('KNOWLEDGE_CANCELLED', 'Host knowledge source observation was cancelled'); }
function equal(actual: unknown, expected: unknown, code: string): void { if (knowledgeHash(actual) !== knowledgeHash(expected)) knowledgeError(code, 'Knowledge host observation no longer matches its exact capture'); }

/** Read-only adapter over the actual legacy/native transcript owner and current physical files. */
export class KnowledgeHostAdapter {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeHostAdapterPorts;
  readonly #captures = new WeakMap<object, Capture>();
  readonly #active = new Set<object>();
  constructor(db: DatabaseSync, ports: KnowledgeHostAdapterPorts) {
    if (!ports || typeof ports.readTx !== 'function' || typeof ports.getWorkspace !== 'function' || typeof ports.checkHostBinding !== 'function' || ports.readFileTargetRevision !== undefined && typeof ports.readFileTargetRevision !== 'function' || ports.readWorkspaceDocumentTarget !== undefined && typeof ports.readWorkspaceDocumentTarget !== 'function') knowledgeError('INVALID_KNOWLEDGE_PORTS', 'Knowledge host adapter requires synchronous read/binding ports');
    this.#db = db; this.#ports = Object.freeze({ ...ports }); Object.freeze(this);
  }
  private read<T>(operation: () => T): T {
    if (this.#db.isTransaction) return operation();
    let entered = false;
    const result = this.#ports.readTx(() => {
      if (entered || !this.#db.isTransaction) knowledgeError('KNOWLEDGE_TRANSACTION_REQUIRED', 'Source reads need one transaction on their actual database');
      entered = true; return operation();
    });
    if (!entered) knowledgeError('KNOWLEDGE_TRANSACTION_REQUIRED', 'Host read transaction did not execute its source read');
    if (result && typeof result === 'object' && 'then' in result) knowledgeError('KNOWLEDGE_ASYNC_PORT', 'Host source transactions cannot cross an await');
    return result;
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    identifier(workspaceId);
    const workspace = immutableKnowledgeJson(this.#ports.getWorkspace(workspaceId)), binding = validateBinding(this.#ports.checkHostBinding(workspaceId));
    if (workspace.id !== workspaceId || binding.workspaceId !== workspaceId || workspace.root !== binding.root) knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Source workspace and physical host binding disagree');
    assertPhysicalKnowledgeRoot(binding); return binding;
  }
  private currentBinding(binding: KnowledgeHostBinding): void { equal(this.binding(binding.workspaceId), binding, 'KNOWLEDGE_BINDING_MISMATCH'); }
  private selection(input: readonly KnowledgeSourceSelection[]): readonly KnowledgeSourceSelection[] {
    const selected = immutableKnowledgeJson(input);
    if (!Array.isArray(selected) || !selected.length || selected.length > KNOWLEDGE_HOST_LIMITS.sourcePins) knowledgeError('KNOWLEDGE_LIMIT', 'Host source selection must contain 1..64 exact pins');
    const seen = new Set<string>();
    for (const item of selected) {
      let identity: string;
      if (item.kind === 'message') {
        if (Object.keys(item).some(key => !['kind', 'messageId', 'sessionId', 'runId'].includes(key)) || !Object.hasOwn(item, 'messageId') || !Object.hasOwn(item, 'sessionId')) knowledgeError('INVALID_KNOWLEDGE', 'Message source selectors cannot supply hashes, text or provider data');
        identifier(item.sessionId); identifier(item.messageId); if (item.runId !== undefined && item.runId !== null) identifier(item.runId); identity = `message:${item.messageId}`;
      } else if (item.kind === 'file') {
        if (Object.keys(item).length !== 2 || !Object.hasOwn(item, 'path')) knowledgeError('INVALID_KNOWLEDGE', 'File source selectors accept only an exact path'); identity = `file:${exactKnowledgePath(item.path)}`;
      } else return knowledgeError('INVALID_KNOWLEDGE', 'Unknown host source selector');
      if (seen.has(identity)) knowledgeError('INVALID_KNOWLEDGE', 'Host source selectors must be unique'); seen.add(identity);
    }
    return selected;
  }
  private message(binding: KnowledgeHostBinding, selection: Extract<KnowledgeSourceSelection, { kind: 'message' }>, remaining: number): { entry: ProjectionEntry; pin: KnowledgeSourcePin } {
    // Inspect lengths/columns before JSON1 parses a potentially oversized opaque message/run body.
    const owner = this.#db.prepare(`SELECT m.session_id,m.run_id,r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,r.state,
      s.workspace_id AS session_workspace_id,length(CAST(m.data AS BLOB)) AS message_bytes,
      length(CAST(r.data AS BLOB)) AS run_bytes,length(CAST(s.data AS BLOB)) AS session_bytes
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN sessions s ON s.id=m.session_id WHERE m.id=?`).get(selection.messageId);
    if (!owner || owner.session_id !== selection.sessionId || owner.run_session_id !== selection.sessionId || owner.run_workspace_id !== binding.workspaceId || owner.session_workspace_id !== binding.workspaceId || typeof owner.run_id !== 'string' || selection.runId !== undefined && selection.runId !== null && owner.run_id !== selection.runId) knowledgeError('KNOWLEDGE_SOURCE_SCOPE_MISMATCH', 'Selected message does not belong to the exact workspace/session/Run owner');
    identifier(owner.run_id);
    if (owner.state !== 'completed') knowledgeError('KNOWLEDGE_SOURCE_UNSETTLED', 'Only explicitly selected completed Run messages can supply pending knowledge');
    for (const count of [owner.message_bytes, owner.run_bytes, owner.session_bytes]) if (typeof count !== 'number' || integer(count, KNOWLEDGE_HOST_LIMITS.messageRecordBytes) < 1) knowledgeError('KNOWLEDGE_LIMIT', 'Selected source owner record is unavailable or exceeds its read cap');
    const row = this.#db.prepare(`SELECT
      substr(json_extract(m.data,'$.id'),1,257) AS message_id,substr(json_extract(m.data,'$.sessionId'),1,257) AS message_session_id,
      substr(json_extract(m.data,'$.runId'),1,257) AS message_run_id,substr(json_extract(m.data,'$.role'),1,16) AS role,
      json_type(m.data,'$.content') AS content_type,length(CAST(json_extract(m.data,'$.content') AS BLOB)) AS content_bytes,
      CASE WHEN json_type(m.data,'$.content')='text' AND length(CAST(json_extract(m.data,'$.content') AS BLOB))<=? THEN json_extract(m.data,'$.content') ELSE NULL END AS content,
      substr(json_extract(r.data,'$.id'),1,257) AS run_id,substr(json_extract(r.data,'$.sessionId'),1,257) AS run_session_id,
      substr(json_extract(r.data,'$.workspaceId'),1,257) AS run_workspace_id,substr(json_extract(r.data,'$.state'),1,20) AS run_state,
      substr(json_extract(s.data,'$.id'),1,257) AS session_id,substr(json_extract(s.data,'$.workspaceId'),1,257) AS session_workspace_id,
      CASE WHEN json_type(m.data,'$.id')='text' AND json_type(m.data,'$.sessionId')='text' AND json_type(m.data,'$.runId')='text'
        AND json_type(r.data,'$.id')='text' AND json_type(r.data,'$.sessionId')='text' AND json_type(r.data,'$.workspaceId')='text' AND json_type(r.data,'$.state')='text'
        AND json_type(s.data,'$.id')='text' AND json_type(s.data,'$.workspaceId')='text' THEN 1 ELSE 0 END AS identity_types_valid,
      json_type(m.data,'$.attachments') AS image_type,json_type(m.data,'$.documents') AS document_type,
      coalesce(json_array_length(m.data,'$.attachments'),0) AS image_count,coalesce(json_array_length(m.data,'$.documents'),0) AS document_count
      FROM messages m JOIN runs r ON r.id=m.run_id JOIN sessions s ON s.id=m.session_id WHERE m.id=?`).get(Math.min(remaining, KNOWLEDGE_HOST_LIMITS.messageBytes), selection.messageId);
    if (!row || row.identity_types_valid !== 1 || row.message_id !== selection.messageId || row.message_session_id !== selection.sessionId || row.message_run_id !== owner.run_id || row.run_id !== owner.run_id || row.run_session_id !== selection.sessionId || row.run_workspace_id !== binding.workspaceId || row.run_state !== 'completed' || row.session_id !== selection.sessionId || row.session_workspace_id !== binding.workspaceId) knowledgeError('KNOWLEDGE_SOURCE_SCOPE_MISMATCH', 'Native source columns and allowlisted message/Run/session payload disagree');
    if (row.image_count !== 0 || row.document_count !== 0 || ![null, 'null', 'array'].includes(row.image_type as string | null) || ![null, 'null', 'array'].includes(row.document_type as string | null)) knowledgeError('KNOWLEDGE_SOURCE_MEDIA_UNSUPPORTED', 'Text-only knowledge source selection cannot stand in for image/document history');
    if (!['user', 'assistant', 'tool'].includes(String(row.role)) || row.content_type !== 'text' || typeof row.content !== 'string' || typeof row.content_bytes !== 'number' || row.content_bytes > remaining || Buffer.from(row.content).toString('utf8') !== row.content || row.content.includes('\0')) knowledgeError('KNOWLEDGE_LIMIT', 'Selected message text exceeds its complete UTF-8 read budget');
    const entry = Object.freeze({ kind: 'message' as const, id: selection.messageId, sessionId: selection.sessionId, runId: owner.run_id, role: row.role as 'user' | 'assistant' | 'tool', content: row.content });
    return { entry, pin: Object.freeze({ kind: 'message', sessionId: entry.sessionId, runId: entry.runId, messageId: entry.id, sha256: knowledgeHash(entry) }) };
  }
  private file(binding: KnowledgeHostBinding, relative: string, cap: number, signal?: AbortSignal): FileObservation {
    exactKnowledgePath(relative); cancelled(signal); this.currentBinding(binding);
    let selected = binding.root;
    try {
      const components = relative.split('/');
      for (let index = 0; index < components.length; index++) {
        selected = path.join(selected, components[index]!); const metadata = lstatSync(selected, { bigint: true });
        if (metadata.isSymbolicLink() || realpathSync(selected) !== selected || (index < components.length - 1 ? !metadata.isDirectory() : !metadata.isFile())) knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Knowledge source paths cannot traverse links or non-directory parents or end at a non-regular file');
      }
      const descriptor = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(cap)) knowledgeError('KNOWLEDGE_LIMIT', 'Selected file is not one bounded ordinary text file');
        const output = Buffer.alloc(cap + 1); let bytes = 0;
        while (bytes < output.byteLength) { cancelled(signal); const count = readSync(descriptor, output, bytes, output.byteLength - bytes, null); if (!count) break; bytes += count; }
        const after = fstatSync(descriptor, { bigint: true }), current = lstatSync(selected, { bigint: true });
        if (bytes > cap || BigInt(bytes) !== after.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs || realpathSync(selected) !== selected) knowledgeError('KNOWLEDGE_SOURCE_CHANGED', 'Selected file changed during its bounded source read');
        const body = output.subarray(0, bytes), content = body.toString('utf8');
        if (!Buffer.from(content).equals(body) || content.includes('\0')) knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Knowledge file sources require plain UTF-8 text');
        cancelled(signal); this.currentBinding(binding); return Object.freeze({ content, sha256: sha256(content), bytes, device: after.dev.toString(), inode: after.ino.toString() });
      } finally { closeSync(descriptor); }
    } catch (error) { if (error instanceof EngineError) throw error; return knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Selected knowledge source is missing or unavailable'); }
  }
  private project(binding: KnowledgeHostBinding, selection: readonly KnowledgeSourceSelection[], signal?: AbortSignal): KnowledgeSourceProjection {
    this.currentBinding(binding); cancelled(signal); const entries: ProjectionEntry[] = [], pins: KnowledgeSourcePin[] = []; let contentBytes = 0;
    for (const item of selection) {
      cancelled(signal); const remaining = KNOWLEDGE_HOST_LIMITS.sourceBytes - contentBytes;
      if (item.kind === 'message') { const observed = this.message(binding, item, remaining); entries.push(observed.entry); pins.push(observed.pin); contentBytes += Buffer.byteLength(observed.entry.content); }
      else {
        const observed = this.file(binding, item.path, Math.min(remaining, KNOWLEDGE_HOST_LIMITS.fileBytes), signal); entries.push(Object.freeze({ kind: 'file', path: item.path, content: observed.content })); pins.push(Object.freeze({ kind: 'file', path: item.path, sha256: observed.sha256, bytes: observed.bytes, device: observed.device, inode: observed.inode })); contentBytes += observed.bytes;
      }
    }
    const body = canonicalKnowledge(entries), bodyBytes = Buffer.byteLength(body), bodySha256 = sha256(body);
    if (bodyBytes > KNOWLEDGE_HOST_LIMITS.sourceBytes) knowledgeError('KNOWLEDGE_LIMIT', 'Complete serialized source projection exceeds its shared byte cap');
    const manifest = validateSource({ projection: 'host-selected-text-v1', sha256: bodySha256, bytes: bodyBytes, pins });
    cancelled(signal); this.currentBinding(binding); return Object.freeze({ workspaceId: binding.workspaceId, binding, manifest, body, bodySha256, bodyBytes });
  }
  captureSources(input: { readonly workspaceId: string; readonly selection: readonly KnowledgeSourceSelection[] }, signal?: AbortSignal): KnowledgeSourceProjection {
    cancelled(signal); const request = immutableKnowledgeJson(input);
    if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'workspaceId') || !Object.hasOwn(request, 'selection')) knowledgeError('INVALID_KNOWLEDGE', 'Source capture accepts only workspace and exact host selectors');
    if (this.#active.size >= KNOWLEDGE_HOST_LIMITS.projections) knowledgeError('KNOWLEDGE_LIMIT', 'Host must release its bounded active source projections');
    const selected = this.selection(request.selection), projection = this.read(() => this.project(this.binding(request.workspaceId), selected, signal));
    this.#captures.set(projection, { signal }); this.#active.add(projection); return projection;
  }
  private owned(projection: KnowledgeSourceProjection): Capture {
    if (!projection || typeof projection !== 'object' || !this.#active.has(projection)) knowledgeError('KNOWLEDGE_SOURCE_CAPTURE_INVALID', 'Source projection is copied, foreign, released or never issued');
    return this.#captures.get(projection) ?? knowledgeError('KNOWLEDGE_SOURCE_CAPTURE_INVALID', 'Source projection has no host owner');
  }
  assertProjectionFresh(projection: KnowledgeSourceProjection, signal?: AbortSignal): void {
    const capture = this.owned(projection); cancelled(capture.signal); cancelled(signal);
    this.assertSourcesCurrent(projection.binding, projection.manifest, signal);
    cancelled(capture.signal); cancelled(signal);
  }
  releaseProjection(projection: KnowledgeSourceProjection): void { this.owned(projection); this.#active.delete(projection); this.#captures.delete(projection); }
  assertSourcesCurrent(inputBinding: KnowledgeHostBinding, inputManifest: KnowledgeSourceManifest, signal?: AbortSignal): void {
    const binding = validateBinding(inputBinding), manifest = validateSource(inputManifest);
    const selection: KnowledgeSourceSelection[] = manifest.pins.map(pin => pin.kind === 'file' ? { kind: 'file', path: pin.path } : { kind: 'message', sessionId: pin.sessionId, messageId: pin.messageId, runId: pin.runId });
    const observed = this.read(() => this.project(binding, this.selection(selection), signal));
    equal(observed.manifest, manifest, 'KNOWLEDGE_SOURCE_CHANGED');
  }
  private absent(binding: KnowledgeHostBinding, relative: string): boolean {
    exactKnowledgePath(relative); this.currentBinding(binding); const components = relative.split('/'); let selected = binding.root, missing = false;
    try {
      for (let index = 0; index < components.length; index++) {
        selected = path.join(selected, components[index]!); const metadata = lstatSync(selected, { bigint: true, throwIfNoEntry: false });
        if (!metadata) { missing = true; break; }
        if (metadata.isSymbolicLink() || realpathSync(selected) !== selected || index < components.length - 1 && !metadata.isDirectory()) knowledgeError('KNOWLEDGE_TARGET_CHANGED', 'Target parent is a symlink or unavailable directory');
      }
      this.currentBinding(binding); return missing;
    } catch (error) { if (error instanceof EngineError) throw error; return knowledgeError('KNOWLEDGE_TARGET_CHANGED', 'Target path is unavailable'); }
  }
  private target(binding: KnowledgeHostBinding, relative: string): Extract<KnowledgeTarget, { kind: 'workspace-file' }> {
    if (this.absent(binding, relative)) {
      const revision = this.#ports.readFileTargetRevision ? integer(this.#ports.readFileTargetRevision(binding, relative)) : 0;
      if (!this.absent(binding, relative)) knowledgeError('KNOWLEDGE_TARGET_CHANGED', 'Absent file target appeared while its original native revision was observed');
      return Object.freeze({ kind: 'workspace-file', path: relative, revision, sha256: null, device: null, inode: null });
    }
    if (!this.#ports.readFileTargetRevision) knowledgeError('KNOWLEDGE_TARGET_REVISION_UNAVAILABLE', 'Existing file targets require an actual host publication/document revision owner');
    const observed = this.file(binding, relative, KNOWLEDGE_HOST_LIMITS.fileBytes), revision = integer(this.#ports.readFileTargetRevision(binding, relative));
    if (!revision) knowledgeError('KNOWLEDGE_TARGET_REVISION_UNAVAILABLE', 'Existing target host revision must be positive');
    equal(this.file(binding, relative, KNOWLEDGE_HOST_LIMITS.fileBytes), observed, 'KNOWLEDGE_TARGET_CHANGED');
    this.currentBinding(binding);
    return Object.freeze({ kind: 'workspace-file', path: relative, revision, sha256: observed.sha256, device: observed.device, inode: observed.inode });
  }
  captureFileTarget(workspaceId: string, relative: string): Extract<KnowledgeTarget, { kind: 'workspace-file' }> {
    exactKnowledgePath(relative); return this.read(() => this.target(this.binding(workspaceId), relative));
  }
  private documentTarget(binding: KnowledgeHostBinding, key: string): Extract<KnowledgeTarget, { kind: 'workspace-document' }> {
    identifier(key); this.currentBinding(binding);
    if (!this.#ports.readWorkspaceDocumentTarget) knowledgeError('KNOWLEDGE_WORKSPACE_DOCUMENT_UNSUPPORTED', 'Workspace document storage requires its actual workspace-owned revision port');
    const target = validateTarget(this.#ports.readWorkspaceDocumentTarget(binding, key));
    if (target.kind !== 'workspace-document' || target.key !== key) knowledgeError('KNOWLEDGE_TARGET_CHANGED', 'Native document target does not match its requested workspace key');
    this.currentBinding(binding); return target;
  }
  captureDocumentTarget(workspaceId: string, key: string): Extract<KnowledgeTarget, { kind: 'workspace-document' }> {
    identifier(key); return this.read(() => this.documentTarget(this.binding(workspaceId), key));
  }
  assertTargetCurrent(inputBinding: KnowledgeHostBinding, inputTarget: KnowledgeTarget): void {
    const binding = validateBinding(inputBinding), target = validateTarget(inputTarget);
    if (target.kind === 'workspace-document') {
      this.read(() => equal(this.documentTarget(binding, target.key), target, 'KNOWLEDGE_TARGET_CHANGED')); return;
    }
    this.read(() => {
      if (target.revision === 0) {
        if (!this.absent(binding, target.path)) knowledgeError('KNOWLEDGE_TARGET_CHANGED', 'Captured absent target was created after its host preview');
      } else equal(this.target(binding, target.path), target, 'KNOWLEDGE_TARGET_CHANGED');
    });
  }
}
