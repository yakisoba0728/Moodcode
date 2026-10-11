import { type ArtifactCheckpointBinding, type ArtifactIdentity, type ArtifactReference, type Checkpoint, type JsonObject, type JsonValue, type ToolResultEnvelope } from '@moodcode/contracts';
import type { ToolContext, ToolResult } from '../ports.js';
import { artifactLimits, type ArtifactLimits } from './limits.js';
import type { ArtifactStore } from './store.js';
import { ARTIFACT_OUTCOMES, boundedJson, fail, identity, JsonBudgetError, reference, sameIdentity, textPrefix } from './validation.js';

export interface ToolResultProjection {
  displayContent: string;
  modelContent?: string;
  structuredData?: JsonValue;
  metadata?: JsonObject;
  warnings?: readonly string[];
  artifactRefs?: readonly ArtifactReference[];
  outcome?: ToolResultEnvelope['outcome'];
}

/** Display, model, data and references have independent budgets and identities. */
export function createToolResultEnvelope(input: ToolResultProjection, options: Partial<ArtifactLimits> = {}): ToolResultEnvelope {
  const limits = artifactLimits(options);
  if (typeof input.displayContent !== 'string' || input.modelContent !== undefined && typeof input.modelContent !== 'string') fail('INVALID_TOOL_RESULT', 'Tool result text must be a string');
  const outcome = input.outcome ?? 'completed';
  if (!ARTIFACT_OUTCOMES.includes(outcome)) fail('INVALID_TOOL_RESULT', 'Invalid tool result outcome');
  const warnings: string[] = [];
  if (input.warnings !== undefined && !Array.isArray(input.warnings)) fail('INVALID_TOOL_RESULT', 'Tool warnings must be an array');
  for (const item of input.warnings ?? []) {
    if (typeof item !== 'string') fail('INVALID_TOOL_RESULT', 'Tool warning must be a string');
    if (warnings.length >= 31) { warnings.push('Additional producer warnings were omitted.'); break; }
    warnings.push(textPrefix(item, 256));
  }
  const displayContent = textPrefix(input.displayContent, limits.maxDisplayBytes);
  const originalModel = input.modelContent ?? input.displayContent;
  const modelContent = textPrefix(originalModel, limits.maxModelBytes);
  if (Buffer.byteLength(input.displayContent) > Buffer.byteLength(displayContent)) warnings.push('Display text was truncated to its byte budget.');
  if (Buffer.byteLength(originalModel) > Buffer.byteLength(modelContent)) warnings.push('Model text was truncated to its byte budget.');
  let structuredData: JsonValue | undefined;
  if (input.structuredData !== undefined) {
    try { structuredData = boundedJson(input.structuredData, limits.maxStructuredBytes); }
    catch (error) {
      if (!(error instanceof JsonBudgetError)) throw error;
      warnings.push('Structured data was omitted because it exceeded its byte budget.');
    }
  }
  let metadata: JsonObject | undefined;
  if (input.metadata !== undefined) {
    try { metadata = boundedJson(input.metadata, limits.maxMetadataBytes) as JsonObject; }
    catch (error) {
      if (!(error instanceof JsonBudgetError)) throw error;
      fail('TOOL_METADATA_LIMIT', 'Tool result metadata exceeds its byte budget');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('INVALID_TOOL_RESULT', 'Tool result metadata must be an object');
  }
  if (input.artifactRefs !== undefined && (!Array.isArray(input.artifactRefs) || input.artifactRefs.length > 32)) fail('INVALID_TOOL_RESULT', 'Too many artifact references');
  const artifactRefs = (input.artifactRefs ?? []).map(reference);
  if (new Set(artifactRefs.map(ref => ref.id)).size !== artifactRefs.length) fail('INVALID_TOOL_RESULT', 'Tool result contains duplicate artifact IDs');
  if (Buffer.byteLength(JSON.stringify({ metadata, warnings, artifactRefs })) > limits.maxMetadataBytes) fail('TOOL_METADATA_LIMIT', 'Tool result references and warnings exceed the metadata byte budget');
  return { displayContent, modelContent, ...(structuredData === undefined ? {} : { structuredData }),
    ...(metadata === undefined ? {} : { metadata }), warnings, artifactRefs, outcome };
}

export function projectToolResult(input: ToolResultProjection, options: Partial<ArtifactLimits> = {}): ToolResult {
  const envelope = createToolResultEnvelope(input, options);
  return { content: envelope.modelContent, ...(envelope.outcome === 'completed' ? {} : { isError: true }),
    ...(envelope.structuredData === undefined ? {} : { data: envelope.structuredData }), structuredResult: envelope };
}

/** Attaches a bounded envelope without changing the producer's content, data or artifact paths. */
export function enrichLegacyToolResult(result: ToolResult, input: Omit<ToolResultProjection, 'displayContent'> & { displayContent?: string } = {}, options: Partial<ArtifactLimits> = {}): ToolResult {
  const structuredResult = createToolResultEnvelope({ displayContent: input.displayContent ?? result.content,
    modelContent: input.modelContent ?? result.content, ...(result.data === undefined ? {} : { structuredData: result.data }),
    outcome: result.isError ? 'failed' : 'completed', ...input }, options);
  return { ...result, structuredResult };
}

export interface ToolResultSettlement {
  toolName: string;
  context: ToolContext;
  artifactsUnavailable?: Readonly<{ code: string; reason: string }>;
  /** Omitted when no artifact store is configured. */
  store?: () => Promise<ArtifactStore>;
  onStoreFailure?: () => void;
}

/** Keeps a split final scalar's U+FFFD when it still fits; textPrefix would drop it. */
function utf8BytePrefix(text: string, maximum: number): string {
  let bytes = Buffer.from(text).subarray(0, maximum);
  while (bytes.length && Buffer.from(bytes.toString('utf8')).length > maximum) bytes = bytes.subarray(0, bytes.length - 1);
  return bytes.toString('utf8');
}

/** Projects a producer's returned result and persists its content; never re-runs the producer. */
export async function settleToolResult(result: ToolResult, settlement: ToolResultSettlement): Promise<ToolResult> {
  const { toolName, context, artifactsUnavailable, store } = settlement;
  if (!result || typeof result.content !== 'string' || result.isError !== undefined && typeof result.isError !== 'boolean') fail('INVALID_TOOL_RESULT', 'Tool returned invalid content or outcome');
  const limits = { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) };
  const outcome = context.signal.aborted ? 'interrupted' : result.isError ? 'failed' : 'completed';
  let enriched: ToolResult;
  try { enriched = result.structuredResult ? { ...result, structuredResult: createToolResultEnvelope({ ...result.structuredResult, outcome }, limits) } : enrichLegacyToolResult(result, { outcome }, limits); }
  catch { enriched = { content: result.content, isError: true, ...(result.artifacts ? { artifacts: result.artifacts } : {}), structuredResult: createToolResultEnvelope({ displayContent: result.content, metadata: { resultProjectionFailed: true, producerOutcome: outcome, effectsMayBePresent: true }, warnings: ['Producer returned content, but its structured projection was invalid; recorded checkpoints and returned content remain reviewable.'], outcome: 'failed' }, limits) }; }
  if (artifactsUnavailable) return { ...enriched, structuredResult: createToolResultEnvelope({
    ...enriched.structuredResult!,
    metadata: { ...enriched.structuredResult!.metadata, artifactPersistenceUnavailable: true, artifactPersistenceCode: artifactsUnavailable.code },
    warnings: [...enriched.structuredResult!.warnings, artifactsUnavailable.reason],
  }, limits) };
  if (!store) return enriched;
  // Only this producer's returned bytes can be observed; truncation the producer reports on its artifacts must remain explicit.
  try {
    const artifacts = await store();
    const settlementOutcome = enriched.structuredResult!.outcome;
    let artifactContent = result.content, batchTruncated = false;
    if (context.effectBatchArtifactLimit !== undefined) {
      const maximum = context.effectBatchArtifactLimit;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > (context.budgets?.maxArtifactBytes ?? 0)) fail('EFFECT_BATCH_BUDGET_STALE', 'Original effect artifact allocation changed');
      if (Buffer.byteLength(artifactContent) > maximum) { artifactContent = utf8BytePrefix(artifactContent, maximum); batchTruncated = true; }
    }
    const artifact = await artifacts.put({ identity: { sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) }, content: artifactContent, outcome: batchTruncated ? 'failed' : settlementOutcome, sourceComplete: !batchTruncated && !(result.artifacts?.some(item => item.truncated)), metadata: { toolName, ...(batchTruncated ? { batchOriginalBytes: Buffer.byteLength(result.content), batchArtifactBytes: Buffer.byteLength(artifactContent) } : {}) } });
    return { ...enriched, ...(batchTruncated ? { isError: true } : {}), structuredResult: createToolResultEnvelope({ ...enriched.structuredResult!, ...(batchTruncated ? { outcome: 'failed' as const } : {}), artifactRefs: [...(enriched.structuredResult?.artifactRefs ?? []), artifact.reference], warnings: [...(enriched.structuredResult?.warnings ?? []), ...artifact.warnings, ...(batchTruncated ? ['Effect artifact bytes exceeded the original fixed member allocation. Full effects and checkpoints remain reviewable.'] : [])], outcome: batchTruncated ? 'failed' : settlementOutcome }, limits) };
  } catch {
    settlement.onStoreFailure?.();
    // The producer may already have effects/checkpoints. Preserve that result and expose a partial settlement.
    return { ...enriched, isError: true, structuredResult: createToolResultEnvelope({ displayContent: enriched.structuredResult!.displayContent, modelContent: enriched.structuredResult!.modelContent, structuredData: enriched.structuredResult!.structuredData, metadata: { artifactPersistenceFailed: true, producerOutcome: outcome, effectsMayBePresent: true }, warnings: [...enriched.structuredResult!.warnings, 'Producer returned a result, but its artifact settlement failed; recorded checkpoints and returned content remain reviewable.'], outcome: 'failed' }, limits) };
  }
}

/** Binds the existing review checkpoint to a new turn without rewriting its pre/post images. */
export function bindCheckpointArtifacts(checkpoint: Checkpoint, owner: ArtifactIdentity, refs: readonly ArtifactReference[]): ArtifactCheckpointBinding {
  const canonical = identity(owner);
  if (checkpoint.runId !== canonical.runId || checkpoint.toolCallId !== canonical.toolCallId) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Checkpoint and artifacts must belong to the same execution');
  const execution = checkpoint as Checkpoint & { turnId?: string; attemptId?: string };
  if (execution.turnId !== undefined && execution.turnId !== canonical.turnId || execution.attemptId !== undefined && execution.attemptId !== canonical.attemptId) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Checkpoint turn or attempt identity differs');
  if (typeof checkpoint.id !== 'string' || !checkpoint.id.length || Buffer.byteLength(checkpoint.id) > 512) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Invalid checkpoint ID');
  if (!Array.isArray(refs) || refs.length > 32) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Too many checkpoint artifacts');
  const values = refs.map(reference);
  if (values.some(ref => !sameIdentity(canonical, ref.identity))) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Artifact belongs to a different run, tool call, turn, or attempt');
  if (new Set(values.map(ref => ref.id)).size !== values.length) fail('CHECKPOINT_ARTIFACT_MISMATCH', 'Duplicate checkpoint artifact');
  return { ...canonical, checkpointId: checkpoint.id, artifactIds: values.map(ref => ref.id),
    partial: Boolean(checkpoint.incomplete) || values.some(ref => !ref.complete || ref.outcome !== 'completed') };
}
