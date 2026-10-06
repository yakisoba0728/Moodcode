import { EngineError, isTerminal, type AcceptInput, type InputReceipt, type InputRecord, type SessionControl, type SubmitInput, type RunReceipt } from '@moodcode/contracts';
import { normalizeAcceptInput, normalizeEngineBudgets } from '@moodcode/contracts/validation';
import type { SessionEngineStore } from '../ports.js';
import { RunCoordinator } from './index.js';

interface Flight { sessionId: string; workspaceId: string; done: Promise<void>; resolve(): void; reject(error: unknown): void; running: boolean; queued: boolean }
export interface InputSchedulerOptions { store: SessionEngineStore; coordinator: RunCoordinator }

/** One owner per session; workspace tickets wait in order and independent workspaces run concurrently. */
export class InputScheduler {
  private readonly flights = new Map<string, Flight>();
  private readonly ready: string[] = [];
  private readonly busyWorkspaces = new Set<string>();
  private scheduled = false;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: InputSchedulerOptions) {
    options.coordinator.setSessionHooks({
      boundary: run => this.applySteers(run.id),
      cancelled: run => { options.store.setSessionPaused(run.sessionId, true, 'run_cancelled'); },
      settled: run => {
        if (run.state !== 'completed') {
          const uncertain = !isTerminal(run.state) || run.state === 'interrupted' || ['CLEANUP_UNCERTAIN', 'PROVIDER_TIMEOUT', 'PROVIDER_TRANSPORT_ERROR', 'PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_INACTIVITY_TIMEOUT'].includes(run.error?.code ?? '');
          options.store.setSessionPaused(run.sessionId, true, uncertain ? 'recovery_required' : 'run_cancelled');
        }
        if (!this.closing) void this.wake(run.sessionId).catch(() => {});
      },
      workspaceIdle: () => this.schedule(),
    });
  }
  accept(value: AcceptInput): InputReceipt {
    this.assertOpen();
    const input = normalizeAcceptInput(value);
    const receipt = this.options.store.acceptInput(input);
    // Durable acceptance succeeds independently from an unavailable background wake.
    void this.wake(input.sessionId).catch(() => {});
    return receipt;
  }
  /** Keep v1 immediate/busy receipts while joining the shared session owner. */
  submitLegacy(input: SubmitInput): RunReceipt {
    this.assertOpen();
    const receipt = this.options.coordinator.submit(input);
    void this.wake(input.sessionId).catch(() => {});
    return receipt;
  }
  pause(sessionId: string): SessionControl { this.assertOpen(); return this.options.store.setSessionPaused(sessionId, true, 'user'); }
  resume(sessionId: string): SessionControl {
    this.assertOpen();
    const session = this.options.store.getSession(sessionId);
    // Resume never clears a workspace quarantine or dispatches an interrupted Run again.
    if (this.options.store.getSessionControl(sessionId).reason === 'recovery_required') this.options.coordinator.assertWorkspaceAvailable(session.workspaceId);
    const control = this.options.store.setSessionPaused(sessionId, false);
    void this.wake(sessionId).catch(() => {});
    return control;
  }
  cancelInput(inputId: string): InputRecord { this.assertOpen(); return this.options.store.cancelInput(inputId); }
  wake(sessionId: string): Promise<void> {
    try {
    this.assertOpen();
    const known = this.flights.get(sessionId);
    if (known) { this.schedule(); return known.done; }
    const session = this.options.store.getSession(sessionId);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => {});
    const flight: Flight = { sessionId, workspaceId: session.workspaceId, done, resolve, reject, running: false, queued: true };
    this.flights.set(sessionId, flight); this.ready.push(sessionId); this.schedule();
    return done;
    } catch (error) { return Promise.reject(error); }
  }
  waitForSession(sessionId: string): Promise<void> { return this.flights.get(sessionId)?.done ?? Promise.resolve(); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const active = [...this.flights.values()];
    for (const flight of active) if (!flight.running) this.finish(flight);
    this.closePromise = Promise.allSettled(active.map(flight => flight.done)).then(() => {});
    return this.closePromise;
  }
  private assertOpen(): void { if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Input scheduler is closing'); }
  private schedule(): void {
    if (this.closing || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }
  private finish(flight: Flight, error?: unknown): void {
    this.flights.delete(flight.sessionId); flight.queued = false;
    if (error) flight.reject(error); else flight.resolve();
  }
  private drain(): void {
    if (this.closing) return;
    const tickets = this.ready.splice(0);
    for (const sessionId of tickets) {
      const flight = this.flights.get(sessionId);
      if (!flight || flight.running) continue;
      flight.queued = false;
      try {
        if (this.options.store.getSessionControl(sessionId).paused) { this.finish(flight); continue; }
        if (this.busyWorkspaces.has(flight.workspaceId)) { this.enqueue(flight); continue; }
        const active = this.options.coordinator.activeRun(sessionId);
        if (active) { this.run(flight, this.options.coordinator.waitForRun(active.id)); continue; }
        if (!this.options.store.pendingInputs(sessionId, undefined, 1).length) { this.finish(flight); continue; }
        this.options.coordinator.assertWorkspaceAvailable(flight.workspaceId);
        const input = this.options.store.pendingInputs(sessionId, undefined, 1)[0]!;
        const promoted = this.options.store.promoteInput(input.id);
        this.run(flight, this.options.coordinator.startPromoted(promoted.run.id));
      } catch (error) {
        if (error instanceof EngineError && error.code === 'WORKSPACE_BUSY') this.enqueue(flight);
        else {
          if (error instanceof EngineError && error.code === 'CLEANUP_PENDING') this.options.store.setSessionPaused(sessionId, true, 'recovery_required');
          this.finish(flight, error);
        }
      }
    }
  }
  private enqueue(flight: Flight): void { if (!flight.queued && !this.closing) { flight.queued = true; this.ready.push(flight.sessionId); } }
  private run(flight: Flight, done: Promise<import('@moodcode/contracts').Run>): void {
    flight.running = true; this.busyWorkspaces.add(flight.workspaceId);
    void done.then(run => {
      if (!isTerminal(run.state)) throw new EngineError('RUN_NOT_SETTLED', 'Run did not reach a durable terminal state');
    }).catch(error => { this.finish(flight, error); }).finally(() => {
      flight.running = false; this.busyWorkspaces.delete(flight.workspaceId);
      if (this.flights.has(flight.sessionId)) {
        if (this.closing) this.finish(flight);
        else this.enqueue(flight);
      }
      this.schedule();
    });
  }
  private applySteers(runId: string): boolean {
    if (this.closing) return false;
    const run = this.options.store.getRun(runId);
    if (isTerminal(run.state) || run.state === 'cancelling' || this.options.store.getSessionControl(run.sessionId).paused) return false;
    const budgets = normalizeEngineBudgets(run.config.budgets);
    // This synchronous query fixes admission cutoff before the next provider dispatch.
    const pending = this.options.store.pendingInputs(run.sessionId, 'steer', Math.min(100, budgets.maxSteerBatch));
    const inputIds: string[] = [];
    for (const input of pending) {
      if (JSON.stringify(input.config) !== JSON.stringify(run.config)) break;
      inputIds.push(input.id);
    }
    if (!inputIds.length) return false;
    this.options.store.promoteSteers(inputIds, runId);
    return true;
  }
}
