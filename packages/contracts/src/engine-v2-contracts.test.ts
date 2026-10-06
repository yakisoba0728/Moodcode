import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, SCHEMA_VERSION, SESSION_COMMAND_TYPES } from './index.js';
import type { EngineEvent, EngineCapabilities, RunRecordV2 } from './index.js';
import { normalizeAcceptInput, normalizeEngineBudgets, normalizeSubmitInput, projectSessionEventToV1, validateArtifactCheckpointBinding, validateArtifactReference, validateCommand, validateContextRevision, validateInputReceipt, validateInputRecord, validateMessagePart, validateProviderAttempt, validateRunRecordV2, validateSessionCommand, validateSessionEvent, validateSessionEventCursor, validateToolCallIdentity, validateToolResultEnvelope, validateTurnRecord } from './validation.js';

const createdAt = '2026-10-07T00:00:00.000Z';
const completedAt = '2026-10-07T00:00:01.000Z';
const expiresAt = '2026-10-08T00:00:00.000Z';
const submit = { sessionId: 's1', requestId: 'req1', prompt: '독립 엔진 fixture' };
const config = normalizeSubmitInput(submit).config;
const accepted = { schemaVersion: 2, id: 'i1', workspaceId: 'w1', ...submit, config, delivery: 'queue', state: 'pending', admittedSeq: 7, createdAt, updatedAt: createdAt };
const turn = { schemaVersion: 2, id: 't1', sessionId: 's1', runId: 'r1', inputIds: ['i1'], index: 0, state: 'created', createdAt };
const attempt = { schemaVersion: 2, id: 'a1', sessionId: 's1', runId: 'r1', turnId: 't1', index: 0, providerId: 'fixture', modelId: 'model', state: 'prepared', createdAt };
const artifact = { id: 'f1', identity: { sessionId: 's1', runId: 'r1', toolCallId: 'internal1', turnId: 't1', attemptId: 'a1' }, sha256: 'a'.repeat(64), storedBytes: 4, observedBytes: 4, producerTruncatedBytes: 0, artifactTruncatedBytes: 0, createdAt, expiresAt, complete: true, outcome: 'completed' };
const event = { schemaVersion: 2, stream: 'session-v2', eventId: 'e1', sessionId: 's1', seq: 51, timestamp: createdAt, type: 'input.accepted', payload: { inputId: 'i1' }, inputId: 'i1' };
const part = { schemaVersion: 2, id: 'p1', sessionId: 's1', runId: 'r1', turnId: 't1', messageId: 'm1', index: 0, revision: 0, state: 'open', createdAt, type: 'text', text: '' };
function rejects(action: () => unknown, code = 'INVALID_INPUT'): void {
  assert.throws(action, (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, code); return true; });
}
function command(type: string, payload: unknown) { return { schemaVersion: 2, commandId: 'c1', type, payload }; }
const enabledCommands = SESSION_COMMAND_TYPES;

test('v1 omission retains its exact defaults, required Run owner and capability shape', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(config, { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS } });
  assert.equal(Object.hasOwn(config, 'budgets'), false);
  assert.deepEqual(validateCommand({ schemaVersion: 1, commandId: 'c1', type: 'run.submit', payload: submit }).payload, { ...submit, config });
  const capabilities: EngineCapabilities = { schemaVersion: 1, runtime: { node: '24', electron: null, platform: 'darwin', commandExecution: 'posix-process-group' }, providerIds: [], tools: [], modes: ['plan', 'build'], defaults: config };
  assert.equal(Object.hasOwn(capabilities, 'extensions'), false);
  // The existing consumer must never receive a pre-Run input masquerading as a v1 event.
  // @ts-expect-error v1 requires a real runId even though the v2 session journal does not.
  const ownerless: EngineEvent = { schemaVersion: 1, eventId: 'e', sessionId: 's', seq: 1, timestamp: createdAt, type: 'input.accepted', payload: {} };
  assert.equal(Object.hasOwn(ownerless, 'runId'), false);
});

test('agent profile identity is additive, bounded and revisions cannot cross an explicit profile change', () => {
  const configured = normalizeSubmitInput({ ...submit, config: { agentProfileId: 'builder', agentProfileRevision: 'sha256:fixture' } }).config;
  assert.equal(configured.agentProfileId, 'builder'); assert.equal(configured.agentProfileRevision, 'sha256:fixture');
  const inherited = normalizeSubmitInput(submit, configured).config; assert.equal(inherited.agentProfileRevision, 'sha256:fixture');
  const changed = normalizeSubmitInput({ ...submit, config: { agentProfileId: 'reviewer' } }, configured).config; assert.equal(changed.agentProfileId, 'reviewer'); assert.equal(Object.hasOwn(changed, 'agentProfileRevision'), false);
  for (const profile of [{ agentProfileId: undefined }, { agentProfileId: '' }, { agentProfileId: 'x'.repeat(257) }, { agentProfileRevision: 'orphan' }, { agentProfileId: 'p', agentProfileRevision: undefined }]) rejects(() => normalizeSubmitInput({ ...submit, config: profile }));
});

test('context diagnostic and literal history queries remain unavailable until wired and reject unbounded cursors', () => {
  rejects(() => validateSessionCommand(command('session.getContext', { sessionId: 's1' })), 'COMMAND_UNAVAILABLE');
  assert.deepEqual(validateSessionCommand(command('session.getContext', { sessionId: 's1' }), { enabledCommands }).payload, { sessionId: 's1' });
  assert.deepEqual(validateSessionCommand(command('session.searchHistory', { sessionId: 's1', query: '%literal_' }), { enabledCommands }).payload, { sessionId: 's1', query: '%literal_', limit: 50, maxBytes: 262_144 });
  for (const query of [{ query: '' }, { query: '한'.repeat(342) }, { query: 'ok', beforeMessageId: '' }, { query: 'ok', limit: 101 }, { query: 'ok', maxBytes: 1023 }, { query: 'ok', maxBytes: 1_048_577 }, { query: 'ok', regex: true }]) rejects(() => validateSessionCommand(command('session.searchHistory', { sessionId: 's1', ...query }), { enabledCommands }));
});

test('budget normalization merges isolated copies and rejects unknown, fractional, unsafe and zero limits', () => {
  const defaults = { turnAllowance: 9, maxSteerBatch: 3 };
  const normalized = normalizeEngineBudgets({ maxSteerBatch: 5, retryBaseDelayMs: 0 }, defaults);
  assert.deepEqual(normalized, { ...DEFAULT_ENGINE_BUDGETS, turnAllowance: 9, maxSteerBatch: 5, retryBaseDelayMs: 0 });
  defaults.turnAllowance = 1;
  assert.equal(normalized.turnAllowance, 9);
  for (const bad of [{ maxSteerBatch: 0 }, { turnAllowance: 129 }, { maxToolCallsPerTurn: 1025 }, { maxReadConcurrency: 1.5 }, { maxPendingBytes: Infinity }, { unknown: 1 }, { maxProviderAttempts: undefined }]) rejects(() => normalizeEngineBudgets(bad));
  assert.equal(normalizeEngineBudgets({ turnAllowance: 128, maxToolCallsPerTurn: 1024 }).turnAllowance, 128);
});

test('run.submit partial budgets preserve provider defaults and stable JSON transport identity', () => {
  const defaults = { providerId: 'fixture', budgets: { turnAllowance: 8, maxProviderAttempts: 3 } };
  const normalized = normalizeSubmitInput({ ...submit, config: { budgets: { maxProviderAttempts: 2 } } }, defaults);
  assert.equal(normalized.config.providerId, 'fixture');
  assert.deepEqual(normalized.config.budgets, { ...DEFAULT_ENGINE_BUDGETS, turnAllowance: 8, maxProviderAttempts: 2 });
  const transported = validateCommand({ schemaVersion: 1, commandId: 'c1', type: 'run.submit', payload: normalized });
  assert.deepEqual(transported.payload, normalized);
  assert.equal(JSON.stringify(transported.payload), JSON.stringify(normalized));
  rejects(() => normalizeSubmitInput({ ...submit, config: { budgets: undefined } }));
});

test('pending and cancelled inputs never have a Run binding; promotion requires a later session sequence', () => {
  const normalized = validateInputRecord(accepted);
  assert.equal(normalized.runId, undefined);
  assert.equal(normalized.promotedSeq, undefined);
  assert.deepEqual(validateInputReceipt({ inputId: 'i1', admittedSeq: 7, state: 'pending', duplicate: false }), { inputId: 'i1', admittedSeq: 7, state: 'pending', duplicate: false });
  for (const state of ['pending', 'cancelled']) rejects(() => validateInputRecord({ ...accepted, state, runId: 'fake' }));
  rejects(() => validateInputRecord({ ...accepted, state: 'promoted' }));
  rejects(() => validateInputRecord({ ...accepted, state: 'promoted', runId: 'r1', promotedSeq: 7 }));
  assert.equal(validateInputRecord({ ...accepted, state: 'promoted', runId: 'r1', promotedSeq: 9, updatedAt: completedAt }).runId, 'r1');
  rejects(() => validateInputReceipt({ inputId: 'i1', admittedSeq: 7, state: 'promoted', duplicate: true }));
});

test('new input admission is independent and delivery is part of normalized identity', () => {
  assert.deepEqual(normalizeAcceptInput(submit), { ...submit, config, delivery: 'steer' });
  assert.notDeepEqual(normalizeAcceptInput({ ...submit, delivery: 'queue' }), normalizeAcceptInput(submit));
  rejects(() => normalizeAcceptInput({ ...submit, delivery: 'immediate' }));
  rejects(() => normalizeAcceptInput({ ...submit, runId: 'phantom' }));
});

test('new commands are unavailable until explicitly enabled and do not change v1 routing', () => {
  rejects(() => validateSessionCommand(command('input.accept', submit)), 'COMMAND_UNAVAILABLE');
  assert.equal(validateSessionCommand(command('input.accept', submit), { enabledCommands }).payload.delivery, 'steer');
  rejects(() => validateCommand({ ...command('input.accept', submit), schemaVersion: 1 }), 'UNKNOWN_COMMAND');
  rejects(() => validateSessionCommand(command('run.submit', submit), { enabledCommands }), 'UNKNOWN_COMMAND');
  for (const schemaVersion of [1, 3, '2', null]) rejects(() => validateSessionCommand({ ...command('input.accept', submit), schemaVersion }, { enabledCommands }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('input cursors stay session bound and session controls accept only implemented payloads', () => {
  const listed = validateSessionCommand(command('input.list', { sessionId: 's1', cursor: { sessionId: 's1', afterSeq: 8 } }), { enabledCommands });
  assert.equal(listed.payload.limit, 50);
  rejects(() => validateSessionCommand(command('input.list', { sessionId: 's1', cursor: { sessionId: 'other', afterSeq: 8 } }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('input.list', { sessionId: 's1', limit: 101 }), { enabledCommands }));
  for (const type of ['session.pause', 'session.resume']) assert.deepEqual(validateSessionCommand(command(type, { sessionId: 's1' }), { enabledCommands }).payload, { sessionId: 's1' });
  assert.equal(validateSessionCommand(command('input.cancel', { sessionId: 's1', inputId: 'i1' }), { enabledCommands }).payload.inputId, 'i1');
});

test('v2 events and typed cursors cannot be confused with the independent v1 journal', () => {
  assert.equal(validateSessionEvent(event).runId, undefined);
  assert.equal(projectSessionEventToV1(event, 5), undefined);
  const projected = projectSessionEventToV1({ ...event, runId: 'r1', type: 'run.started' }, 5);
  assert.equal(projected?.seq, 5);
  assert.equal(projected?.schemaVersion, 1);
  assert.equal(projected?.runId, 'r1');
  assert.equal(projectSessionEventToV1({ ...event, runId: 'r1', type: 'approval.resolved' }, 6)?.type, 'approval.resolved');
  assert.equal(projectSessionEventToV1({ ...event, runId: 'r1' }, 5), undefined);
  rejects(() => projectSessionEventToV1({ ...event, runId: 'r1', type: 'run.started' }, 0));
  const cursor = { schemaVersion: 2, stream: 'session-v2', sessionId: 's1', afterSeq: 0 };
  assert.deepEqual(validateSessionEventCursor(cursor), cursor);
  rejects(() => validateSessionEventCursor({ ...cursor, stream: 'events' }));
  rejects(() => validateSessionEvent({ ...event, turnId: 't1' }));
  rejects(() => validateSessionEvent({ ...event, runId: 'r1', attemptId: 'a1' }));
  rejects(() => validateSessionEvent({ ...event, schemaVersion: 3 }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('Run v2 preserves the primary input and represents uncertainty as recovery-required terminal state', () => {
  const run: RunRecordV2 = { schemaVersion: 2, id: 'r1', inputId: 'i1', workspaceId: 'w1', ...submit, config, state: 'running', createdAt, updatedAt: createdAt, inputIds: ['i1', 'i2'] };
  assert.deepEqual(validateRunRecordV2(run), run);
  rejects(() => validateRunRecordV2({ ...run, inputIds: ['i2'] }));
  rejects(() => validateRunRecordV2({ ...run, inputIds: ['i1', 'i1'] }));
  const uncertainty = { kind: 'tool_effect', message: '확인되지 않은 실행', requiresRecovery: true };
  rejects(() => validateRunRecordV2({ ...run, uncertainty }));
  assert.equal(validateRunRecordV2({ ...run, state: 'interrupted', uncertainty }).uncertainty?.requiresRecovery, true);
});

test('turn and provider attempts enforce terminal settlement and uncertainty dispatch evidence', () => {
  assert.equal(validateTurnRecord(turn).state, 'created');
  rejects(() => validateTurnRecord({ ...turn, state: 'completed' }));
  rejects(() => validateTurnRecord({ ...turn, inputIds: ['i1', 'i1'] }));
  rejects(() => validateTurnRecord({ ...turn, completedAt }));
  const uncertainty = { kind: 'provider_dispatch', message: '응답 수신 전 연결 종료', requiresRecovery: true };
  assert.equal(validateTurnRecord({ ...turn, state: 'uncertain', completedAt, uncertainty }).state, 'uncertain');
  rejects(() => validateTurnRecord({ ...turn, state: 'uncertain', completedAt, uncertainty: { ...uncertainty, requiresRecovery: false } }));
  assert.equal(validateProviderAttempt(attempt).state, 'prepared');
  rejects(() => validateProviderAttempt({ ...attempt, dispatchedAt: createdAt }));
  rejects(() => validateProviderAttempt({ ...attempt, state: 'streaming' }));
  rejects(() => validateProviderAttempt({ ...attempt, state: 'uncertain', completedAt, uncertainty }));
  assert.equal(validateProviderAttempt({ ...attempt, state: 'uncertain', dispatchedAt: createdAt, completedAt, uncertainty }).state, 'uncertain');
  assert.equal(validateProviderAttempt({ ...attempt, state: 'failed', completedAt }).state, 'failed');
  rejects(() => validateProviderAttempt({ ...attempt, state: 'completed', dispatchedAt: expiresAt, completedAt }));
});

test('provider call IDs are preserved separately from stable internal tool identities across turns', () => {
  const first = validateToolCallIdentity({ id: 'internal1', sessionId: 's1', runId: 'r1', turnId: 't1', attemptId: 'a1', providerCallId: 'provider-repeat' });
  const second = validateToolCallIdentity({ ...first, id: 'internal2', turnId: 't2', attemptId: 'a2' });
  assert.notEqual(first.id, second.id);
  assert.equal(first.providerCallId, second.providerCallId);
  rejects(() => validateToolCallIdentity({ ...first, attemptId: undefined }));
});

test('ordered part identity survives copying and each variant rejects unrelated fields', () => {
  assert.deepEqual(validateMessagePart(part), part);
  rejects(() => validateMessagePart({ ...part, input: {} }));
  rejects(() => validateMessagePart({ ...part, revision: -1 }));
  const input = { nested: ['one'] };
  const toolPart = { ...part, type: 'tool', text: undefined, toolCallId: 'internal1', providerCallId: 'provider1', name: 'read', input };
  delete (toolPart as Partial<typeof toolPart>).text;
  const saved = validateMessagePart(toolPart);
  input.nested[0] = 'changed';
  assert.ok(saved.type === 'tool');
  assert.deepEqual(saved.input, { nested: ['one'] });
  rejects(() => validateMessagePart({ ...part, text: '\ud800' }));
  const media = { ...part, type: 'media', text: undefined, mime: 'text/plain', artifact };
  delete (media as Partial<typeof media>).text;
  assert.equal(validateMessagePart(media).type, 'media');
  rejects(() => validateMessagePart({ ...media, artifact: { ...artifact, identity: { ...artifact.identity, runId: 'other' } } }));
});

test('JSON payload inspection rejects cycles, getters, sparse arrays and trap exceptions without leaking values', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; return 'secret-value'; } });
  rejects(() => validateSessionEvent({ ...event, payload: getter }));
  assert.equal(reads, 0);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  rejects(() => validateSessionEvent({ ...event, payload: cyclic }));
  rejects(() => validateSessionEvent({ ...event, payload: { items: new Array(2) } }));
  const trap = new Proxy({}, { ownKeys() { throw new Error('private-token'); } });
  assert.throws(() => validateSessionEvent({ ...event, payload: trap }), (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.message.includes('private-token'), false); return true; });
  const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
  const copied = validateSessionEvent({ ...event, payload: hostile }).payload;
  assert.equal(Object.hasOwn(copied, '__proto__'), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('artifact accounting distinguishes storage truncation, producer loss and incomplete checkpoints', () => {
  assert.deepEqual(validateArtifactReference(artifact), artifact);
  const partial = { ...artifact, observedBytes: 9, artifactTruncatedBytes: 5, producerTruncatedBytes: null, complete: false, outcome: 'interrupted' };
  assert.equal(validateArtifactReference(partial).producerTruncatedBytes, null);
  assert.equal(validateArtifactReference({ ...partial, observedBytes: 12, artifactTruncatedBytes: 3, producerTruncatedBytes: 5 }).producerTruncatedBytes, 5);
  rejects(() => validateArtifactReference({ ...partial, complete: true }));
  rejects(() => validateArtifactReference({ ...artifact, artifactTruncatedBytes: 1 }));
  rejects(() => validateArtifactReference({ ...artifact, expiresAt: createdAt }));
  rejects(() => validateArtifactReference({ ...artifact, path: '/private/artifact' }));
  const binding = { ...artifact.identity, checkpointId: 'cp1', artifactIds: ['f1'], partial: true };
  assert.deepEqual(validateArtifactCheckpointBinding(binding), binding);
  rejects(() => validateArtifactCheckpointBinding({ ...binding, artifactIds: ['f1', 'f1'] }));
});

test('structured tool results isolate model and display content and reject duplicate artifacts', () => {
  const result = { displayContent: '상세 표시', modelContent: '모델용 요약', structuredData: { matches: [] }, metadata: { source: 'fixture' }, warnings: ['부분 출력'], artifactRefs: [artifact], outcome: 'completed' };
  assert.deepEqual(validateToolResultEnvelope(result), result);
  rejects(() => validateToolResultEnvelope({ ...result, artifactRefs: [artifact, artifact] }));
  rejects(() => validateToolResultEnvelope({ ...result, warnings: [''] }));
});

test('context revision binds optional turns to Runs and rejects duplicate provenance and future schemas', () => {
  const revision = { schemaVersion: 2, id: 'c1', sessionId: 's1', revision: 1, kind: 'baseline', sourceIds: ['repo-instructions'], text: '로컬 규칙', sha256: 'b'.repeat(64), createdAt };
  assert.deepEqual(validateContextRevision(revision), revision);
  rejects(() => validateContextRevision({ ...revision, sourceIds: ['same', 'same'] }));
  rejects(() => validateContextRevision({ ...revision, turnId: 't1' }));
  rejects(() => validateContextRevision({ ...revision, revision: 0 }));
  rejects(() => validateContextRevision({ ...revision, schemaVersion: 9 }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('extended native paging and artifact commands are opt-in with bounded canonical payloads', () => {
  assert.deepEqual(validateSessionCommand(command('engine.getCapabilities', {}), { enabledCommands }).payload, {});
  assert.equal(validateSessionCommand(command('run.getTurns', { runId: 'r1', afterTurnId: 't1' }), { enabledCommands }).payload.limit, 50);
  assert.equal(validateSessionCommand(command('turn.getParts', { turnId: 't1', afterPartId: 'p1', limit: 100 }), { enabledCommands }).payload.limit, 100);
  const payload = { artifactId: 'f1', sessionId: 's1', runId: 'r1', toolCallId: 'internal1' };
  assert.deepEqual(validateSessionCommand(command('artifact.get', payload), { enabledCommands }).payload, { ...payload, offset: 0, limit: 16384 });
  rejects(() => validateSessionCommand(command('artifact.get', { ...payload, attemptId: 'a1' }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('artifact.get', { ...payload, limit: 65537 }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('run.getTurns', { runId: 'r1', limit: 101 }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('turn.getParts', { turnId: 't1' })), 'COMMAND_UNAVAILABLE');
});

test('native task/question controls retain CAS versions and bounded JSON answers', () => {
  const task = { sessionId: 's1', expectedRevision: 0, tasks: [{ id: 'task1', content: 'fixture', state: 'pending' }] };
  assert.deepEqual(validateSessionCommand(command('session.setTasks', task), { enabledCommands }).payload, task);
  for (const type of ['session.getTasks', 'question.list']) assert.deepEqual(validateSessionCommand(command(type, { sessionId: 's1' }), { enabledCommands }).payload, { sessionId: 's1' });
  const answered = { sessionId: 's1', questionId: 'q1', version: 1, answer: { value: 'choice' } };
  assert.deepEqual(validateSessionCommand(command('question.answer', answered), { enabledCommands }).payload, answered);
  rejects(() => validateSessionCommand(command('question.reject', answered), { enabledCommands }));
  rejects(() => validateSessionCommand(command('question.answer', { ...answered, version: 0 }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('question.answer', { ...answered, answer: { value: 'x'.repeat(65536) } }), { enabledCommands }));
  rejects(() => validateSessionCommand(command('session.setTasks', { ...task, tasks: Array(129).fill(null) }), { enabledCommands }));
});
