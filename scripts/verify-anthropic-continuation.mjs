import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineError } from '@moodcode/contracts';
import { parseProviderCoverageArgs, readProviderCredential, freezeProviderCoverageRuntime,
  confirmProviderCoverageFreeze, closeRejectedProviderResponse, qualifyProviderCoverageAccount } from './verify-provider-coverage.mjs';

const ownPath = fileURLToPath(import.meta.url), root = dirname(dirname(ownPath));
const direct = process.argv[1] && resolve(process.argv[1]) === ownPath;
const endpoint = 'https://api.anthropic.com/v1/messages', providerId = 'verify-anthropic-continuation';
const requestTimeoutMs = 45000, cleanupTimeoutMs = 1000, responseBytesLimit = 1048576;
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const requireEvidence = (value, code) => { if (!value) throw new EngineError(code, 'Anthropic continuation evidence is incomplete.'); };
const errorCode = error => /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code ?? '') ? error.code : 'VERIFY_CONTINUATION_FAILED';
const streamFailure = error => ({ name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error?.name ?? '') ? error.name : 'Error', code: errorCode(error) });
function bounded(operation, ms, code) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new EngineError(code, 'Verification deadline exceeded.')), ms); })])
    .finally(() => clearTimeout(timer));
}

export function parseAnthropicContinuationArgs(argv) {
  const options = parseProviderCoverageArgs(['--lane', 'anthropic', ...argv]);
  requireEvidence(options.maxRequests === 3, 'VERIFY_INVALID_ARGUMENT');
  return options;
}

function sourceFrames(chunks) {
  const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n|\r/gu, '\n');
  return text.split('\n\n').slice(0, -1).flatMap(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
}
function sourceBlocks(frames) {
  const blocks = [], argumentsByIndex = new Map();
  for (const event of frames) {
    if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block };
    if (event.type !== 'content_block_delta') continue;
    const block = blocks[event.index], delta = event.delta;
    if (delta.type === 'text_delta') block.text += delta.text;
    else if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
    else if (delta.type === 'signature_delta') block.signature += delta.signature;
    else if (delta.type === 'input_json_delta') argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) ?? '') + delta.partial_json);
  }
  for (const [index, value] of argumentsByIndex) blocks[index].input = JSON.parse(value);
  return blocks;
}
const replayFields = { text: ['type', 'text'], thinking: ['type', 'thinking', 'signature'],
  redacted_thinking: ['type', 'data'], tool_use: ['type', 'id', 'name', 'input'] };
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  return value;
}
export function canonicalReplayBlocks(blocks) {
  requireEvidence(Array.isArray(blocks), 'VERIFY_REPLAY_SOURCE_MISMATCH');
  return blocks.map(block => {
    const fields = block && Object.hasOwn(replayFields, block.type) && replayFields[block.type];
    requireEvidence(fields && fields.every(field => Object.hasOwn(block, field)), 'VERIFY_REPLAY_SOURCE_MISMATCH');
    return canonicalJson(Object.fromEntries(fields.map(field => [field, block[field]])));
  });
}
const replayHash = blocks => jsonHash(canonicalReplayBlocks(blocks));
function replayDiagnostics(blocks) {
  if (!Array.isArray(blocks)) return { observed: false };
  const projected = canonicalReplayBlocks(blocks);
  return { observed: true, count: blocks.length, rawJsonSha256: jsonHash(blocks), semanticSha256: jsonHash(projected),
    blocks: blocks.slice(0, 16).map((block, index) => ({ type: block.type,
      keys: Object.keys(block).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)).sort().slice(0, 16),
      keyCount: Object.keys(block).length, semanticSha256: jsonHash(projected[index]),
      fields: Object.fromEntries(Object.entries(projected[index]).map(([field, value]) => [field, jsonHash(value)])) })),
    truncated: blocks.length > 16 };
}

export async function verifyAnthropicContinuation(argv, runtime = {}) {
  const options = parseAnthropicContinuationArgs(argv);
  const realTransport = Boolean(direct && !Object.keys(runtime).length && !process.env.NODE_OPTIONS
    && !process.execArgv.some(value => /^--(?:import|require|loader|experimental-loader|eval)(?:=|$)|^-[re]/u.test(value)));
  const report = {
    schemaVersion: 1, kind: 'anthropic-continuation-verification', observedAt: new Date().toISOString(),
    implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lane: 'anthropic', modelId: options.model, state: options.live ? 'running' : 'plan-only',
    transport: realTransport ? 'real-remote' : 'local-fixture', passed: false, accountVerified: false,
    maxRequests: 3, actualRequestCountKnown: true, actualRequestCount: 0, actualRequests: [], credentialReads: 0,
    limits: { requestTimeoutMs, cleanupTimeoutMs, responseBytesLimit, maxTokens: 2048, reasoningEffort: 'high', publicReasoningSummary: true },
    authentication: { method: 'api-key', credentialOwner: 'host', persistentAccountIdentity: null,
      ...(options['workspace-id'] ? { workspace: 'host-specified' } : {}) },
    accountIdentityClaimed: false, capabilityReference: options['capability-reference'] ?? null,
    thinking: { scope: 'first-turn blocks replayed in tool continuation', state: 'unobserved', accountVerified: false, publicSummaryAccountVerified: false },
    toolContinuation: { passed: false, accountVerified: false },
    cancellation: { passed: false, accountVerified: false, trigger: 'first observed SSE message_start',
      serverExecutionStopped: null, billingCancelled: null },
    cleanupConfirmed: null, engineClosed: null, sourceRuntimeUnchanged: null, nativeAttempts: [],
  };
  if (!options.live) return report;
  let apiKey, frozen, engine, activeOwner, phase = 'tool-continuation', cancelRequested = false, physicalUnknown = false;
  const observations = [], wire = [], finishes = [];
  try {
    report.credentialReads++;
    apiKey = await (runtime.readCredential ?? readProviderCredential)(options['credential-env'], options['credential-file']);
    if (!apiKey) { report.state = 'external-condition'; report.error = { code: 'VERIFY_CREDENTIAL_UNAVAILABLE' }; return report; }
    requireEvidence(typeof apiKey === 'string' && apiKey.length <= 4096 && !/[^\x21-\x7e]/u.test(apiKey), 'VERIFY_CREDENTIAL_INVALID');
    frozen = await (runtime.freeze ?? freezeProviderCoverageRuntime)();
    report.sourceFreeze = { sha256: frozen.source.sha256, files: frozen.source.files };
    report.runtimeFreeze = { sha256: frozen.runtime.sha256, files: frozen.runtime.files };
    const api = runtime.engineModule ?? await import('../packages/engine/dist/index.js');
    const parent = options.report ? dirname(resolve(options.report)) : tmpdir();
    report.retainedEvidenceDirectory = await realpath(await mkdtemp(join(parent, 'moodcode-anthropic-continuation-')));
    const repository = join(report.retainedEvidenceDirectory, 'repository');
    await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
    const nonce = 'probe-' + randomUUID();
    await writeFile(join(repository, 'challenge.txt'), nonce + '\n', { mode: 0o600 });
    const captureFetch = async (url, init) => {
      try {
        requireEvidence(String(url) === endpoint && init?.method === 'POST' && init.redirect === 'error' && activeOwner, 'VERIFY_ENDPOINT_INVALID');
        const body = JSON.parse(String(init.body));
        requireEvidence(body.model === options.model && report.actualRequests.length < 3, 'VERIFY_REQUEST_BUDGET');
        requireEvidence(body.stream === true && body.max_tokens === 2048 && body.thinking?.display === 'summarized'
          && body.output_config?.effort === 'high', 'VERIFY_WIRE_CONFIG_MISMATCH');
        if (phase === 'tool-continuation' && report.actualRequests.length === 0)
          requireEvidence(!JSON.stringify(body).includes(nonce), 'VERIFY_ANSWER_LEAKED');
        if (phase === 'tool-continuation' && report.actualRequests.length === 1) {
          requireEvidence(wire[0].record.responseModelMatched, 'VERIFY_RESPONSE_MODEL_MISMATCH');
          const source = sourceBlocks(sourceFrames(wire[0].chunks));
          const native = finishes[0]?.replayItems;
          const replay = body.messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool_use'))?.content;
          report.toolContinuation.replayComparison = { projection: 'semantic-replay-fields-v1',
            source: replayDiagnostics(source), native: replayDiagnostics(native), wire: replayDiagnostics(replay) };
          requireEvidence(native && replay && replayHash(source) === replayHash(native) && replayHash(native) === replayHash(replay), 'VERIFY_REPLAY_SOURCE_MISMATCH');
          const result = body.messages.flatMap(message => message.content).find(block => block.type === 'tool_result');
          const tool = native.find(block => block.type === 'tool_use');
          requireEvidence(result?.tool_use_id === tool?.id && result.content.includes(nonce), 'VERIFY_TOOL_RESULT_MISMATCH');
          report.toolContinuation.replay = { projection: 'semantic-replay-fields-v1',
            sourceSha256: replayHash(source), nativeSha256: replayHash(native), wireSha256: replayHash(replay),
            bytes: Buffer.byteLength(JSON.stringify(replay)), toolUseId: tool.id, exactMatch: true };
        }
        const record = { ordinal: report.actualRequests.length + 1, phase, ...activeOwner,
          modelId: body.model, bodyBytes: Buffer.byteLength(String(init.body)), bodySha256: digest(String(init.body)), status: null,
          fetchSignalAborted: false, responseBytes: 0, bodyCloseRequested: false, bodyCloseConfirmed: false, readerReleased: false };
        report.actualRequests.push(record);
        const headers = new Headers(init.headers);
        if (options['workspace-id']) headers.set('anthropic-workspace-id', options['workspace-id']);
        const response = await (runtime.fetch ?? globalThis.fetch)(url, { ...init, headers, redirect: 'error' });
        record.status = response.status;
        if (options['workspace-id']) record.workspaceBindingConfirmed = response.headers.get('anthropic-workspace-id') === options['workspace-id'];
        if (response.redirected || realTransport && response.url !== endpoint) {
          record.bodyCloseConfirmed = await closeRejectedProviderResponse(response, cleanupTimeoutMs);
          if (!record.bodyCloseConfirmed) physicalUnknown = true;
          throw new EngineError(record.bodyCloseConfirmed ? 'VERIFY_ENDPOINT_INVALID' : 'CLEANUP_UNCERTAIN', 'Provider response endpoint is invalid.');
        }
        if (!response.body) return response;
        const reader = response.body.getReader(), memo = { record, chunks: [], signal: init.signal };
        wire.push(memo);
        const release = () => {
          if (record.readerReleased) return;
          try { reader.releaseLock(); record.readerReleased = true; } catch { physicalUnknown = true; }
        };
        const observeAbort = () => { record.fetchSignalAborted = true; };
        init.signal.addEventListener('abort', observeAbort, { once: true });
        memo.detach = () => { record.fetchSignalAborted = init.signal.aborted; init.signal.removeEventListener('abort', observeAbort); };
        return new Response(new ReadableStream({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) {
                release();
                if (!record.bodyCloseRequested) { record.bodyCloseConfirmed = true; controller.close(); }
                return;
              }
              record.responseBytes += item.value.byteLength;
              requireEvidence(record.responseBytes <= responseBytesLimit && memo.chunks.length < 4096, 'VERIFY_RESPONSE_BUDGET');
              memo.chunks.push(Buffer.from(item.value)); controller.enqueue(item.value);
              if (phase === 'cancel' && !cancelRequested && sourceFrames(memo.chunks).some(event => event.type === 'message_start')) {
                cancelRequested = true; report.cancellation.sseStarted = true;
                queueMicrotask(() => {
                  try { report.cancellation.request = engine.coordinator.cancel(record.runId); }
                  catch (error) { report.cancellation.error = { code: errorCode(error) }; }
                });
              }
            } catch (error) { record.bodyReadFailure = streamFailure(error); controller.error(error); }
          },
          async cancel(reason) {
            record.bodyCloseRequested = true;
            try { await reader.cancel(reason); record.bodyCloseConfirmed = true; }
            catch (error) { record.bodyCloseFailure = streamFailure(error); throw error; }
            finally { release(); }
          },
        }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        report.originalHostFailure ??= { code: errorCode(error), phase };
        throw error;
      }
    };
    const adapter = new api.AnthropicProvider({ id: providerId, apiKey, workspaceId: options['workspace-id'], fetch: captureFetch,
      thinking: 'adaptive', publicReasoningSummary: true, maxTokens: 2048, timeoutMs: requestTimeoutMs,
      cleanupTimeoutMs, maxResponseBytes: responseBytesLimit });
    const provider = { id: adapter.id, inputModalities: adapter.inputModalities, replayProtocol: adapter.replayProtocol,
      retryableHttpStatuses: adapter.retryableHttpStatuses, async *streamTurn(request, signal) {
        const cleanup = engine.store.getAttemptCleanup(request.attemptId, request.sessionId);
        for (const name of ['runId', 'sessionId', 'turnId', 'attemptId', 'modelId'])
          requireEvidence(cleanup[name] === request[name], 'VERIFY_NATIVE_OWNER_MISMATCH');
        requireEvidence(cleanup.state === 'dispatched' && cleanup.providerId === providerId
          && cleanup.workspaceId === engine.store.getRun(request.runId).workspaceId
          && cleanup.requestProjection === 'engine-turn-request-v1' && cleanup.requestSha256 === jsonHash(request)
          && cleanup.requestBytes === Buffer.byteLength(JSON.stringify(request)), 'VERIFY_NATIVE_REQUEST_MISMATCH');
        activeOwner = Object.fromEntries(['workspaceId', 'sessionId', 'runId', 'turnId', 'attemptId', 'providerId', 'contextRevisionId', 'requestSha256', 'requestBytes'].map(name => [name, cleanup[name]]));
        observations.push({ ...activeOwner, phase });
        const replay = request.messages.find(message => message.role === 'assistant' && message.toolCalls?.length)?.providerReplay;
        if (replay) requireEvidence(replay.providerId === providerId && replay.modelId === options.model
          && replay.protocol === adapter.replayProtocol && replay.version === 1 && replayHash(replay.items) === replayHash(finishes[0]?.replayItems), 'VERIFY_REPLAY_BINDING_MISMATCH');
        try {
          for await (const event of adapter.streamTurn(request, signal)) {
            if (phase === 'tool-continuation' && event.type === 'finish') finishes.push(event);
            yield event;
          }
        } finally {
          for (const memo of wire.filter(item => item.record.attemptId === request.attemptId)) {
            memo.detach(); memo.record.responseSha256 = digest(Buffer.concat(memo.chunks));
            try {
              const frames = sourceFrames(memo.chunks);
              memo.record.responseModelMatched = frames.find(event => event.type === 'message_start')?.message?.model === options.model;
              const tokens = frames.filter(event => event.type === 'message_delta').at(-1)?.usage?.output_tokens_details?.thinking_tokens;
              if (Number.isSafeInteger(tokens) && tokens >= 0) memo.record.explicitThinkingTokens = tokens;
            } catch (error) { memo.record.sourceObservationFailure = streamFailure(error); }
          }
        }
      } };
    engine = api.createEngine({ dbPath: join(report.retainedEvidenceDirectory, 'engine.sqlite'),
      artifactDir: join(report.retainedEvidenceDirectory, 'artifacts'), providers: [provider],
      tools: api.createReadTools().filter(tool => tool.name === 'read_file'),
      modelSpecs: [api.anthropicModelSpec(options.model, { providerId })], defaults: {
        providerId, modelId: options.model, mode: 'plan', reasoningEffort: 'high',
        limits: { maxTurns: 2, maxToolCalls: 1, maxContextBytes: 1048576, maxOutputBytes: 32768, maxDurationMs: 100000 },
        budgets: { maxProviderAttempts: 1, providerRequestTimeoutMs: requestTimeoutMs, providerInactivityTimeoutMs: requestTimeoutMs },
      } });
    const command = async (type, payload, native = false) => {
      const result = await (native ? engine.dispatchSession : engine.dispatch).call(engine,
        { schemaVersion: native ? 2 : 1, commandId: randomUUID(), type, payload });
      requireEvidence(result.ok, result.error?.code ?? 'VERIFY_NATIVE_COMMAND_FAILED'); return result.result;
    };
    const workspace = await command('workspace.open', { path: repository });
    const submit = async prompt => {
      const session = await command('session.create', { workspaceId: workspace.id });
      const receipt = await command('input.accept', { sessionId: session.id, requestId: randomUUID(), prompt, delivery: 'queue',
        config: { providerId, modelId: options.model, mode: 'plan', reasoningEffort: 'high', budgets: { maxProviderAttempts: 1 } } }, true);
      await bounded(engine.waitForSession(session.id), 110000, 'VERIFY_RUN_TIMEOUT');
      const run = await engine.waitForRun(engine.store.getInput(receipt.inputId).runId);
      return { session, receipt, run, snapshot: engine.store.getSnapshot(session.id) };
    };
    const tool = await submit('Think through this task, use read_file exactly once to read challenge.txt, then reply with only its complete first line. Do not invent its contents.');
    report.toolContinuation.run = { runId: tool.run.id, sessionId: tool.session.id, inputId: tool.receipt.inputId, state: tool.run.state, errorCode: tool.run.error?.code ?? null };
    requireEvidence(tool.run.state === 'completed', tool.run.error?.code ?? 'VERIFY_TOOL_RUN_NONCOMPLETE');
    requireEvidence(report.actualRequests.length === 2 && finishes.length === 2, 'VERIFY_TOOL_REQUEST_COUNT');
    requireEvidence(report.actualRequests.every(request => request.responseModelMatched), 'VERIFY_RESPONSE_MODEL_MISMATCH');
    requireEvidence(observations.every(observation => {
      const usage = engine.store.getAttemptUsage(observation.attemptId)?.usage, request = report.actualRequests.find(item => item.attemptId === observation.attemptId);
      return Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens > 0 && Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens > 0
        && (request.explicitThinkingTokens === undefined || usage.reasoningOutputTokens === request.explicitThinkingTokens);
    }), 'VERIFY_USAGE_MISSING');
    const nativeReplays = tool.snapshot.messages.filter(message => message.runId === tool.run.id && message.providerReplay).map(message => message.providerReplay);
    report.toolContinuation.nativeReplayComparison = nativeReplays.slice(0, 2).map((replay, index) => ({ turn: index + 1,
      source: replayDiagnostics(sourceBlocks(sourceFrames(wire[index].chunks))), native: replayDiagnostics(replay.items) }));
    requireEvidence(nativeReplays.length === 2 && nativeReplays.every((replay, index) => replay.providerId === providerId && replay.modelId === options.model
      && replay.protocol === adapter.replayProtocol && replay.version === 1 && replayHash(replay.items) === replayHash(finishes[index].replayItems)
      && replayHash(replay.items) === replayHash(sourceBlocks(sourceFrames(wire[index].chunks)))), 'VERIFY_NATIVE_REPLAY_MISMATCH');
    const tools = tool.snapshot.tools.filter(item => item.runId === tool.run.id);
    requireEvidence(tools.length === 1 && tools[0].name === 'read_file' && tools[0].state === 'completed', 'VERIFY_TOOL_EFFECT_MISMATCH');
    const output = tool.snapshot.messages.filter(message => message.runId === tool.run.id && message.role === 'assistant' && !message.toolCalls?.length).map(message => message.content).join('').trim();
    requireEvidence(output === nonce, 'VERIFY_RECOGNITION_MISMATCH');
    const blocks = nativeReplays[0].items.filter(block => block.type === 'thinking');
    report.thinking = { ...report.thinking, state: blocks.length ? 'observed' : 'unobserved',
      blocks: blocks.map(block => ({ thinkingBytes: Buffer.byteLength(block.thinking), thinkingSha256: digest(block.thinking),
        signatureBytes: Buffer.byteLength(block.signature), signatureSha256: digest(block.signature) })),
      redactedBlocks: nativeReplays[0].items.filter(block => block.type === 'redacted_thinking').length };
    const firstTurn = engine.store.listTurns(tool.run.id)[0];
    const reasoning = engine.store.listParts(firstTurn.id).filter(part => part.type === 'reasoning').map(part => part.text).join('');
    const summary = blocks.map(block => block.thinking).join('');
    requireEvidence(reasoning === summary, 'VERIFY_NATIVE_REASONING_MISMATCH');
    report.thinking.publicSummary = summary ? 'observed' : 'unobserved';
    report.toolContinuation.passed = true;
    phase = 'cancel';
    const cancel = await submit('Do not use any tools. Think carefully and then write a long numbered list of the integers from 1 to 1000, one number per line.');
    const last = report.actualRequests.at(-1);
    report.cancellation.run = { runId: cancel.run.id, sessionId: cancel.session.id, inputId: cancel.receipt.inputId, state: cancel.run.state, errorCode: cancel.run.error?.code ?? null };
    report.cancellation.clientScope = 'Explicit Engine cancel after observed SSE start, owned fetch AbortSignal and response reader closure; server execution and billing outcomes are unknown.';
    report.cancellation.passed = Boolean(report.actualRequests.length === 3 && last.phase === 'cancel' && cancelRequested
      && report.cancellation.request?.state === 'cancelling' && cancel.run.state === 'cancelled' && last.fetchSignalAborted
      && last.bodyCloseRequested && last.bodyCloseConfirmed && last.readerReleased && last.responseModelMatched);
    requireEvidence(last.bodyCloseConfirmed && last.readerReleased, 'CLEANUP_UNCERTAIN');
    requireEvidence(report.cancellation.passed, cancel.run.error?.code ?? 'VERIFY_CANCEL_UNOBSERVED');
    report.passed = true; report.state = 'completed';
  } catch (error) {
    report.error = { code: errorCode(error) }; report.state = 'failed';
    if (['PROVIDER_UNSUPPORTED_OUTPUT', 'PROVIDER_UNSUPPORTED_EVENT'].includes(errorCode(error))) report.thinking.state = 'unsupported';
  } finally {
    for (const observation of observations) {
      try {
        const cleanup = engine.store.getAttemptCleanup(observation.attemptId, observation.sessionId), attempt = engine.store.getAttempt(observation.attemptId);
        const turn = engine.store.getTurn(observation.turnId);
        requireEvidence(cleanup.requestSha256 === observation.requestSha256 && cleanup.requestBytes === observation.requestBytes
          && cleanup.contextRevisionId === attempt.contextRevisionId, 'VERIFY_NATIVE_OWNER_MISMATCH');
        report.nativeAttempts.push({ ...observation, state: attempt.state, turnState: turn.state,
          cleanup: { state: cleanup.state, confirmed: cleanup.cleanupConfirmed, method: cleanup.method, reason: cleanup.reason, errorCode: cleanup.errorCode ?? null },
          usage: engine.store.getAttemptUsage(observation.attemptId)?.usage ?? null });
      } catch (error) { physicalUnknown = true; report.nativeEvidenceFailure = { code: errorCode(error) }; }
    }
    if (engine) {
      try { await bounded(engine.close(), 5000, 'CLEANUP_UNCERTAIN'); report.engineClosed = true; }
      catch (error) { report.engineClosed = false; physicalUnknown = true; report.cleanupFailure = { code: errorCode(error) }; }
    }
    for (const memo of wire) memo.detach();
    report.actualRequestCount = report.actualRequests.length;
    report.cleanupConfirmed = !physicalUnknown && (!engine || report.engineClosed === true)
      && report.nativeAttempts.length === observations.length && report.nativeAttempts.every(attempt => attempt.cleanup.confirmed === true)
      && report.actualRequests.every(request => request.bodyCloseConfirmed);
    const cancelled = report.nativeAttempts.filter(attempt => attempt.phase === 'cancel');
    if (report.cancellation.passed && !(cancelled.length === 1 && cancelled[0].state === 'interrupted' && cancelled[0].turnState === 'interrupted'
      && cancelled[0].cleanup.confirmed === true && cancelled[0].cleanup.reason === 'cancel')) {
      report.cancellation.passed = false; report.passed = false; report.state = 'failed';
      report.error ??= { code: 'VERIFY_NATIVE_CANCEL_MISMATCH' };
    }
    if (frozen) await confirmProviderCoverageFreeze(report, frozen, runtime.freeze ?? freezeProviderCoverageRuntime);
    if (!report.cleanupConfirmed) { report.passed = false; report.state = 'uncertain'; }
    if (frozen && !report.sourceRuntimeUnchanged) { report.passed = false; report.state = 'failed'; report.error ??= { code: 'VERIFY_SOURCE_CHANGED' }; }
    report.accountVerified = qualifyProviderCoverageAccount(report, options, realTransport);
    report.toolContinuation.accountVerified = report.accountVerified && report.toolContinuation.passed;
    report.cancellation.accountVerified = report.accountVerified && report.cancellation.passed;
    report.thinking.accountVerified = report.accountVerified && report.thinking.state === 'observed';
    report.thinking.publicSummaryAccountVerified = report.thinking.accountVerified && report.thinking.publicSummary === 'observed';
  }
  const serialized = JSON.stringify(report);
  return JSON.parse(typeof apiKey === 'string' ? serialized.replaceAll(apiKey, '[REDACTED]') : serialized);
}

if (direct) {
  try {
    const options = parseAnthropicContinuationArgs(process.argv.slice(2)), report = await verifyAnthropicContinuation(process.argv.slice(2));
    if (options.report) await writeFile(resolve(options.report), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ state: report.state, modelId: report.modelId, passed: report.passed, accountVerified: report.accountVerified,
      thinking: report.thinking.state, requests: report.actualRequestCount, cleanupConfirmed: report.cleanupConfirmed, error: report.error ?? null }));
    if (options.live && !report.accountVerified) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ code: errorCode(error) })); process.exitCode = 1; }
}
