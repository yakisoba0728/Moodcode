import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import { assertNativeSignal } from '../shared/data.js';
import { normalizeProposalCaptureInput, type ProposalStorage } from './store.js';
import { ProposalSourceCaptureHost, type PreparedProposalSourceCapture } from './source-capture.js';
import type { AppendProposalRevisionResult, PreparedProposalCapture, ProposalCaptureInput, ProposalSelection } from './types.js';
import { buildProposalDiff, type ProposalReadonlyDiff } from './overlay.js';
import { ownDataFields, trackPending } from './validation.js';

export interface CreateProposalSetInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly proposalId?: string;
  readonly expectedRevision?: number;
  readonly changes: readonly { readonly path: string; readonly expectedHash: string | null; readonly content: string | null }[];
  readonly signal?: AbortSignal;
}
export interface GetProposalDiffInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revisionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
interface CommitCapture { readonly source: PreparedProposalSourceCapture; readonly signal: AbortSignal }
function fail(code = 'INVALID_PROPOSAL'): never { throw new EngineError(code, 'Proposals require an original bounded host request'); }
function invalid(): never { return fail(); }
function plain(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, PropertyDescriptor> {
  return ownDataFields(value, required, optional, invalid);
}
function captureInput(input: CreateProposalSetInput): { request: ProposalCaptureInput; signal?: AbortSignal } {
  const fields = plain(input, ['workspaceId','requestId','changes'], ['proposalId','expectedRevision','signal']);
  const changes = fields.changes!.value as unknown;
  if (!Array.isArray(changes) || types.isProxy(changes) || Object.getPrototypeOf(changes) !== Array.prototype
    || changes.length < 1 || changes.length > 128) fail('PROPOSAL_LIMIT');
  const entries = Object.getOwnPropertyDescriptors(changes);
  if (Reflect.ownKeys(entries).some(key => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key))
    || !Object.hasOwn(entries[key as keyof typeof entries]!, 'value')) || Object.keys(entries).length !== changes.length + 1) fail();
  const operations = Array.from({ length: changes.length }, (_, index) => {
    if (!entries[String(index)]?.enumerable) fail();
    const entry = plain(entries[String(index)]!.value, ['path','expectedHash','content']);
    return { path: entry.path!.value, expectedSha256: entry.expectedHash!.value, after: entry.content!.value };
  });
  const signal = fields.signal?.value as unknown;
  if (signal !== undefined) assertNativeSignal(signal, invalid);
  const request = normalizeProposalCaptureInput({ workspaceId: fields.workspaceId!.value, requestId: fields.requestId!.value,
    ...(fields.proposalId?.value === undefined ? {} : { proposalId: fields.proposalId.value }), expectedHeadRevision: fields.expectedRevision?.value === undefined ? 0 : fields.expectedRevision.value, operations });
  return { request, ...(signal === undefined ? {} : { signal }) };
}

/** Saves unapplied host-owned data. Physical application has a separate owner and approval lane. */
export class ProposalHostService {
  readonly #commits = new WeakMap<PreparedProposalCapture, CommitCapture>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #close = new AbortController();
  constructor(readonly native: ProposalStorage, readonly source: ProposalSourceCaptureHost,
    readonly readTx: <T>(operation: () => T) => T, readonly hostSignal: AbortSignal) {}
  private open(signal?: AbortSignal): void {
    if (this.#close.signal.aborted || this.hostSignal.aborted) fail('ENGINE_CLOSED');
    if (signal?.aborted) fail('PROPOSAL_CANCELLED');
  }
  create(input: CreateProposalSetInput): Promise<AppendProposalRevisionResult> {
    try {
      const { request, signal: caller } = captureInput(input); this.open(caller);
      const signal = AbortSignal.any([this.#close.signal, this.hostSignal, ...(caller ? [caller] : [])]);
      const previous = this.readTx(() => this.native.findRequest(request));
      if (previous) return Promise.resolve({ kind: 'duplicate', ...previous });
      if (this.#pending.size >= 16) fail('PROPOSAL_CAPACITY');
      return trackPending(this.#pending, this.captureAndAppend(request, signal));
    } catch (error) { return Promise.reject(error); }
  }
  private async captureAndAppend(request: ProposalCaptureInput, signal: AbortSignal): Promise<AppendProposalRevisionResult> {
    this.open(signal);
    const begin = this.readTx(() => this.native.beginCapture(request));
    if (begin.kind === 'duplicate') return { kind: 'duplicate', set: begin.set, revision: begin.revision };
    const native = begin.capture;
    let source: PreparedProposalSourceCapture | undefined;
    try {
      source = await this.source.capture(native.binding, request.operations, signal);
      this.open(signal); this.#commits.set(native, { source, signal });
      return this.native.appendRevision(native, source);
    } finally {
      this.#commits.delete(native);
      if (source) this.source.release(source);
      this.native.release(native);
    }
  }
  assertCommitCurrent(native: PreparedProposalCapture, originalSource: object): void {
    const commit = this.#commits.get(native);
    if (!commit || commit.source !== originalSource) fail('PROPOSAL_CAPTURE_INVALID');
    this.open(commit.signal); this.source.assertFreshSync(commit.source, commit.signal);
  }
  get(workspaceId: string, proposalId: string): ProposalSelection | undefined {
    this.open();
    return this.readTx(() => {
      const set = this.native.getSet(workspaceId, proposalId);
      if (!set) return undefined;
      const revision = this.native.getRevision(workspaceId, set.revisionId);
      if (!revision || revision.sha256 !== set.revisionSha256 || revision.proposalId !== proposalId) fail('PROPOSAL_CORRUPT');
      return Object.freeze({ set, revision });
    });
  }
  list(input: { readonly workspaceId: string; readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number }) {
    this.open();
    const fields = plain(input, ['workspaceId'], ['cursor','limit','maxBytes']);
    return this.readTx(() => this.native.listSets(fields.workspaceId!.value, {
      ...(fields.cursor?.value === undefined ? {} : { after: fields.cursor.value }),
      ...(fields.limit?.value === undefined ? {} : { limit: fields.limit.value }),
      ...(fields.maxBytes?.value === undefined ? {} : { maxBytes: fields.maxBytes.value }),
    }));
  }
  diff(input: GetProposalDiffInput): Promise<ProposalReadonlyDiff> {
    try {
      this.open();
      const fields = plain(input, ['workspaceId','proposalId'], ['revisionId','cursor','limit','maxBytes','signal']);
      const caller = fields.signal?.value as unknown;
      if (caller !== undefined) assertNativeSignal(caller, invalid);
      this.open(caller);
      const signal = AbortSignal.any([this.#close.signal, this.hostSignal, ...(caller ? [caller] : [])]);
      const selected = this.get(fields.workspaceId!.value, fields.proposalId!.value);
      if (!selected) fail('PROPOSAL_NOT_FOUND');
      const revision = fields.revisionId?.value === undefined ? selected.revision
        : this.readTx(() => this.native.getRevision(fields.workspaceId!.value, fields.revisionId!.value));
      if (!revision || revision.proposalId !== selected.set.id) fail('PROPOSAL_NOT_FOUND');
      const cursor = fields.cursor?.value;
      if (cursor !== undefined && (typeof cursor !== 'string' || !/^(?:0|[1-9]\d{0,2})$/u.test(cursor))) fail('INVALID_PROPOSAL_PAGE');
      const options = { ...(cursor === undefined ? {} : { after: Number(cursor) }),
        ...(fields.limit?.value === undefined ? {} : { limit: fields.limit.value }), ...(fields.maxBytes?.value === undefined ? {} : { maxBytes: fields.maxBytes.value }) };
      // Reject invalid paging before beginning physical observations or reading bodies.
      const limit = options.limit ?? 64, maxBytes = options.maxBytes ?? 65_536;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 65_536
        || Number(cursor ?? 0) > revision.files.length) fail('INVALID_PROPOSAL_PAGE');
      if (this.#pending.size >= 16) fail('PROPOSAL_CAPACITY');
      return trackPending(this.#pending, (async () => {
        let sourceFreshness: 'current' | 'stale' | 'unknown' = 'current';
        try { await this.source.assertStoredManifestCurrent(revision.binding, revision.sourceManifest, signal); }
        catch (error) {
          this.open(signal);
          sourceFreshness = error instanceof EngineError && ['PROPOSAL_SOURCE_STALE','PROPOSAL_SOURCE_BINDING_CHANGED','PROPOSAL_SOURCE_UNSAFE'].includes(error.code) ? 'stale' : 'unknown';
        }
        this.open(signal);
        return this.readTx(() => {
          const current = this.native.getRevision(revision.workspaceId, revision.id);
          if (!current || current.sha256 !== revision.sha256) fail('PROPOSAL_CORRUPT');
          const head = this.native.getSet(revision.workspaceId, revision.proposalId);
          if (!head) fail('PROPOSAL_CORRUPT');
          return buildProposalDiff(current, ref => {
            const page = this.native.ports.blobs.read(ref, { offset: 0, limit: Math.max(1, Math.min(ref.bytes, 65_536)) });
            if (page.nextOffset !== null) fail('PROPOSAL_DIFF_BODY_LIMIT');
            return Buffer.from(page.bytes).toString('utf8');
          }, { ...options, sourceFreshness, proposalStatus: head.status });
        });
      })());
    } catch (error) { return Promise.reject(error); }
  }
  async close(): Promise<void> {
    this.#close.abort();
    await Promise.allSettled([...this.#pending]);
    await this.source.close();
  }
}
