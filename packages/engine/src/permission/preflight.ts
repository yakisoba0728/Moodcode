import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fail } from '../artifacts/validation.js';
import { jsonTextSha256, sha256Hex } from '../shared/canonical.js';
import { deepFreeze, isBoundedText, isSha256, plainRecord } from '../shared/data.js';
import { within } from '../shared/fs.js';
import type { PolicyDecision } from './policy.js';
import { plainList, POLICY_DECISIONS } from './validation.js';

export const COMMAND_PREFLIGHT_LIMITS = Object.freeze({ maxAnalyzers: 32, maxRunningAnalyzers: 8, maxCommandBytes: 64 * 1024, maxFindings: 32, maxResultBytes: 8 * 1024, defaultDeadlineMs: 1000, maxDeadlineMs: 5000 });
export interface CommandPreflightBinding {
  workspaceId: string; workspaceRoot: string; sessionId: string; runId: string;
  command: string; cwd: string; preparedFingerprint: string; policyRevision: number; sourceRevision: string;
}
export interface CommandPreflightFinding { code: string; decision: PolicyDecision; summary: string }
export interface CommandPreflightResult { decision: PolicyDecision; findings: readonly CommandPreflightFinding[] }
export interface CommandPreflightContext {
  readonly binding: Readonly<CommandPreflightBinding>; readonly signal: AbortSignal;
  readonly maxFindings: number; readonly maxResultBytes: number;
}
/** Host-installed trusted analyzer code. This port grants no process, filesystem or network isolation. */
export interface CommandPreflightAnalyzer {
  id: string; revision: number; sourceSha256: string;
  analyze(context: CommandPreflightContext): Promise<CommandPreflightResult>;
}
export interface CapturedCommandPreflight {
  readonly id: string; readonly registryRevision: number; readonly analyzerId: string; readonly analyzerRevision: number;
  readonly analyzerSourceSha256: string; readonly bindingSha256: string; readonly commandSha256: string;
  readonly preparedFingerprint: string;
  readonly policyRevision: number; readonly sourceRevision: string; readonly physicalRevision: string;
}
export type CommandPreflightStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled';
export interface CommandPreflightReceipt extends CapturedCommandPreflight {
  readonly schemaVersion: 1; readonly status: CommandPreflightStatus; readonly decision: PolicyDecision;
  readonly findings: readonly CommandPreflightFinding[]; readonly reason: 'analyzer_result' | 'analyzer_failed' | 'analyzer_timeout' | 'caller_cancelled';
  readonly osIsolation: false; readonly receiptSha256: string;
}
interface Entry extends CommandPreflightAnalyzer { token: symbol }
interface Capture { entry: Entry; binding: Readonly<CommandPreflightBinding>; used: boolean }
function text(value: unknown, max = 512): asserts value is string { if (!isBoundedText(value, max)) fail('INVALID_COMMAND_PREFLIGHT', 'Preflight identity requires bounded text'); }
function record(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  plainRecord(value, [], fields, fault => fail('INVALID_COMMAND_PREFLIGHT', fault === 'shape' ? 'Preflight requires typed plain records' : 'Preflight records cannot contain accessors, hidden fields or symbols'));
}
function findingsList(value: unknown): asserts value is unknown[] {
  plainList(value, COMMAND_PREFLIGHT_LIMITS.maxFindings, fault => fail('INVALID_COMMAND_PREFLIGHT_RESULT', fault === 'shape' ? 'Analyzer findings require a plain array' : fault === 'limit' ? 'Too many analyzer findings' : 'Analyzer findings cannot be sparse, contain accessors or custom fields'));
}
function revision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_COMMAND_PREFLIGHT', 'Preflight revision must be a positive safe integer'); }
function binding(value: CommandPreflightBinding): Readonly<CommandPreflightBinding> {
  record(value, ['workspaceId', 'workspaceRoot', 'sessionId', 'runId', 'command', 'cwd', 'preparedFingerprint', 'policyRevision', 'sourceRevision']);
  for (const name of ['workspaceId', 'sessionId', 'runId', 'preparedFingerprint', 'sourceRevision'] as const) text(value[name]); revision(value.policyRevision);
  for (const path of [value.workspaceRoot, value.cwd]) { text(path, 4096); if (!isAbsolute(path) || resolve(path) !== path) fail('INVALID_COMMAND_PREFLIGHT_PATH', 'Preflight root and cwd must be exact canonical absolute paths'); }
  if (typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0') || Buffer.byteLength(value.command) > COMMAND_PREFLIGHT_LIMITS.maxCommandBytes) fail('INVALID_COMMAND_PREFLIGHT', 'Preflight command must be exact bounded command text');
  return deepFreeze(structuredClone(value));
}
async function physical(value: Readonly<CommandPreflightBinding>): Promise<string> {
  const root = await lstat(value.workspaceRoot), cwd = await lstat(value.cwd);
  if (!root.isDirectory() || root.isSymbolicLink() || !cwd.isDirectory() || cwd.isSymbolicLink() || await realpath(value.workspaceRoot) !== value.workspaceRoot || await realpath(value.cwd) !== value.cwd || !within(value.workspaceRoot, value.cwd)) fail('COMMAND_PREFLIGHT_PATH_CHANGED', 'Preflight root/cwd must remain canonical directories inside the workspace');
  return jsonTextSha256([value.workspaceRoot, String(root.dev), String(root.ino), value.cwd, String(cwd.dev), String(cwd.ino)]);
}
function result(value: unknown): CommandPreflightResult {
  record(value, ['decision', 'findings']);
  if (!POLICY_DECISIONS.has(value.decision as PolicyDecision)) fail('INVALID_COMMAND_PREFLIGHT_RESULT', 'Analyzer result must have a typed decision');
  findingsList(value.findings);
  const findings: CommandPreflightFinding[] = [];
  for (const finding of value.findings) {
    record(finding, ['code', 'decision', 'summary']); text(finding.code, 128); text(finding.summary, 1024);
    if (!POLICY_DECISIONS.has(finding.decision as PolicyDecision)) fail('INVALID_COMMAND_PREFLIGHT_RESULT', 'Invalid analyzer finding decision');
    findings.push({ code: finding.code, decision: finding.decision as PolicyDecision, summary: finding.summary });
  }
  const output = { decision: value.decision as PolicyDecision, findings };
  if (Buffer.byteLength(JSON.stringify(output)) > COMMAND_PREFLIGHT_LIMITS.maxResultBytes) fail('COMMAND_PREFLIGHT_RESULT_LIMIT', 'Analyzer result exceeds the result byte limit');
  // A contradictory aggregate can only be narrowed, never turn a deny finding into allowance.
  if (findings.some(finding => finding.decision === 'deny')) output.decision = 'deny';
  else if (output.decision !== 'deny' && findings.some(finding => finding.decision === 'ask')) output.decision = 'ask';
  return deepFreeze(output);
}

/** In-memory optional prepare-side analyzer. No analyzer dispatch is a shell invocation or approval receipt. */
export class CommandPreflightRegistry {
  private readonly entries = new Map<string, Entry>(); private current = 0;
  private running = 0;
  private readonly requests = new WeakMap<CapturedCommandPreflight, Capture>();
  private readonly receipts = new WeakMap<CommandPreflightReceipt, CapturedCommandPreflight>();
  get revision(): number { return this.current; }
  /** Includes callbacks that ignored a timeout/cancellation; timeout is not proof that host code stopped. */
  get runningAnalyzers(): number { return this.running; }
  register(analyzer: CommandPreflightAnalyzer): () => void {
    text(analyzer.id, 128); revision(analyzer.revision);
    if (!isSha256(analyzer.sourceSha256) || typeof analyzer.analyze !== 'function') fail('INVALID_COMMAND_PREFLIGHT', 'Analyzer requires a source hash and trusted host handler');
    if (this.entries.has(analyzer.id)) fail('COMMAND_PREFLIGHT_CONFLICT', 'Analyzer ID already registered');
    if (this.entries.size >= COMMAND_PREFLIGHT_LIMITS.maxAnalyzers) fail('COMMAND_PREFLIGHT_REGISTRY_LIMIT', 'Too many preflight analyzers');
    const entry: Entry = { id: analyzer.id, revision: analyzer.revision, sourceSha256: analyzer.sourceSha256, analyze: analyzer.analyze.bind(analyzer), token: Symbol(analyzer.id) };
    this.entries.set(entry.id, entry); this.current++;
    return () => { if (this.entries.get(entry.id)?.token === entry.token) { this.entries.delete(entry.id); this.current++; } };
  }
  async capture(value: CommandPreflightBinding, analyzerId: string, signal?: AbortSignal): Promise<CapturedCommandPreflight> {
    this.active(signal); const exact = binding(value); text(analyzerId, 128); const entry = this.entries.get(analyzerId);
    if (!entry) fail('COMMAND_PREFLIGHT_UNAVAILABLE', 'Requested trusted analyzer is not registered');
    const registryRevision = this.current; const physicalRevision = await physical(exact); this.active(signal);
    if (this.current !== registryRevision || this.entries.get(analyzerId)?.token !== entry.token) fail('COMMAND_PREFLIGHT_STALE', 'Analyzer registration changed during capture');
    const request = deepFreeze({ id: randomUUID(), registryRevision, analyzerId: entry.id, analyzerRevision: entry.revision, analyzerSourceSha256: entry.sourceSha256,
      bindingSha256: jsonTextSha256(exact), commandSha256: sha256Hex(exact.command), preparedFingerprint: exact.preparedFingerprint, policyRevision: exact.policyRevision, sourceRevision: exact.sourceRevision, physicalRevision });
    this.requests.set(request, { entry, binding: exact, used: false }); return request;
  }
  async run(request: CapturedCommandPreflight, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<CommandPreflightReceipt> {
    const deadline = options.deadlineMs ?? COMMAND_PREFLIGHT_LIMITS.defaultDeadlineMs;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > COMMAND_PREFLIGHT_LIMITS.maxDeadlineMs) fail('INVALID_COMMAND_PREFLIGHT', 'Preflight deadline must be a bounded integer');
    const capture = this.get(request); if (capture.used) fail('COMMAND_PREFLIGHT_USED', 'Preflight request has already run');
    this.assertRegistry(request, capture); if (await physical(capture.binding) !== request.physicalRevision) fail('COMMAND_PREFLIGHT_STALE', 'Preflight root/cwd changed');
    this.assertRegistry(request, capture); if (capture.used) fail('COMMAND_PREFLIGHT_USED', 'Preflight request has already run');
    if (!options.signal?.aborted && this.running >= COMMAND_PREFLIGHT_LIMITS.maxRunningAnalyzers) fail('COMMAND_PREFLIGHT_RUNNING_LIMIT', 'Outstanding analyzer callbacks reached the host limit');
    capture.used = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
    type Completion = { status: CommandPreflightStatus; result?: CommandPreflightResult };
    const interruption = new Promise<Completion>(resolve => {
      stop = () => { controller.abort(options.signal?.reason); resolve({ status: 'cancelled' }); };
      if (options.signal?.aborted) stop();
      else { options.signal?.addEventListener('abort', stop, { once: true }); timer = setTimeout(() => { controller.abort(); resolve({ status: 'timed_out' }); }, deadline); }
    });
    const dispatch = !controller.signal.aborted; if (dispatch) this.running++;
    const analysis: Promise<Completion> = !dispatch ? Promise.resolve({ status: 'cancelled' }) : Promise.resolve().then(async () => {
      if (controller.signal.aborted) return { status: 'cancelled' as const };
      try { return { status: 'completed' as const, result: result(await capture.entry.analyze(Object.freeze({ binding: capture.binding, signal: controller.signal, maxFindings: COMMAND_PREFLIGHT_LIMITS.maxFindings, maxResultBytes: COMMAND_PREFLIGHT_LIMITS.maxResultBytes }))) }; }
      catch { return { status: 'failed' as const }; }
    }).finally(() => { this.running--; });
    let completion: Completion;
    try { completion = await Promise.race([analysis, interruption]); }
    finally { if (timer !== undefined) clearTimeout(timer); if (stop) options.signal?.removeEventListener('abort', stop); }
    // An uncooperative trusted callback may still be running. Abort is a notification, never proof of physical cleanup.
    this.assertRegistry(request, capture); if (await physical(capture.binding) !== request.physicalRevision) fail('COMMAND_PREFLIGHT_STALE', 'Preflight root/cwd changed during analysis');
    if (options.signal?.aborted && completion.status === 'completed') completion = { status: 'cancelled' };
    const status = completion.status;
    const data = { ...request, schemaVersion: 1 as const, status, decision: completion.result?.decision ?? 'ask' as PolicyDecision,
      findings: completion.result?.findings ?? [], reason: (status === 'completed' ? 'analyzer_result' : status === 'failed' ? 'analyzer_failed' : status === 'timed_out' ? 'analyzer_timeout' : 'caller_cancelled') as CommandPreflightReceipt['reason'], osIsolation: false as const };
    const receipt = deepFreeze({ ...data, receiptSha256: jsonTextSha256(data) }); this.receipts.set(receipt, request); return receipt;
  }
  async assertCurrent(receipt: CommandPreflightReceipt, current: CommandPreflightBinding, signal?: AbortSignal): Promise<void> {
    this.active(signal); const request = this.receipts.get(receipt);
    if (!request || jsonTextSha256(binding(current)) !== request.bindingSha256) fail('COMMAND_PREFLIGHT_STALE', 'Preflight receipt must belong to the exact current prepared command and revisions');
    const capture = this.get(request); this.assertRegistry(request, capture);
    if (await physical(capture.binding) !== request.physicalRevision) fail('COMMAND_PREFLIGHT_STALE', 'Preflight workspace/cwd changed before dispatch'); this.active(signal);
  }
  /** Combine with existing policy/prepared requirements; preflight can only narrow authority. */
  decision(receipt: CommandPreflightReceipt, base: PolicyDecision, requiresApproval: boolean): PolicyDecision {
    if (!this.receipts.has(receipt) || !POLICY_DECISIONS.has(base) || typeof requiresApproval !== 'boolean') fail('INVALID_COMMAND_PREFLIGHT_RECEIPT', 'Preflight decision requires an issued receipt and exact base approval requirement');
    if (base === 'deny' || receipt.decision === 'deny') return 'deny';
    return base === 'ask' || requiresApproval || receipt.decision === 'ask' || receipt.status !== 'completed' ? 'ask' : 'allow';
  }
  private get(request: CapturedCommandPreflight): Capture { const capture = this.requests.get(request); if (!capture) fail('INVALID_COMMAND_PREFLIGHT_REQUEST', 'Request was not captured by this registry'); return capture; }
  private assertRegistry(request: CapturedCommandPreflight, capture: Capture): void { if (request.registryRevision !== this.current || this.entries.get(request.analyzerId)?.token !== capture.entry.token) fail('COMMAND_PREFLIGHT_STALE', 'Analyzer source or registry revision changed'); }
  private active(signal?: AbortSignal): void { if (signal?.aborted) fail('CANCELLED', 'Command preflight cancelled'); }
}
