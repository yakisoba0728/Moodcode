import { DEFAULT_LIMITS, EngineError, SCHEMA_VERSION, REASONING_EFFORTS } from './index.js';
import type { CommandEnvelope, JsonObject, RunConfig, RunConfigInput, RunLimits, SubmitInput } from './index.js';

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
  const config = value === undefined ? {} : object(value, 'payload.config', ['providerId', 'modelId', 'mode', 'limits', 'reasoningEffort']);
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
      payload = { ...input, config: { ...input.config, limits: { ...input.config.limits } } };
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
