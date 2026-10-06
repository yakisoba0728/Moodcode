import { DEFAULT_LIMITS, DEFAULT_ENGINE_BUDGETS, EngineError, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, SESSION_COMMAND_TYPES, REASONING_EFFORTS } from './index.js';
import type { AcceptInput, ArtifactCheckpointBinding, ArtifactReference, ContextRevision, EngineBudgets, EngineEvent, InputReceipt, InputRecord, MessagePart, ProviderAttempt, RunRecordV2, SessionCommandEnvelope, SessionCommandType, SessionEventCursor, SessionEventV2, ToolCallIdentity, ToolResultEnvelope, TurnRecord, CommandEnvelope, JsonObject, JsonValue, RunConfig, RunConfigInput, RunLimits, SubmitInput } from './index.js';

const MAX_ID_BYTES = 256;
const MAX_PROMPT_BYTES = 131_072;
const MAX_PATH_BYTES = 4_096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LIMIT_MAXIMUMS: Readonly<RunLimits> = Object.freeze({
  maxTurns: 128,
  maxToolCalls: 1_024,
  maxDurationMs: 3_600_000,
  toolTimeoutMs: 600_000,
  maxOutputBytes: 1_048_576,
  maxContextBytes: 4_194_304,
});
const LIMIT_KEYS: readonly (keyof RunLimits)[] = [
  'maxTurns', 'maxToolCalls', 'maxDurationMs', 'toolTimeoutMs', 'maxOutputBytes', 'maxContextBytes',
];
const COMMAND_TYPES = new Set([
  'engine.getCapabilities',
  'workspace.open', 'workspace.getStatus', 'file.list', 'file.read',
  'session.create', 'session.list', 'session.getSnapshot', 'session.getHistory', 'session.getMetrics',
  'run.submit', 'run.cancel', 'approval.decide', 'review.getDiff', 'events.subscribe',
  'review.previewRestore', 'review.restore', 'review.history',
]);

function invalid(path: string, rule: string): never {
  // Do not copy submitted values into errors: credential fields are unsupported.
  throw new EngineError('INVALID_INPUT', `${path} ${rule}`, { path });
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    invalid(path, 'must be a JSON object');
  }
  let array: boolean;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  let ownKeys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalid(path, 'must be an inspectable JSON object');
  }
  if (array) invalid(path, 'must be a JSON object');
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'must be a plain JSON object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid(path, 'contains an unsupported field');
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalid(path, 'must contain enumerable JSON data properties');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function string(value: unknown, path: string, maxBytes: number, controlCharacters = false): string {
  if (typeof value !== 'string') invalid(path, 'must be a string');
  if (value.trim().length === 0) invalid(path, 'must not be empty');
  if (value.includes('\0')) invalid(path, 'must not contain NUL');
  if (controlCharacters && /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(path, 'must not contain control characters');
  }
  if (value.length > maxBytes || encoder.encode(value).byteLength > maxBytes) {
    invalid(path, `must not exceed ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  return string(value, path, MAX_ID_BYTES, true);
}

/** GUI paths are already canonical; presentation owns filesystem/exclusion checks. */
function relativePath(value: unknown, path: string, allowRoot = false): string {
  if (typeof value !== 'string') invalid(path, 'must be a string');
  if (value === '') {
    if (allowRoot) return value;
    invalid(path, 'must not be empty');
  }
  if (value.length > MAX_PATH_BYTES) invalid(path, `must not exceed ${MAX_PATH_BYTES} UTF-8 bytes`);
  const encoded = encoder.encode(value);
  if (encoded.byteLength > MAX_PATH_BYTES) invalid(path, `must not exceed ${MAX_PATH_BYTES} UTF-8 bytes`);
  if (decoder.decode(encoded) !== value) invalid(path, 'must be well-formed UTF-8 text');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid(path, 'must not contain control characters');
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    invalid(path, 'must be a workspace-relative path with forward slashes');
  }
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    invalid(path, 'must not contain traversal or empty path segments');
  }
  return value;
}

function restoreFingerprint(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/u.test(value)) {
    invalid('payload.previewFingerprint', 'must be a lowercase SHA-256 fingerprint');
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeConfig(value: unknown, defaults?: RunConfigInput): RunConfig {
  const baseline = defaults === undefined ? undefined : normalizeConfig(defaults);
  const config = value === undefined ? {} : object(value, 'payload.config', ['providerId', 'modelId', 'mode', 'limits', 'reasoningEffort', 'budgets']);
  if (has(config, 'budgets') && config.budgets === undefined) invalid('payload.config.budgets', 'must be a JSON object');
  const limits = has(config, 'limits') ? object(config.limits, 'payload.config.limits', LIMIT_KEYS) : {};
  const normalizedLimits = { ...(baseline?.limits ?? DEFAULT_LIMITS) };
  for (const key of LIMIT_KEYS) {
    if (has(limits, key)) {
      normalizedLimits[key] = integer(limits[key], `payload.config.limits.${key}`, 1, LIMIT_MAXIMUMS[key]);
    }
  }
  const mode = has(config, 'mode') ? config.mode : (baseline?.mode ?? 'plan');
  if (mode !== 'plan' && mode !== 'build') invalid('payload.config.mode', 'must be plan or build');
  const reasoningEffort = has(config, 'reasoningEffort') ? config.reasoningEffort : baseline?.reasoningEffort;
  if ((has(config, 'reasoningEffort') || reasoningEffort !== undefined) && !REASONING_EFFORTS.includes(reasoningEffort as never)) invalid('payload.config.reasoningEffort', 'must be a supported reasoning effort');
  return {
    providerId: has(config, 'providerId') ? id(config.providerId, 'payload.config.providerId') : (baseline?.providerId ?? 'scripted'),
    modelId: has(config, 'modelId') ? id(config.modelId, 'payload.config.modelId') : (baseline?.modelId ?? 'local'),
    mode,
    limits: normalizedLimits,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as import('./index.js').ReasoningEffort }),
    ...(!has(config, 'budgets') && baseline?.budgets === undefined ? {} : { budgets: normalizeEngineBudgets(config.budgets, baseline?.budgets) }),
  };
}

/** Validate and copy a submit payload; omitted config fields receive stable defaults. */
export function normalizeSubmitInput(value: unknown, defaults?: RunConfigInput): SubmitInput {
  const payload = object(value, 'payload', ['sessionId', 'requestId', 'prompt', 'config']);
  if (has(payload, 'config') && payload.config === undefined) invalid('payload.config', 'must be a JSON object');
  return {
    sessionId: id(payload.sessionId, 'payload.sessionId'),
    requestId: id(payload.requestId, 'payload.requestId'),
    prompt: string(payload.prompt, 'payload.prompt', MAX_PROMPT_BYTES),
    config: normalizeConfig(payload.config, defaults),
  };
}

/** Validate the JSON transport envelope and return its canonical, isolated payload. */
export function validateCommand(value: unknown, submitDefaults?: RunConfigInput): CommandEnvelope {
  const envelope = object(value, 'command', ['schemaVersion', 'commandId', 'type', 'payload']);
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new EngineError('UNSUPPORTED_SCHEMA_VERSION', 'command.schemaVersion must be 1', { path: 'command.schemaVersion' });
  }
  const commandId = id(envelope.commandId, 'command.commandId');
  const type = string(envelope.type, 'command.type', 64, true);
  if (!COMMAND_TYPES.has(type)) throw new EngineError('UNKNOWN_COMMAND', 'command.type is not supported', { path: 'command.type' });

  let payload: JsonObject;
  switch (type) {
    case 'engine.getCapabilities':
      object(envelope.payload, 'payload', []);
      payload = {};
      break;
    case 'workspace.open': {
      const input = object(envelope.payload, 'payload', ['path']);
      payload = { path: string(input.path, 'payload.path', MAX_PATH_BYTES) };
      break;
    }
    case 'session.create': {
      const input = object(envelope.payload, 'payload', ['workspaceId', 'title']);
      payload = { workspaceId: id(input.workspaceId, 'payload.workspaceId') };
      if (has(input, 'title')) payload.title = string(input.title, 'payload.title', MAX_ID_BYTES, true);
      break;
    }
    case 'session.list':
    case 'workspace.getStatus': {
      const input = object(envelope.payload, 'payload', ['workspaceId']);
      payload = { workspaceId: id(input.workspaceId, 'payload.workspaceId') };
      break;
    }
    case 'file.list': {
      const input = object(envelope.payload, 'payload', ['workspaceId', 'path', 'limit', 'continuation']);
      payload = { workspaceId: id(input.workspaceId, 'payload.workspaceId') };
      if (has(input, 'path')) payload.path = relativePath(input.path, 'payload.path', true);
      if (has(input, 'limit')) payload.limit = integer(input.limit, 'payload.limit', 1, 1000);
      if (has(input, 'continuation')) {
        if (typeof input.continuation !== 'string' || !input.continuation || encoder.encode(input.continuation).byteLength > 2048 || /[\u0000-\u001f\u007f]/u.test(input.continuation)) invalid('payload.continuation', 'must be a bounded continuation token');
        payload.continuation = input.continuation;
      }
      break;
    }
    case 'file.read': {
      const input = object(envelope.payload, 'payload', ['workspaceId', 'path']);
      payload = { workspaceId: id(input.workspaceId, 'payload.workspaceId'), path: relativePath(input.path, 'payload.path') };
      break;
    }
    case 'session.getHistory': {
      const input = object(envelope.payload, 'payload', ['sessionId', 'beforeRunId', 'limit']);
      payload = { sessionId: id(input.sessionId, 'payload.sessionId') };
      if (has(input, 'beforeRunId')) payload.beforeRunId = id(input.beforeRunId, 'payload.beforeRunId');
      if (has(input, 'limit')) payload.limit = integer(input.limit, 'payload.limit', 1, 50);
      break;
    }
    case 'session.getMetrics':
    case 'session.getSnapshot': {
      const input = object(envelope.payload, 'payload', ['sessionId']);
      payload = { sessionId: id(input.sessionId, 'payload.sessionId') };
      break;
    }
    case 'run.submit': {
      const input = normalizeSubmitInput(envelope.payload, submitDefaults);
      payload = jsonObject(input, 'payload');
      break;
    }
    case 'run.cancel':
    case 'review.getDiff':
    case 'review.history': {
      const input = object(envelope.payload, 'payload', ['runId']);
      payload = { runId: id(input.runId, 'payload.runId') };
      break;
    }
    case 'review.previewRestore':
    case 'review.restore': {
      const keys = type === 'review.restore' ? ['runId', 'checkpointId', 'previewFingerprint'] : ['runId', 'checkpointId'];
      const input = object(envelope.payload, 'payload', keys);
      payload = { runId: id(input.runId, 'payload.runId'), checkpointId: id(input.checkpointId, 'payload.checkpointId') };
      if (type === 'review.restore') payload.previewFingerprint = restoreFingerprint(input.previewFingerprint);
      break;
    }
    case 'approval.decide': {
      const input = object(envelope.payload, 'payload', ['approvalId', 'decision', 'fingerprint']);
      if (input.decision !== 'allow' && input.decision !== 'deny') invalid('payload.decision', 'must be allow or deny');
      payload = {
        approvalId: id(input.approvalId, 'payload.approvalId'),
        decision: input.decision,
        fingerprint: string(input.fingerprint, 'payload.fingerprint', 512, true),
      };
      break;
    }
    case 'events.subscribe': {
      const input = object(envelope.payload, 'payload', ['sessionId', 'afterSeq']);
      payload = {
        sessionId: id(input.sessionId, 'payload.sessionId'),
        afterSeq: has(input, 'afterSeq') ? integer(input.afterSeq, 'payload.afterSeq', 0, Number.MAX_SAFE_INTEGER) : 0,
      };
      break;
    }
    default:
      throw new EngineError('UNKNOWN_COMMAND', 'command.type is not supported');
  }
  return { schemaVersion: SCHEMA_VERSION, commandId, type, payload };
}

const BUDGET_MAXIMUMS: Readonly<EngineBudgets> = Object.freeze({
  turnAllowance: 128, maxToolCallsPerTurn: 1024, maxPendingInputs: 65536, maxPendingBytes: 67_108_864,
  maxSteerBatch: 1024, maxReadConcurrency: 64, maxProviderAttempts: 16,
  providerRequestTimeoutMs: 3_600_000, providerInactivityTimeoutMs: 3_600_000, retryBaseDelayMs: 60_000,
  maxSummaryCalls: 128, maxSummaryBytes: 8_388_608, maxArtifactBytes: 268_435_456, maxProducerBytes: 536_870_912,
});
const BUDGET_KEYS = Object.keys(DEFAULT_ENGINE_BUDGETS) as (keyof EngineBudgets)[];

/** Canonical budget validation is shared by admission identity and runtime configuration. */
export function normalizeEngineBudgets(value?: unknown, defaults?: Partial<EngineBudgets>): EngineBudgets {
  const baseline = defaults === undefined ? { ...DEFAULT_ENGINE_BUDGETS } : normalizeEngineBudgets(defaults);
  const input = value === undefined ? {} : object(value, 'payload.config.budgets', BUDGET_KEYS);
  for (const key of BUDGET_KEYS) if (has(input, key)) {
    baseline[key] = integer(input[key], `payload.config.budgets.${key}`, key === 'retryBaseDelayMs' ? 0 : 1, BUDGET_MAXIMUMS[key]);
  }
  return baseline;
}

export function normalizeAcceptInput(value: unknown, defaults?: RunConfigInput): AcceptInput {
  const input = object(value, 'payload', ['sessionId', 'requestId', 'prompt', 'config', 'delivery']);
  const delivery = has(input, 'delivery') ? input.delivery : 'steer';
  if (delivery !== 'queue' && delivery !== 'steer') invalid('payload.delivery', 'must be queue or steer');
  return { ...normalizeSubmitInput({ sessionId: input.sessionId, requestId: input.requestId, prompt: input.prompt,
    ...(has(input, 'config') ? { config: input.config } : {}) }, defaults), delivery };
}

function schema2(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const input = object(value, path, ['schemaVersion', ...keys]);
  if (input.schemaVersion !== SESSION_SCHEMA_VERSION) throw new EngineError('UNSUPPORTED_SCHEMA_VERSION', `${path}.schemaVersion must be 2`, { path: `${path}.schemaVersion` });
  return input;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
  return value;
}
function choice<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalid(path, 'must be a supported value');
  return value as T[number];
}
function text(value: unknown, path: string, maximum = 4_194_304): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum || encoder.encode(value).length > maximum || decoder.decode(encoder.encode(value)) !== value) invalid(path, 'must be bounded well-formed UTF-8 text');
  return value;
}
function date(value: unknown, path: string): string {
  const result = string(value, path, 64, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(path, 'must be a canonical UTC timestamp');
  return result;
}
function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(path, 'must be a lowercase SHA-256 hash');
  return value;
}
function json(value: unknown, path: string): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 100_000 || depth > 64) invalid(path, 'exceeds JSON complexity limits');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(path, 'must contain finite numbers'); return item; }
    if (typeof item === 'string') return text(item, path);
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid(path, 'must contain acyclic JSON data');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const length = Object.getOwnPropertyDescriptor(item, 'length')?.value as unknown;
        if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 100_000 || Reflect.ownKeys(item).length !== (length as number) + 1 || Object.getPrototypeOf(item) !== Array.prototype) invalid(path, 'must contain dense plain JSON arrays');
        return Array.from({ length: length as number }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) invalid(path, 'must contain JSON data properties');
          return copy(descriptor.value, depth + 1);
        });
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) invalid(path, 'must contain plain JSON objects');
      const result: JsonObject = {};
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(item, key) : undefined;
        if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) invalid(path, 'must contain enumerable JSON data properties');
        Object.defineProperty(result, text(key, path, MAX_PATH_BYTES), { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  let result: JsonValue;
  try { result = copy(value, 0); }
  catch (error) { if (error instanceof EngineError) throw error; invalid(path, 'must be inspectable JSON data'); }
  if (encoder.encode(JSON.stringify(result)).length > 4_194_304) invalid(path, 'exceeds JSON byte budget');
  return result;
}
function jsonObject(value: unknown, path: string): JsonObject {
  const result = json(value, path);
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalid(path, 'must be a JSON object');
  return result;
}
function stringList(value: unknown, path: string, maximum = 1024): string[] {
  const items = json(value, path);
  if (!Array.isArray(items) || items.length > maximum) invalid(path, 'must be a bounded array');
  return items.map((item) => id(item, path));
}
function optionalId(input: Record<string, unknown>, key: string, path: string): Record<string, string> {
  return has(input, key) ? { [key]: id(input[key], `${path}.${key}`) } : {};
}
function optionalDate(input: Record<string, unknown>, key: string, path: string): Record<string, string> {
  return has(input, key) ? { [key]: date(input[key], `${path}.${key}`) } : {};
}
function uncertainty(value: unknown, path: string): import('./index.js').ExecutionUncertainty {
  const input = object(value, path, ['kind', 'message', 'requiresRecovery']);
  if (input.requiresRecovery !== true) invalid(`${path}.requiresRecovery`, 'must be true');
  return { kind: choice(input.kind, `${path}.kind`, ['provider_dispatch', 'tool_effect', 'cleanup', 'storage_commit']), message: string(input.message, `${path}.message`, 2048), requiresRecovery: true };
}
function completed(input: Record<string, unknown>, path: string, state: string): { createdAt: string; completedAt?: string } {
  const createdAt = date(input.createdAt, `${path}.createdAt`);
  const completedAt = has(input, 'completedAt') ? date(input.completedAt, `${path}.completedAt`) : undefined;
  const terminal = ['completed', 'failed', 'interrupted', 'uncertain'].includes(state);
  if (terminal !== (completedAt !== undefined)) invalid(`${path}.completedAt`, 'must exist exactly for a terminal state');
  if (completedAt && completedAt < createdAt) invalid(`${path}.completedAt`, 'must not precede creation');
  return { createdAt, ...(completedAt === undefined ? {} : { completedAt }) };
}
function inputBinding(input: Record<string, unknown>, path: string, state: InputRecord['state']): { runId?: string } {
  if ((state === 'promoted') !== has(input, 'runId')) invalid(`${path}.runId`, 'must exist exactly for promoted input');
  return optionalId(input, 'runId', path);
}
export function validateInputReceipt(value: unknown): InputReceipt {
  const input = object(value, 'receipt', ['inputId', 'admittedSeq', 'state', 'duplicate', 'runId']);
  const state = choice(input.state, 'receipt.state', ['pending', 'promoted', 'cancelled']);
  return { inputId: id(input.inputId, 'receipt.inputId'), admittedSeq: integer(input.admittedSeq, 'receipt.admittedSeq', 1, Number.MAX_SAFE_INTEGER), state, duplicate: bool(input.duplicate, 'receipt.duplicate'), ...inputBinding(input, 'receipt', state) };
}
export function validateInputRecord(value: unknown): InputRecord {
  const input = schema2(value, 'input', ['id', 'workspaceId', 'sessionId', 'requestId', 'prompt', 'config', 'delivery', 'state', 'admittedSeq', 'createdAt', 'updatedAt', 'runId', 'promotedSeq', 'terminalReason']);
  const state = choice(input.state, 'input.state', ['pending', 'promoted', 'cancelled']);
  const admittedSeq = integer(input.admittedSeq, 'input.admittedSeq', 1, Number.MAX_SAFE_INTEGER);
  if ((state === 'promoted') !== has(input, 'promotedSeq')) invalid('input.promotedSeq', 'must exist exactly for promoted input');
  const createdAt = date(input.createdAt, 'input.createdAt');
  const updatedAt = date(input.updatedAt, 'input.updatedAt');
  if (updatedAt < createdAt) invalid('input.updatedAt', 'must not precede creation');
  return { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'input.id'), workspaceId: id(input.workspaceId, 'input.workspaceId'),
    ...normalizeAcceptInput({ sessionId: input.sessionId, requestId: input.requestId, prompt: input.prompt, config: input.config, delivery: input.delivery }), state, admittedSeq, createdAt, updatedAt,
    ...inputBinding(input, 'input', state), ...(has(input, 'promotedSeq') ? { promotedSeq: integer(input.promotedSeq, 'input.promotedSeq', admittedSeq + 1, Number.MAX_SAFE_INTEGER) } : {}),
    ...(has(input, 'terminalReason') ? { terminalReason: string(input.terminalReason, 'input.terminalReason', 2048) } : {}) };
}
export function validateRunRecordV2(value: unknown): RunRecordV2 {
  const input = schema2(value, 'run', ['id', 'inputId', 'sessionId', 'workspaceId', 'requestId', 'prompt', 'config', 'state', 'createdAt', 'updatedAt', 'error', 'inputIds', 'uncertainty']);
  const state = choice(input.state, 'run.state', ['created', 'running', 'awaiting_approval', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted']);
  const inputId = id(input.inputId, 'run.inputId');
  const inputIds = stringList(input.inputIds, 'run.inputIds');
  if (!inputIds.includes(inputId) || new Set(inputIds).size !== inputIds.length) invalid('run.inputIds', 'must contain the primary input exactly once and distinct bindings');
  if (has(input, 'uncertainty') && state !== 'failed' && state !== 'interrupted') invalid('run.uncertainty', 'requires failed or interrupted Run state');
  const createdAt = date(input.createdAt, 'run.createdAt'), updatedAt = date(input.updatedAt, 'run.updatedAt');
  if (updatedAt < createdAt) invalid('run.updatedAt', 'must not precede creation');
  let error: RunRecordV2['error'];
  if (has(input, 'error')) { const failure = object(input.error, 'run.error', ['code', 'message']); error = { code: id(failure.code, 'run.error.code'), message: string(failure.message, 'run.error.message', 2048) }; }
  return { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'run.id'), inputId, workspaceId: id(input.workspaceId, 'run.workspaceId'), ...normalizeSubmitInput({ sessionId: input.sessionId, requestId: input.requestId, prompt: input.prompt, config: input.config }), state, createdAt, updatedAt, inputIds, ...(error ? { error } : {}), ...(has(input, 'uncertainty') ? { uncertainty: uncertainty(input.uncertainty, 'run.uncertainty') } : {}) };
}
export function validateToolCallIdentity(value: unknown): ToolCallIdentity {
  const input = object(value, 'call', ['id', 'sessionId', 'runId', 'turnId', 'attemptId', 'providerCallId']);
  return { id: id(input.id, 'call.id'), sessionId: id(input.sessionId, 'call.sessionId'), runId: id(input.runId, 'call.runId'), turnId: id(input.turnId, 'call.turnId'), attemptId: id(input.attemptId, 'call.attemptId'), providerCallId: id(input.providerCallId, 'call.providerCallId') };
}
export function validateArtifactCheckpointBinding(value: unknown): ArtifactCheckpointBinding {
  const input = object(value, 'binding', ['sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId', 'checkpointId', 'artifactIds', 'partial']);
  if (has(input, 'attemptId') && !has(input, 'turnId')) invalid('binding.attemptId', 'requires a turn ID');
  const artifactIds = stringList(input.artifactIds, 'binding.artifactIds', 128);
  if (new Set(artifactIds).size !== artifactIds.length) invalid('binding.artifactIds', 'must contain distinct artifact IDs');
  return { sessionId: id(input.sessionId, 'binding.sessionId'), runId: id(input.runId, 'binding.runId'), toolCallId: id(input.toolCallId, 'binding.toolCallId'), checkpointId: id(input.checkpointId, 'binding.checkpointId'), artifactIds, partial: bool(input.partial, 'binding.partial'), ...optionalId(input, 'turnId', 'binding'), ...optionalId(input, 'attemptId', 'binding') };
}
export function validateTurnRecord(value: unknown): TurnRecord {
  const input = schema2(value, 'turn', ['id', 'sessionId', 'runId', 'inputIds', 'index', 'state', 'createdAt', 'completedAt', 'finishReason', 'contextRevisionId', 'uncertainty']);
  const state = choice(input.state, 'turn.state', ['created', 'streaming', 'awaiting_tools', 'completed', 'failed', 'interrupted', 'uncertain']);
  const inputIds = stringList(input.inputIds, 'turn.inputIds');
  if (!inputIds.length || new Set(inputIds).size !== inputIds.length) invalid('turn.inputIds', 'must contain distinct input IDs');
  if ((state === 'uncertain') !== has(input, 'uncertainty')) invalid('turn.uncertainty', 'must exist exactly for uncertain state');
  return { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'turn.id'), sessionId: id(input.sessionId, 'turn.sessionId'), runId: id(input.runId, 'turn.runId'), inputIds, index: integer(input.index, 'turn.index', 0, Number.MAX_SAFE_INTEGER), state, ...completed(input, 'turn', state), ...optionalId(input, 'contextRevisionId', 'turn'),
    ...(has(input, 'finishReason') ? { finishReason: string(input.finishReason, 'turn.finishReason', 128, true) } : {}), ...(has(input, 'uncertainty') ? { uncertainty: uncertainty(input.uncertainty, 'turn.uncertainty') } : {}) };
}
export function validateProviderAttempt(value: unknown): ProviderAttempt {
  const input = schema2(value, 'attempt', ['id', 'sessionId', 'runId', 'turnId', 'index', 'providerId', 'modelId', 'state', 'createdAt', 'dispatchedAt', 'completedAt', 'providerRequestId', 'uncertainty']);
  const state = choice(input.state, 'attempt.state', ['prepared', 'dispatched', 'streaming', 'completed', 'failed', 'interrupted', 'uncertain']);
  if (state === 'prepared' && has(input, 'dispatchedAt')) invalid('attempt.dispatchedAt', 'must be absent before dispatch');
  if (['dispatched', 'streaming', 'completed', 'uncertain'].includes(state) && !has(input, 'dispatchedAt')) invalid('attempt.dispatchedAt', 'must exist after dispatch');
  if ((state === 'uncertain') !== has(input, 'uncertainty')) invalid('attempt.uncertainty', 'must exist exactly for uncertain state');
  const times = completed(input, 'attempt', state);
  const dispatch = optionalDate(input, 'dispatchedAt', 'attempt');
  if (dispatch.dispatchedAt && (dispatch.dispatchedAt < times.createdAt || (times.completedAt && dispatch.dispatchedAt > times.completedAt))) invalid('attempt.dispatchedAt', 'must be within attempt lifetime');
  return { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'attempt.id'), sessionId: id(input.sessionId, 'attempt.sessionId'), runId: id(input.runId, 'attempt.runId'), turnId: id(input.turnId, 'attempt.turnId'), index: integer(input.index, 'attempt.index', 0, 15), providerId: id(input.providerId, 'attempt.providerId'), modelId: id(input.modelId, 'attempt.modelId'), state, ...times, ...dispatch, ...optionalId(input, 'providerRequestId', 'attempt'), ...(has(input, 'uncertainty') ? { uncertainty: uncertainty(input.uncertainty, 'attempt.uncertainty') } : {}) };
}
export function validateArtifactReference(value: unknown): ArtifactReference {
  const input = object(value, 'artifact', ['id', 'identity', 'sha256', 'storedBytes', 'observedBytes', 'producerTruncatedBytes', 'artifactTruncatedBytes', 'createdAt', 'expiresAt', 'complete', 'outcome']);
  const identity = object(input.identity, 'artifact.identity', ['sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId']);
  if (has(identity, 'attemptId') && !has(identity, 'turnId')) invalid('artifact.identity.attemptId', 'requires a turn ID');
  const storedBytes = integer(input.storedBytes, 'artifact.storedBytes', 0, 536_870_912);
  const observedBytes = integer(input.observedBytes, 'artifact.observedBytes', storedBytes, 536_870_912);
  const artifactTruncatedBytes = integer(input.artifactTruncatedBytes, 'artifact.artifactTruncatedBytes', 0, 536_870_912);
  const producerTruncatedBytes = input.producerTruncatedBytes === null ? null : integer(input.producerTruncatedBytes, 'artifact.producerTruncatedBytes', 0, Number.MAX_SAFE_INTEGER);
  if (artifactTruncatedBytes > observedBytes - storedBytes || (producerTruncatedBytes !== null && producerTruncatedBytes + artifactTruncatedBytes + storedBytes !== observedBytes)) invalid('artifact.artifactTruncatedBytes', 'must balance stored, producer and artifact truncation accounting');
  const complete = bool(input.complete, 'artifact.complete');
  if (complete && (producerTruncatedBytes !== 0 || artifactTruncatedBytes !== 0 || input.outcome !== 'completed')) invalid('artifact.complete', 'requires completed outcome with no producer or artifact loss');
  const createdAt = date(input.createdAt, 'artifact.createdAt');
  const expiresAt = date(input.expiresAt, 'artifact.expiresAt');
  if (expiresAt <= createdAt) invalid('artifact.expiresAt', 'must follow creation');
  return { id: id(input.id, 'artifact.id'), identity: { sessionId: id(identity.sessionId, 'artifact.identity.sessionId'), runId: id(identity.runId, 'artifact.identity.runId'), toolCallId: id(identity.toolCallId, 'artifact.identity.toolCallId'), ...optionalId(identity, 'turnId', 'artifact.identity'), ...optionalId(identity, 'attemptId', 'artifact.identity') }, sha256: hash(input.sha256, 'artifact.sha256'), storedBytes, observedBytes, producerTruncatedBytes, artifactTruncatedBytes, createdAt, expiresAt, complete, outcome: choice(input.outcome, 'artifact.outcome', ['completed', 'failed', 'interrupted']) };
}
export function validateMessagePart(value: unknown): MessagePart {
  const input = schema2(value, 'part', ['id', 'sessionId', 'runId', 'turnId', 'messageId', 'index', 'revision', 'state', 'createdAt', 'completedAt', 'type', 'text', 'providerData', 'toolCallId', 'providerCallId', 'name', 'input', 'result', 'mime', 'artifact']);
  const type = choice(input.type, 'part.type', ['text', 'reasoning', 'tool', 'media']);
  const allowed = { text: ['text'], reasoning: ['text', 'providerData'], tool: ['toolCallId', 'providerCallId', 'name', 'input', 'result'], media: ['mime', 'name', 'artifact'] }[type];
  const unionFields = ['text', 'providerData', 'toolCallId', 'providerCallId', 'name', 'input', 'result', 'mime', 'artifact'];
  for (const key of unionFields) if (has(input, key) && !allowed.includes(key)) invalid(`part.${key}`, 'is unsupported for this part type');
  const state = choice(input.state, 'part.state', ['open', 'completed', 'failed', 'interrupted']);
  const base = { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'part.id'), sessionId: id(input.sessionId, 'part.sessionId'), runId: id(input.runId, 'part.runId'), turnId: id(input.turnId, 'part.turnId'), messageId: id(input.messageId, 'part.messageId'), index: integer(input.index, 'part.index', 0, Number.MAX_SAFE_INTEGER), revision: integer(input.revision, 'part.revision', 0, Number.MAX_SAFE_INTEGER), state, ...completed(input, 'part', state) };
  if (type === 'text') return { ...base, type, text: text(input.text, 'part.text') };
  if (type === 'reasoning') return { ...base, type, text: text(input.text, 'part.text'), ...(has(input, 'providerData') ? { providerData: jsonObject(input.providerData, 'part.providerData') } : {}) };
  if (type === 'tool') return { ...base, type, toolCallId: id(input.toolCallId, 'part.toolCallId'), providerCallId: id(input.providerCallId, 'part.providerCallId'), name: id(input.name, 'part.name'), input: json(input.input, 'part.input'), ...(has(input, 'result') ? { result: json(input.result, 'part.result') } : {}) };
  const artifact = validateArtifactReference(input.artifact);
  if (artifact.identity.sessionId !== base.sessionId || artifact.identity.runId !== base.runId || (artifact.identity.turnId !== undefined && artifact.identity.turnId !== base.turnId)) invalid('part.artifact.identity', 'must match the owning part');
  return { ...base, type, mime: string(input.mime, 'part.mime', 256, true), artifact, ...(has(input, 'name') ? { name: string(input.name, 'part.name', MAX_PATH_BYTES, true) } : {}) };
}
export function validateContextRevision(value: unknown): ContextRevision {
  const input = schema2(value, 'context', ['id', 'sessionId', 'revision', 'kind', 'sourceIds', 'text', 'sha256', 'createdAt', 'runId', 'turnId', 'supersedesId']);
  if (has(input, 'turnId') && !has(input, 'runId')) invalid('context.turnId', 'requires a Run ID');
  const sourceIds = stringList(input.sourceIds, 'context.sourceIds');
  if (new Set(sourceIds).size !== sourceIds.length) invalid('context.sourceIds', 'must contain distinct source IDs');
  return { schemaVersion: SESSION_SCHEMA_VERSION, id: id(input.id, 'context.id'), sessionId: id(input.sessionId, 'context.sessionId'), revision: integer(input.revision, 'context.revision', 1, Number.MAX_SAFE_INTEGER), kind: choice(input.kind, 'context.kind', ['baseline', 'update', 'summary']), sourceIds, text: text(input.text, 'context.text'), sha256: hash(input.sha256, 'context.sha256'), createdAt: date(input.createdAt, 'context.createdAt'), ...optionalId(input, 'runId', 'context'), ...optionalId(input, 'turnId', 'context'), ...optionalId(input, 'supersedesId', 'context') };
}
export function validateSessionEvent(value: unknown): SessionEventV2 {
  const input = schema2(value, 'event', ['stream', 'eventId', 'sessionId', 'seq', 'timestamp', 'type', 'payload', 'runId', 'inputId', 'turnId', 'attemptId']);
  if (input.stream !== 'session-v2') invalid('event.stream', 'must be session-v2');
  if (has(input, 'attemptId') && !has(input, 'turnId')) invalid('event.attemptId', 'requires a turn ID');
  if (has(input, 'turnId') && !has(input, 'runId')) invalid('event.turnId', 'requires a Run ID');
  const type = string(input.type, 'event.type', 128, true);
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(type)) invalid('event.type', 'must be a domain-qualified event type');
  return { schemaVersion: SESSION_SCHEMA_VERSION, stream: 'session-v2', eventId: id(input.eventId, 'event.eventId'), sessionId: id(input.sessionId, 'event.sessionId'), seq: integer(input.seq, 'event.seq', 1, Number.MAX_SAFE_INTEGER), timestamp: date(input.timestamp, 'event.timestamp'), type, payload: jsonObject(input.payload, 'event.payload'), ...optionalId(input, 'runId', 'event'), ...optionalId(input, 'inputId', 'event'), ...optionalId(input, 'turnId', 'event'), ...optionalId(input, 'attemptId', 'event') };
}
export function validateSessionEventCursor(value: unknown): SessionEventCursor {
  const input = schema2(value, 'cursor', ['stream', 'sessionId', 'afterSeq']);
  if (input.stream !== 'session-v2') invalid('cursor.stream', 'must be session-v2');
  return { schemaVersion: SESSION_SCHEMA_VERSION, stream: 'session-v2', sessionId: id(input.sessionId, 'cursor.sessionId'), afterSeq: integer(input.afterSeq, 'cursor.afterSeq', 0, Number.MAX_SAFE_INTEGER) };
}
const LEGACY_PROJECTABLE_TYPES = new Set(['input.admitted', 'run.started', 'run.awaiting_approval', 'run.resumed', 'run.cancelling', 'run.completed', 'run.cancelled', 'run.failed', 'run.interrupted', 'run.usage', 'message.delta', 'message.completed', 'tool.requested', 'tool.awaiting_approval', 'tool.running', 'tool.completed', 'tool.failed', 'tool.denied', 'tool.interrupted', 'approval.requested', 'approval.resolved', 'approval.expired', 'context.prepared', 'workspace.changed']);
/** Projection requires a separately assigned v1 sequence. Never mint a Run for pending input. */
export function projectSessionEventToV1(value: unknown, legacySeq: number): EngineEvent | undefined {
  const event = validateSessionEvent(value);
  if (!event.runId || !LEGACY_PROJECTABLE_TYPES.has(event.type)) return undefined;
  return { schemaVersion: SCHEMA_VERSION, eventId: event.eventId, sessionId: event.sessionId, runId: event.runId, seq: integer(legacySeq, 'legacy.seq', 1, Number.MAX_SAFE_INTEGER), timestamp: event.timestamp, type: event.type, payload: event.payload };
}
/** New command contracts remain disabled until a host explicitly enables implemented handlers. */
export function validateSessionCommand(value: unknown, options: { defaults?: RunConfigInput; enabledCommands?: readonly SessionCommandType[] } = {}): SessionCommandEnvelope {
  const input = schema2(value, 'command', ['commandId', 'type', 'payload']);
  const commandId = id(input.commandId, 'command.commandId');
  if (typeof input.type !== 'string' || !SESSION_COMMAND_TYPES.includes(input.type as SessionCommandType)) throw new EngineError('UNKNOWN_COMMAND', 'command.type is not supported', { path: 'command.type' });
  const type = input.type as SessionCommandType;
  if (!options.enabledCommands?.includes(type)) throw new EngineError('COMMAND_UNAVAILABLE', 'command.type is not enabled by this engine', { path: 'command.type' });
  let payload: JsonObject;
  if (type === 'input.accept') payload = jsonObject(normalizeAcceptInput(input.payload, options.defaults), 'payload');
  else if (type === 'input.cancel') {
    const value = object(input.payload, 'payload', ['sessionId', 'inputId']);
    payload = { sessionId: id(value.sessionId, 'payload.sessionId'), inputId: id(value.inputId, 'payload.inputId') };
  } else if (type === 'input.list') {
    const value = object(input.payload, 'payload', ['sessionId', 'cursor', 'limit']);
    const sessionId = id(value.sessionId, 'payload.sessionId');
    payload = { sessionId, limit: has(value, 'limit') ? integer(value.limit, 'payload.limit', 1, 100) : 50 };
    if (has(value, 'cursor')) {
      const cursor = object(value.cursor, 'payload.cursor', ['sessionId', 'afterSeq']);
      if (id(cursor.sessionId, 'payload.cursor.sessionId') !== sessionId) invalid('payload.cursor.sessionId', 'must match the requested session');
      payload.cursor = { sessionId, afterSeq: integer(cursor.afterSeq, 'payload.cursor.afterSeq', 0, Number.MAX_SAFE_INTEGER) };
    }
  } else if (type === 'session.events') {
    const value = object(input.payload, 'payload', ['sessionId', 'afterSeq', 'stream']);
    if (has(value, 'stream') && value.stream !== 'session-v2') invalid('payload.stream', 'must be session-v2');
    payload = { sessionId: id(value.sessionId, 'payload.sessionId'), stream: 'session-v2', afterSeq: has(value, 'afterSeq') ? integer(value.afterSeq, 'payload.afterSeq', 0, Number.MAX_SAFE_INTEGER) : 0 };
  } else {
    const value = object(input.payload, 'payload', ['sessionId']);
    payload = { sessionId: id(value.sessionId, 'payload.sessionId') };
  }
  return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, type, payload };
}
export function validateToolResultEnvelope(value: unknown): ToolResultEnvelope {
  const input = object(value, 'result', ['displayContent', 'modelContent', 'structuredData', 'metadata', 'warnings', 'artifactRefs', 'outcome']);
  const warnings = json(input.warnings, 'result.warnings');
  if (!Array.isArray(warnings) || warnings.length > 128) invalid('result.warnings', 'must be a bounded array');
  const artifacts = json(input.artifactRefs, 'result.artifactRefs');
  if (!Array.isArray(artifacts) || artifacts.length > 128) invalid('result.artifactRefs', 'must be a bounded array');
  const artifactRefs = artifacts.map(validateArtifactReference);
  if (new Set(artifactRefs.map((artifact) => artifact.id)).size !== artifactRefs.length) invalid('result.artifactRefs', 'must contain distinct artifact IDs');
  return { displayContent: text(input.displayContent, 'result.displayContent'), modelContent: text(input.modelContent, 'result.modelContent'), warnings: warnings.map((warning) => string(warning, 'result.warnings', 2048)), artifactRefs, outcome: choice(input.outcome, 'result.outcome', ['completed', 'failed', 'interrupted']), ...(has(input, 'structuredData') ? { structuredData: json(input.structuredData, 'result.structuredData') } : {}), ...(has(input, 'metadata') ? { metadata: jsonObject(input.metadata, 'result.metadata') } : {}) };
}
