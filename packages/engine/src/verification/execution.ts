import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type ArtifactReference, type Checkpoint, type JsonObject, type Run } from '@moodcode/contracts';
import type { ToolContext, ToolResult } from '../ports.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createToolResultEnvelope } from '../artifacts/result.js';
import { textPrefix } from '../artifacts/validation.js';
import { COMMAND_LIMITS } from '../tools/command/index.js';
import type { ScopedToolRuntime, ToolCatalogue } from '../tools/runtime/index.js';
import type { SessionDocument } from '../session-state/index.js';
import type { VerificationPlanService } from './plans.js';
import type { VerificationReceiptService } from './receipts.js';
import { normalizeVerificationSource, verificationDigest, verificationFail, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText,
  type VerificationCheck, type VerificationCommandCapability, type VerificationObservation, type VerificationReceipt, type VerificationSource } from './types.js';

export interface VerificationToolHost {
  plans: VerificationPlanService; receipts: VerificationReceiptService;
  getRun(runId: string): Run;
  /** Current authenticated parent catalogue, including its exact allowed/discovery/profile capture. */
  captureCatalogue(context: ToolContext): ToolCatalogue;
  /** Host observes a previously configured bounded physical source scope; no model-selected paths. */
  sourceObservation(context: ToolContext, signal: AbortSignal): Promise<VerificationSource>;
  /** Must contain the engine-owned createCommandTool registration; plugin output is not command evidence. */
  commandRuntime: ScopedToolRuntime;
  /** Root independently authenticates its retained native registration witness before reading the actual execution platform. */
  commandCapability?(context: ToolContext, catalogue: ToolCatalogue): VerificationCommandCapability;
  /** Only the original still-live actual outer context can publish one consumed observation while cancelling. */
  consumedSettlementWriter?(context: ToolContext, kind: string, expectedRevision: number, data: JsonObject): SessionDocument;
  artifacts: ArtifactStore | Promise<ArtifactStore> | (() => ArtifactStore | Promise<ArtifactStore>);
}

export const VERIFICATION_EXECUTION_LIMITS = Object.freeze({ sourceAfterTimeoutMs: 1000, evidenceTimeoutMs: 1000, maxCheckpoints: 2 });
const COMMAND_DATA_KEYS = ['status', 'command', 'cwd', 'timeoutMs', 'exitCode', 'signal', 'cancelled', 'timedOut', 'cleanupConfirmed', 'started', 'terminationScope', 'outputAccounting', 'outputAccountingComplete', 'unobservedBytes', 'error', 'stdout', 'stderr', 'checkpointId', 'checkpointIncomplete', 'warnings', 'limits'];
const OUTPUT_KEYS = ['text', 'totalBytes', 'observedBytes', 'capturedBytes', 'captureTruncatedBytes', 'modelBytes', 'modelSourceBytes', 'modelTruncatedBytes', 'artifactBytes', 'artifactTruncatedBytes'];

export async function observeVerificationSource(host: VerificationToolHost, context: ToolContext, signal: AbortSignal): Promise<VerificationSource> {
  if (signal.aborted) verificationFail('CANCELLED', 'Verification source observation was cancelled');
  const source = normalizeVerificationSource(await host.sourceObservation(context, signal));
  if (signal.aborted) verificationFail('CANCELLED', 'Verification source observation was cancelled');
  return source;
}
export async function observeVerificationSourceAfter(host: VerificationToolHost, context: ToolContext): Promise<VerificationSource | null> {
  const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([observeVerificationSource(host, context, control.signal), new Promise<null>(resolveWait => { timer = setTimeout(() => { control.abort(); resolveWait(null); }, VERIFICATION_EXECUTION_LIMITS.sourceAfterTimeoutMs); })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); control.abort(); }
}
export function verificationExecutionBinding(context: ToolContext): string {
  return JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId, context.executionLockPath, context.artifactDir]);
}
export function verificationCatalogueIdentity(catalogue: ToolCatalogue): string {
  return verificationHash({ scopeId: catalogue.scopeId, revision: catalogue.revision, policyVersion: catalogue.policyVersion, mode: catalogue.mode, profile: catalogue.profile ?? null, tools: catalogue.tools });
}
export function verificationNestedContext(context: ToolContext, check: VerificationCheck, onPublished?: (checkpoint: Checkpoint) => void): ToolContext {
  verificationNumber(context.limits.toolTimeoutMs, Number.MAX_SAFE_INTEGER, 1); verificationNumber(context.limits.maxOutputBytes, Number.MAX_SAFE_INTEGER, 1);
  return { ...context, limits: { ...context.limits, toolTimeoutMs: Math.min(context.limits.toolTimeoutMs, check.timeoutMs), maxOutputBytes: Math.min(context.limits.maxOutputBytes, check.maxOutputBytes) },
    recordCheckpoint: onPublished ? checkpoint => { context.recordCheckpoint(checkpoint); onPublished(checkpoint); } : context.recordCheckpoint };
}
export async function assertVerificationCwd(context: ToolContext, check: VerificationCheck): Promise<void> {
  const root = resolve(context.workspace.root), rel = relative(root, check.cwd);
  if (root !== context.workspace.root || await realpath(root) !== root || !isAbsolute(check.cwd) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || await realpath(check.cwd) !== check.cwd || !(await lstat(check.cwd)).isDirectory()) verificationFail('VERIFICATION_CWD_STALE', 'Exact verification cwd or canonical workspace scope changed');
}
function publishedCheckpoint(checkpoint: Checkpoint, context: ToolContext): JsonObject {
  if (checkpoint.runId !== context.runId || checkpoint.toolCallId !== context.toolCallId || checkpoint.kind !== 'command') verificationFail('VERIFICATION_CHECKPOINT_MISMATCH', 'Actual published checkpoint belongs to another command execution');
  verificationText(checkpoint.id); verificationText(checkpoint.createdAt);
  if (!Array.isArray(checkpoint.files) || checkpoint.files.length > 20_000) verificationFail('VERIFICATION_CHECKPOINT_LIMIT', 'Command checkpoint file projection exceeds its bounds');
  const files = checkpoint.files.map(file => {
    verificationText(file.path, 4096); if (file.beforeHash !== null) verificationDigest(file.beforeHash); if (file.afterHash !== null) verificationDigest(file.afterHash);
    return { path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash };
  });
  return { id: checkpoint.id, runId: checkpoint.runId, toolCallId: checkpoint.toolCallId, kind: checkpoint.kind, createdAt: checkpoint.createdAt, incomplete: Boolean(checkpoint.incomplete), files };
}

export interface OwnedCommandObservation {
  data: JsonObject; observation: VerificationObservation; rawLogs: Array<{ path: string; bytes: number; truncated: boolean; stream: 'stdout' | 'stderr' }>;
}
/** Called only with the value returned by the retained runtime-owned run_command capability. */
export function observeOwnedCommandResult(result: ToolResult, check: VerificationCheck, receipt: VerificationReceipt, context: ToolContext, checkpoints: readonly Checkpoint[], sourceAfter: VerificationSource | null): OwnedCommandObservation {
  verificationPlain(result.data, COMMAND_DATA_KEYS);
  const data = result.data as JsonObject;
  if (![data.started, data.cancelled, data.timedOut, data.cleanupConfirmed].every(value => typeof value === 'boolean')) verificationFail('VERIFICATION_COMMAND_OBSERVATION_INVALID', 'Owned command did not provide its actual process outcome');
  if (data.started && (data.command !== check.command || data.cwd !== check.cwd || data.timeoutMs !== Math.min(check.timeoutMs, context.limits.toolTimeoutMs, COMMAND_LIMITS.maxTimeoutMs) || data.terminationScope !== 'posix-process-group')) verificationFail('VERIFICATION_COMMAND_OBSERVATION_MISMATCH', 'Owned command result differs from the exact captured command');
  const checkpoint = typeof data.checkpointId === 'string' ? checkpoints.find(value => value.id === data.checkpointId) : undefined;
  const checkpointEvidence = checkpoint ? publishedCheckpoint(checkpoint, context) : null;
  let observedOutputBytes: number | null = null;
  const rawLogs: OwnedCommandObservation['rawLogs'] = [];
  if (data.stdout !== undefined || data.stderr !== undefined) {
    let bytes = 0;
    for (const stream of ['stdout', 'stderr'] as const) {
      verificationPlain(data[stream], OUTPUT_KEYS); const output = data[stream] as JsonObject;
      verificationNumber(output.observedBytes); verificationNumber(output.artifactBytes, COMMAND_LIMITS.artifactBytes); verificationNumber(output.totalBytes);
      if (output.observedBytes !== output.totalBytes) verificationFail('VERIFICATION_COMMAND_OBSERVATION_INVALID', 'Command output observations disagree');
      bytes += output.observedBytes as number;
    }
    verificationNumber(bytes); observedOutputBytes = bytes;
    if (!Array.isArray(result.artifacts) || result.artifacts.length !== 2) verificationFail('VERIFICATION_COMMAND_LOGS_MISSING', 'Actual command logs are missing');
    for (let index = 0; index < 2; index++) {
      const artifact = result.artifacts[index]!; verificationPlain(artifact, ['path', 'bytes', 'truncated']); verificationText(artifact.path, 4096); verificationNumber(artifact.bytes, COMMAND_LIMITS.artifactBytes);
      const stream = index === 0 ? 'stdout' : 'stderr';
      if (typeof artifact.truncated !== 'boolean' || basename(artifact.path) !== `${stream}.log` || artifact.bytes !== (data[stream] as JsonObject).artifactBytes) verificationFail('VERIFICATION_COMMAND_LOGS_MISMATCH', 'Actual command log and stream byte observations disagree');
      rawLogs.push({ ...artifact, stream });
    }
  }
  const cleanupScope = data.started ? 'posix-process-group' : 'not-dispatched';
  const evidence = data.started && checkpointEvidence ? verificationHash({ producer: 'run_command', command: check.command, cwd: check.cwd, toolCallId: receipt.toolCallId, preparedFingerprint: receipt.preparedFingerprint,
    exitCode: data.exitCode, signal: data.signal, cleanupConfirmed: data.cleanupConfirmed, terminationScope: data.terminationScope, checkpoint: checkpointEvidence }) : null;
  const observation: VerificationObservation = {
    disposition: 'executed', command: check.command, cwd: check.cwd, profileId: check.profileId, profileRevision: check.profileRevision, toolCallId: receipt.toolCallId, preparedFingerprint: receipt.preparedFingerprint,
    sourceBefore: { ...receipt.sourceBefore }, sourceAfter, executionCheckpointId: checkpoint?.id ?? null,
    exitCode: data.exitCode as number | null, signal: data.signal as string | null, started: data.started as boolean, cancelled: data.cancelled as boolean, timedOut: data.timedOut as boolean,
    cleanup: { confirmed: data.cleanupConfirmed as boolean, scope: cleanupScope, evidenceSha256: evidence }, observedOutputBytes, outputAccountingComplete: data.outputAccountingComplete === true,
    artifactRefs: [], executionComplete: !data.started || checkpoint !== undefined && !(typeof data.error === 'string') && (data.status === 'completed' || data.exitCode !== 0 || data.cancelled === true || data.timedOut === true), reasonCode: null,
  };
  if (data.started && !checkpoint) observation.reasonCode = 'PUBLISHED_CHECKPOINT_MISSING';
  return { data, observation, rawLogs };
}

function evidenceActive(signal: AbortSignal): void { if (signal.aborted) verificationFail('VERIFICATION_EVIDENCE_TIMEOUT', 'Actual command evidence inspection exceeded its bounded deadline'); }
async function readActualLog(log: OwnedCommandObservation['rawLogs'][number], context: ToolContext, signal: AbortSignal): Promise<Buffer> {
  evidenceActive(signal);
  const root = resolve(context.artifactDir), path = resolve(log.path), rel = relative(root, path);
  if (await realpath(root) !== root || path !== log.path || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || await realpath(path) !== path) verificationFail('VERIFICATION_LOG_PATH_UNSAFE', 'Actual command log escaped its canonical artifact directory');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== log.bytes) verificationFail('VERIFICATION_LOG_INTEGRITY_FAILED', 'Actual command log file identity or size changed');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== log.bytes) verificationFail('VERIFICATION_LOG_INTEGRITY_FAILED', 'Actual command log changed before reading');
    const bytes = Buffer.alloc(log.bytes + 1); let length = 0;
    while (length < bytes.length) { evidenceActive(signal); const chunk = await handle.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    const after = await handle.stat(), named = await lstat(path);
    if (length !== log.bytes || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.dev !== before.dev || named.ino !== before.ino || await realpath(path) !== path) verificationFail('VERIFICATION_LOG_INTEGRITY_FAILED', 'Actual command log changed during its bounded read');
    evidenceActive(signal);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
/** Imports only physically read original bytes; command paths never appear in public receipt refs. */
export async function importOwnedCommandEvidence(host: VerificationToolHost, owned: OwnedCommandObservation, result: ToolResult, receipt: VerificationReceipt, context: ToolContext): Promise<ArtifactReference[]> {
  const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([importActualEvidence(host, owned, result, receipt, context, control.signal), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { control.abort(); reject(new Error('Evidence deadline')); }, VERIFICATION_EXECUTION_LIMITS.evidenceTimeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); control.abort(); }
}
async function importActualEvidence(host: VerificationToolHost, owned: OwnedCommandObservation, result: ToolResult, receipt: VerificationReceipt, context: ToolContext, signal: AbortSignal): Promise<ArtifactReference[]> {
  const artifacts = await (typeof host.artifacts === 'function' ? host.artifacts() : host.artifacts);
  evidenceActive(signal);
  const owner = { sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) };
  const refs: ArtifactReference[] = []; let remaining = Math.min(COMMAND_LIMITS.artifactBytes, context.budgets?.maxArtifactBytes ?? COMMAND_LIMITS.artifactBytes, artifacts.limits.maxArtifactBytes, artifacts.limits.maxProducerBytes);
  for (const log of owned.rawLogs) {
    const bytes = await readActualLog(log, context, signal), count = Math.min(bytes.byteLength, remaining); remaining -= count;
    const stored = await artifacts.put({ identity: owner, content: bytes.subarray(0, count), outcome: result.structuredResult?.outcome ?? (result.isError ? 'failed' : 'completed'), sourceComplete: !log.truncated && count === bytes.byteLength && owned.observation.outputAccountingComplete,
      metadata: { producerTool: 'run_command', verificationReceiptId: receipt.id, stream: log.stream, originalLogBytes: bytes.byteLength, originalLogSha256: createHash('sha256').update(bytes).digest('hex') }, signal });
    evidenceActive(signal); refs.push(stored.reference); owned.observation.artifactRefs = [...refs];
  }
  for (const ref of result.structuredResult?.artifactRefs ?? []) {
    if (refs.length >= 4) verificationFail('VERIFICATION_ARTIFACT_LIMIT', 'Owned command has too many receipt artifacts');
    evidenceActive(signal); const actual = await artifacts.read(ref.id, { identity: owner, limit: 1, signal });
    if (verificationHash(actual.reference) !== verificationHash(ref)) verificationFail('VERIFICATION_ARTIFACT_CHANGED', 'Owned command artifact reference differs from its stored original');
    evidenceActive(signal); refs.push(actual.reference); owned.observation.artifactRefs = [...refs];
  }
  return refs;
}
export function verificationResult(result: ToolResult, receipt: VerificationReceipt | null, persistence: 'saved' | 'pending', context: ToolContext, code?: string): ToolResult {
  const status = receipt?.status ?? 'uncertain';
  const verification: JsonObject = { status, sourceStale: receipt?.sourceStale ?? null, persistence, checkId: receipt?.checkId ?? null, receiptId: receipt?.id ?? null, receiptSha256: receipt?.receiptSha256 ?? null, ...(code ? { reasonCode: code } : {}) };
  const data = verificationJson({ ...(result.data as JsonObject ?? {}), verification, ...(status === 'uncertain' || persistence === 'pending' ? { effectsUncertain: true } : {}) });
  const refs = [...new Map([...(receipt?.observation?.artifactRefs ?? []), ...(result.structuredResult?.artifactRefs ?? [])].map(ref => [ref.id, ref])).values()];
  const reads = refs.map(ref => ({ artifactId: ref.id, runId: ref.identity.runId, toolCallId: ref.identity.toolCallId, ...(ref.identity.turnId ? { turnId: ref.identity.turnId } : {}), ...(ref.identity.attemptId ? { attemptId: ref.identity.attemptId } : {}), offset: 0, limit: 8192 }));
  const modelLimit = Math.min(context.limits.maxOutputBytes, 32 * 1024);
  // Prioritize the exact receipt outcome. Artifact read inputs are included only as complete native-contract records.
  const modelReceipt = { status, sourceStale: receipt?.sourceStale ?? null, persistence, checkId: receipt?.checkId ?? null, receiptId: receipt?.id ?? null };
  let includedReads = reads.length;
  const header = () => JSON.stringify({ verification: modelReceipt, ...(includedReads ? { read_artifact: reads.slice(0, includedReads) } : {}), ...(includedReads < reads.length ? { omittedArtifactReadInputs: reads.length - includedReads } : {}) }) + '\n';
  while (includedReads && Buffer.byteLength(header()) > Math.floor(modelLimit * 0.75)) includedReads--;
  const fullHeader = header(), prefix = textPrefix(fullHeader, modelLimit), retained = textPrefix(result.content, Math.max(0, modelLimit - Buffer.byteLength(prefix)));
  const content = prefix + retained;
  const projection: JsonObject = { originalCommandModelBytes: Buffer.byteLength(result.content), retainedCommandModelBytes: Buffer.byteLength(retained), omittedCommandModelBytes: Buffer.byteLength(result.content) - Buffer.byteLength(retained), verificationHeaderTruncated: prefix !== fullHeader, omittedArtifactReadInputs: reads.length - includedReads };
  return { ...result, content, isError: result.isError === true || status !== 'pass' || persistence !== 'saved', data,
    structuredResult: createToolResultEnvelope({ ...(result.structuredResult ?? {}), displayContent: content, modelContent: content, structuredData: data, artifactRefs: refs, metadata: { ...result.structuredResult?.metadata, verification, verificationProjection: projection },
      outcome: status === 'pass' && persistence === 'saved' && result.isError !== true ? 'completed' : result.structuredResult?.outcome === 'interrupted' ? 'interrupted' : 'failed' }, { maxModelBytes: modelLimit, maxDisplayBytes: context.limits.maxOutputBytes }) };
}
