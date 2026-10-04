import { randomUUID } from 'node:crypto';
import { EngineError, type ApprovalRecord, type JsonObject, type JsonValue, type Run } from '@moodcode/contracts';
import type { ApprovalPort, ApprovalRequest, EngineStore } from '../ports.js';

interface Waiter {
  resolve(record: ApprovalRecord): void;
  reject(error: unknown): void;
  detach(): void;
}

interface PendingWait {
  input: ApprovalRequest;
  waiters: Set<Waiter>;
  registering: boolean;
  cancellation?: EngineError;
}

type ExpirationReason = 'cancelled' | 'recovery' | 'run_inactive' | 'stale';

const copy = <T>(value: T): T => structuredClone(value);

// Preview object key order is irrelevant to the identity of an approval request.
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cancelled(id?: string): EngineError {
  // Caller-supplied abort reasons may contain private request context.
  return new EngineError('APPROVAL_CANCELLED', 'Approval wait was cancelled', id ? { approvalId: id } : undefined);
}

function expired(id: string): EngineError {
  return new EngineError('APPROVAL_EXPIRED', 'Approval is expired; a new tool call is required', { approvalId: id });
}

function active(run: Run): boolean {
  return run.state === 'running' || run.state === 'awaiting_approval';
}

function sameRequest(record: ApprovalRequest, input: ApprovalRequest): boolean {
  return record.sessionId === input.sessionId && record.runId === input.runId
    && record.toolCallId === input.toolCallId && record.toolName === input.toolName
    && record.fingerprint === input.fingerprint && canonical(record.preview) === canonical(input.preview);
}

/** Durable approval decisions with transient, explicitly live request waiters. */
export class ApprovalManager implements ApprovalPort {
  private readonly pending = new Map<string, PendingWait>();

  constructor(private readonly store: EngineStore) {}

  request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRecord> {
    try {
      if (signal.aborted) throw cancelled();
      const request: ApprovalRequest = {
        sessionId: input.sessionId, runId: input.runId, toolCallId: input.toolCallId,
        toolName: input.toolName, fingerprint: input.fingerprint, preview: copy(input.preview),
      };
      const run = this.store.getRun(request.runId);
      if (run.sessionId !== request.sessionId) {
        throw new EngineError('APPROVAL_REQUEST_CONFLICT', 'Approval session does not match its Run');
      }
      if (!active(run)) {
        throw new EngineError('APPROVAL_RUN_INACTIVE', 'Approval requires a running Run', { runId: run.id });
      }
      const prior = this.store.getSnapshot(request.sessionId).approvals.find(record =>
        record.runId === request.runId && record.toolCallId === request.toolCallId);
      if (signal.aborted) throw cancelled();
      if (prior) {
        const live = this.pending.get(prior.id);
        if (prior.status === 'pending' && !live) {
          this.expire(prior.id, 'recovery');
          throw expired(prior.id);
        }
        if (!sameRequest(prior, request)) {
          throw new EngineError('APPROVAL_REQUEST_CONFLICT', 'A different approval is already bound to this tool call', { approvalId: prior.id });
        }
        if (prior.status === 'expired') throw expired(prior.id);
        if (prior.status !== 'pending') {
          throw new EngineError('APPROVAL_STALE', 'A resolved approval cannot authorize another execution', { approvalId: prior.id });
        }
        if (!live || !sameRequest(live.input, request)) {
          this.expire(prior.id, 'stale');
          throw expired(prior.id);
        }
        return this.wait(prior.id, live, signal);
      }

      const record: ApprovalRecord = {
        id: randomUUID(), ...request, status: 'pending', createdAt: new Date().toISOString(),
      };
      const live: PendingWait = { input: request, waiters: new Set(), registering: true };
      this.pending.set(record.id, live);
      // A postcommit notification can synchronously decide or cancel this request.
      const promise = this.wait(record.id, live, signal);
      try {
        this.store.commit(record.runId, 'approval.requested', this.payload(record), { approval: copy(record) });
      } catch (error) {
        this.settle(record.id, undefined, error);
        return promise;
      }
      live.registering = false;
      if (this.pending.has(record.id) && live.cancellation) {
        try { this.expire(record.id, 'cancelled'); }
        catch (error) { this.settle(record.id, undefined, error); }
      }
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  decide(id: string, decision: 'allow' | 'deny', fingerprint: string): ApprovalRecord {
    if (decision !== 'allow' && decision !== 'deny') {
      throw new EngineError('INVALID_APPROVAL_DECISION', 'Approval decision must be allow or deny');
    }
    const prior = this.getApproval(id);
    // A durable expiration ends its wait even when this delivery has a bad fingerprint.
    if (prior.status === 'expired') this.settle(id, undefined, this.pending.get(id)?.cancellation ?? expired(id));
    if (fingerprint !== prior.fingerprint) {
      throw new EngineError('APPROVAL_FINGERPRINT_MISMATCH', 'Decision fingerprint does not match the prepared request', { approvalId: id });
    }
    const status = decision === 'allow' ? 'allowed' : 'denied';
    if (prior.status === 'allowed' || prior.status === 'denied') {
      if (prior.status !== status) {
        throw new EngineError('APPROVAL_CONFLICT', 'A different decision is already committed', { approvalId: id });
      }
      this.settle(id, prior);
      return copy(prior);
    }
    if (prior.status === 'expired') {
      throw expired(id);
    }
    const live = this.pending.get(id);
    if (!live) {
      this.expire(id, 'recovery');
      throw expired(id);
    }
    if (!sameRequest(prior, live.input)) {
      this.expire(id, 'stale');
      throw expired(id);
    }
    if (live.cancellation) {
      this.expire(id, 'cancelled');
      throw expired(id);
    }
    const run = this.store.getRun(prior.runId);
    if (run.sessionId !== prior.sessionId || !active(run)) {
      this.expire(id, 'run_inactive');
      throw expired(id);
    }
    const record: ApprovalRecord = { ...prior, status, resolvedAt: new Date().toISOString() };
    // Failed commits leave the wait alive and permit a decision retry.
    this.store.commit(record.runId, 'approval.resolved', { ...this.payload(record), decision }, { approval: copy(record) });
    this.settle(id, record);
    return copy(record);
  }

  cancelRun(runId: string): void {
    const run = this.store.getRun(runId);
    for (const [id, live] of this.pending) {
      if (live.input.runId === runId) live.cancellation ??= cancelled(id);
    }
    const records = this.store.getSnapshot(run.sessionId).approvals.filter(record =>
      record.runId === runId && (record.status === 'pending' || this.pending.has(record.id)));
    let failure: unknown;
    let failed = false;
    for (const record of records) {
      try { this.expire(record.id, 'cancelled'); }
      catch (error) {
        this.settle(record.id, undefined, error);
        if (!failed) { failure = error; failed = true; }
      }
    }
    if (failed) throw failure;
  }

  private payload(record: ApprovalRecord): JsonObject {
    return {
      approvalId: record.id, toolCallId: record.toolCallId, toolName: record.toolName,
      fingerprint: record.fingerprint, status: record.status, preview: copy(record.preview),
    };
  }

  private getApproval(id: string): ApprovalRecord {
    try { return this.store.getApproval(id); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'APPROVAL_NOT_FOUND') {
        throw new EngineError('APPROVAL_NOT_FOUND', 'Approval was not found');
      }
      throw error;
    }
  }

  private wait(id: string, live: PendingWait, signal: AbortSignal): Promise<ApprovalRecord> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        live.cancellation ??= cancelled(id);
        // Before requested commit returns, an abort is observed then expired durably.
        if (live.registering) return;
        try { this.expire(id, 'cancelled'); }
        catch (error) { this.settle(id, undefined, error); }
      };
      const waiter: Waiter = {
        resolve, reject, detach: () => signal.removeEventListener('abort', abort),
      };
      live.waiters.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private expire(id: string, reason: ExpirationReason): void {
    const prior = this.getApproval(id);
    if (prior.status === 'allowed' || prior.status === 'denied') {
      // A decision that already committed wins against a later cancellation.
      this.settle(id, prior);
      return;
    }
    if (prior.status === 'expired') {
      this.settle(id, undefined, this.pending.get(id)?.cancellation ?? (reason === 'cancelled' ? cancelled(id) : expired(id)));
      return;
    }
    const record: ApprovalRecord = { ...prior, status: 'expired', resolvedAt: new Date().toISOString() };
    try {
      this.store.commit(record.runId, 'approval.expired', { ...this.payload(record), reason }, { approval: copy(record) });
    } catch (error) {
      // A failed expiry never leaves a live waiter able to accept a later allow.
      this.settle(id, undefined, error);
      throw error;
    }
    this.settle(id, undefined, reason === 'cancelled' ? cancelled(id) : expired(id));
  }

  private settle(id: string, record?: ApprovalRecord, error?: unknown): void {
    const live = this.pending.get(id);
    if (!live) return;
    this.pending.delete(id);
    for (const waiter of live.waiters) {
      waiter.detach();
      if (record) waiter.resolve(copy(record));
      else waiter.reject(error);
    }
    live.waiters.clear();
  }
}
