import { type ArtifactCheckpointBinding, type ArtifactIdentity, type ArtifactReference, type Checkpoint, type JsonObject, type JsonValue, type ToolResultEnvelope } from '@moodcode/contracts';
import type { ToolResult } from '../ports.js';
import { artifactLimits, type ArtifactLimits } from './limits.js';
import { boundedJson, fail, identity, JsonBudgetError, reference, sameIdentity, textPrefix } from './validation.js';

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
  if (!['completed', 'failed', 'interrupted'].includes(outcome)) fail('INVALID_TOOL_RESULT', 'Invalid tool result outcome');
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

/** Builds the bounded envelope and mirrors its model text and data into ToolResult.content/data. */
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
