import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as api from '../packages/engine/dist/index.js';
import { canonicalReplayBlocks, parseAnthropicContinuationArgs, verifyAnthropicContinuation } from './verify-anthropic-continuation.mjs';

const model = 'local-anthropic-continuation', workspace = 'wrkspc_Local123', key = 'fixture-only-auth-not-an-account';
const wire = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const start = () => ({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model,
  content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
const block = (index, content, deltas = []) => [{ type: 'content_block_start', index, content_block: content },
  ...deltas.map(delta => ({ type: 'content_block_delta', index, delta })), { type: 'content_block_stop', index }];
const finish = (reason, thinking = 0) => [{ type: 'message_delta', delta: { stop_reason: reason },
  usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: thinking } } }, { type: 'message_stop' }];
const baseArgs = ['--model', model, '--live', '--max-requests', '3', '--credential-env', 'FIXTURE_KEY',
  '--capability-reference', 'local-authored-protocol-fixture', '--workspace-id', workspace];

async function fixture(mode = 'complete', engineModule = api, loopback) {
  const parent = resolve('artifacts/next-continuation/anthropic-continuation-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-')), requests = [], signals = [];
  let cancelled = 0;
  const runtime = { engineModule, readCredential: () => key, fetch(url, init) {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal); signals.push(init.signal);
    const headers = new Headers(init.headers), body = JSON.parse(init.body);
    assert.equal(headers.get('x-api-key'), key); assert.equal(headers.get('anthropic-workspace-id'), workspace);
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    assert.equal(body.model, model); assert.equal(body.max_tokens, 2048); assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' }); assert.deepEqual(body.output_config, { effort: 'high' });
    requests.push(body); assert.ok(requests.length <= 3);
    const responseHeaders = { 'content-type': 'text/event-stream', ...(mode === 'workspace-missing' ? {}
      : { 'anthropic-workspace-id': mode === 'workspace-mismatch' ? 'wrkspc_Foreign' : workspace }) };
    if (requests.length === 3) {
      if (mode === 'http-cancel') return globalThis.fetch(loopback, init);
      const events = mode === 'cancel-unobserved' ? [{ type: 'ping' }] : [start()];
      const body = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(wire(events))); if (mode === 'cancel-unobserved') controller.close(); },
        cancel() {
          cancelled++;
          if (mode === 'cancel-rejected') return Promise.reject(new Error('Fixture cancellation rejected'));
          if (mode === 'cancel-unjoinable') return new Promise(() => {});
        },
      });
      return new Response(body, { headers: responseHeaders });
    }
    const blocks = body.messages.flatMap(message => message.content), result = blocks.find(item => item.type === 'tool_result');
    let events;
    if (result) {
      const nonce = result.content.match(/probe-[a-f0-9-]{36}/u)?.[0]; assert.ok(nonce);
      const replay = blocks.find(item => item.type === 'thinking');
      if (mode !== 'no-thinking') assert.deepEqual(replay, { type: 'thinking', thinking: 'Visible fixture summary 🌊', signature: 'opaque-fixture-signature' });
      events = [start(), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: mode === 'wrong-answer' ? 'wrong' : nonce }]), ...finish('end_turn')];
    } else {
      assert.equal(JSON.stringify(body).includes('probe-'), false);
      const reasoning = mode === 'no-thinking' ? [] : block(0, { type: 'thinking', thinking: '', signature: '' }, [
        { type: 'thinking_delta', thinking: 'Visible fixture summary 🌊' },
        ...(mode === 'missing-signature' ? [] : [{ type: 'signature_delta', signature: 'opaque-fixture-signature' }]),
      ]);
      events = [start(), ...reasoning, ...block(mode === 'no-thinking' ? 0 : 1,
        { type: 'tool_use', id: 'toolu-read', name: 'read_file', input: {} }, [{ type: 'input_json_delta', partial_json: '{"path":"challenge.txt"}' }]), ...finish('tool_use', mode === 'no-thinking' ? 0 : 4)];
    }
    if (mode === 'usage-missing') {
      const usage = events.find(event => event.type === 'message_delta').usage;
      usage.output_tokens = 0; usage.output_tokens_details.thinking_tokens = 0;
    }
    if (mode === 'response-model-mismatch') events[0].message.model = 'foreign-model';
    if (mode === 'api-field-order') for (const event of events) if (event.content_block)
      event.content_block = { _server_metadata: { observation: true }, ...Object.fromEntries(Object.entries(event.content_block).reverse()) };
    const bytes = Buffer.from(mode === 'malformed-json' ? 'data: invalid-json\n\n' : wire(events)); let at = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (at === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(at, at = Math.min(bytes.length, at + 17)));
    } }), { headers: responseHeaders });
  } };
  return { directory, requests, signals, cancellations: () => cancelled, async run(extra = {}) {
    const report = await verifyAnthropicContinuation([...baseArgs, '--report', join(directory, 'report.json')], { ...runtime, ...extra });
    await writeFile(join(directory, 'fixture-result.json'), JSON.stringify({ localFixture: { mode, actualLoopbackHttp: mode === 'http-cancel' }, ...report }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } };
}

test('plan and invalid configuration do not resolve credentials or execute a provider', async () => {
  const unexpected = () => { throw new Error('Unexpected effect'); };
  const report = await verifyAnthropicContinuation(['--model', model], { readCredential: unexpected, fetch: unexpected,
    get engineModule() { unexpected(); } });
  assert.equal(report.state, 'plan-only'); assert.equal(report.credentialReads, 0); assert.equal(report.accountVerified, false);
  assert.equal(report.thinking.state, 'unobserved'); assert.deepEqual(report.actualRequests, []);
  for (const args of [[], ['--model', model, '--max-requests', '2'], ['--model', model, '--max-requests', '4'],
    ['--model', model, '--live'], ['--model', model, '--workspace-id', 'wrkspc_'],
    ['--model', model, '--workspace-id', 'wrkspc_a-b'], ['--model', model, '--lane', 'media']])
    assert.throws(() => parseAnthropicContinuationArgs(args), { code: 'VERIFY_INVALID_ARGUMENT' });
  const cli = spawnSync(process.execPath, ['scripts/verify-anthropic-continuation.mjs', '--model', model], { encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).requests, 0); assert.equal(JSON.parse(cli.stdout).accountVerified, false);
});

test('missing explicit host credential is external, without a runtime import or native files', async () => {
  const report = await verifyAnthropicContinuation(baseArgs, { readCredential: () => undefined,
    get engineModule() { assert.fail('Unexpected import'); }, fetch() { assert.fail('Unexpected fetch'); } });
  assert.equal(report.state, 'external-condition'); assert.equal(report.error.code, 'VERIFY_CREDENTIAL_UNAVAILABLE');
  assert.equal(report.credentialReads, 1); assert.equal(report.actualRequestCount, 0); assert.equal(report.retainedEvidenceDirectory, undefined);
});

test('native signed thinking/tool continuation and client cancellation use exactly three requests', { timeout: 30000 }, async () => {
  const f = await fixture(), report = await f.run();
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.state, 'completed');
  assert.equal(report.transport, 'local-fixture'); assert.equal(report.accountVerified, false); assert.equal(report.sourceRuntimeUnchanged, true);
  assert.equal(report.actualRequestCount, 3); assert.equal(f.requests.length, 3); assert.equal(f.cancellations(), 1);
  assert.equal(report.cleanupConfirmed, true); assert.equal(report.engineClosed, true);
  assert.equal(report.toolContinuation.passed, true); assert.equal(report.toolContinuation.replay.exactMatch, true);
  assert.equal(report.toolContinuation.replay.sourceSha256, report.toolContinuation.replay.nativeSha256);
  assert.equal(report.toolContinuation.replay.nativeSha256, report.toolContinuation.replay.wireSha256);
  assert.equal(report.thinking.state, 'observed'); assert.equal(report.thinking.publicSummary, 'observed');
  assert.equal(report.thinking.blocks.length, 1); assert.ok(report.thinking.blocks[0].signatureBytes > 0); assert.ok(report.thinking.blocks[0].thinkingBytes > 0);
  assert.equal(report.thinking.accountVerified, false); assert.equal(report.thinking.publicSummaryAccountVerified, false);
  assert.equal(report.cancellation.passed, true); assert.equal(report.cancellation.run.state, 'cancelled');
  assert.equal(report.cancellation.serverExecutionStopped, null); assert.equal(report.cancellation.billingCancelled, null);
  assert.equal(report.actualRequests[2].fetchSignalAborted, true); assert.equal(f.signals[2].aborted, true);
  assert.equal(report.actualRequests[2].bodyCloseRequested, true); assert.equal(report.actualRequests[2].bodyCloseConfirmed, true);
  assert.equal(report.actualRequests[2].readerReleased, true); assert.ok(report.actualRequests.every(request => request.workspaceBindingConfirmed));
  assert.equal(report.nativeAttempts.length, 3); assert.ok(report.nativeAttempts.every(attempt => attempt.cleanup.confirmed && attempt.contextRevisionId && attempt.requestBytes > 0));
  assert.equal(report.nativeAttempts[2].state, 'interrupted'); assert.equal(report.nativeAttempts[2].cleanup.reason, 'cancel');
  assert.equal(report.actualRequests[0].explicitThinkingTokens, 4); assert.equal(report.nativeAttempts[0].usage.reasoningOutputTokens, 4);
  assert.equal(report.actualRequests[1].explicitThinkingTokens, 0); assert.equal(report.nativeAttempts[1].usage.reasoningOutputTokens, 0);
  assert.equal(Object.hasOwn(report.actualRequests[2], 'explicitThinkingTokens'), false);
  assert.equal(JSON.stringify(report).includes(key), false); assert.equal(JSON.stringify(report).includes('opaque-fixture-signature'), false);
  assert.equal(JSON.stringify(report).includes('Visible fixture summary'), false); assert.equal(JSON.stringify(report).includes(workspace), false);
  await access(join(report.retainedEvidenceDirectory, 'engine.sqlite'));
});

test('no thinking blocks stays unobserved and does not increase the request budget', { timeout: 30000 }, async () => {
  const f = await fixture('no-thinking'), report = await f.run();
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.thinking.state, 'unobserved');
  assert.deepEqual(report.thinking.blocks, []); assert.equal(report.thinking.publicSummary, 'unobserved');
  assert.equal(report.thinking.accountVerified, false); assert.equal(report.thinking.publicSummaryAccountVerified, false);
  assert.equal(report.actualRequestCount, 3); assert.equal(f.requests.length, 3);
});

test('semantic projection preserves exact replay values and array order while ignoring API field order and metadata', () => {
  const blocks = [{ type: 'text', text: 'Visible text 🌊' }, { type: 'thinking', thinking: 'Summary', signature: 'opaque-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted' },
    { type: 'tool_use', id: 'toolu-exact', name: 'read_file', input: { path: 'challenge.txt', nested: { z: [1, { b: true, a: null }], a: '1' } } }];
  const reordered = blocks.map(block => ({ server_only: true, ...Object.fromEntries(Object.entries(block).reverse()) }));
  reordered[3].input = { nested: { a: '1', z: [1, { a: null, b: true }] }, path: 'challenge.txt' };
  assert.deepEqual(canonicalReplayBlocks(reordered), canonicalReplayBlocks(blocks));
  for (const [index, field, value] of [[0, 'text', 'Changed'], [1, 'thinking', 'Changed'], [1, 'signature', 'forged'],
    [2, 'data', 'forged'], [3, 'id', 'foreign'], [3, 'name', 'foreign'],
    [3, 'input', { ...blocks[3].input, nested: { ...blocks[3].input.nested, a: 1 } }],
    [3, 'input', { ...blocks[3].input, nested: { ...blocks[3].input.nested, z: [{ b: true, a: null }, 1] } }]]) {
    const changed = blocks.map((block, at) => at === index ? { ...block, [field]: value } : block);
    assert.notDeepEqual(canonicalReplayBlocks(changed), canonicalReplayBlocks(blocks));
  }
  assert.notDeepEqual(canonicalReplayBlocks([...blocks].reverse()), canonicalReplayBlocks(blocks));
  assert.throws(() => canonicalReplayBlocks([{ type: 'thinking', thinking: 'Summary' }]), { code: 'VERIFY_REPLAY_SOURCE_MISMATCH' });
});

test('native API field order and extra server metadata do not prevent exact tool replay', { timeout: 30000 }, async () => {
  const f = await fixture('api-field-order'), report = await f.run();
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.actualRequestCount, 3); assert.equal(report.accountVerified, false);
  const comparison = report.toolContinuation.replayComparison;
  assert.equal(comparison.projection, 'semantic-replay-fields-v1');
  assert.notEqual(comparison.source.rawJsonSha256, comparison.native.rawJsonSha256);
  assert.equal(comparison.source.semanticSha256, comparison.native.semanticSha256);
  assert.equal(comparison.native.semanticSha256, comparison.wire.semanticSha256);
  assert.ok(comparison.source.blocks.every(block => block.keys.includes('_server_metadata')));
  assert.ok(comparison.native.blocks.every(block => !block.keys.includes('_server_metadata')));
  assert.equal(JSON.stringify(report).includes('opaque-fixture-signature'), false);
  assert.equal(JSON.stringify(report).includes('Visible fixture summary'), false);
});

for (const [mode, code, count] of [['missing-signature', 'PROVIDER_MALFORMED_STREAM', 1], ['malformed-json', 'PROVIDER_MALFORMED_STREAM', 1], ['wrong-answer', 'VERIFY_RECOGNITION_MISMATCH', 2],
  ['usage-missing', 'VERIFY_USAGE_MISSING', 2],
  ['cancel-unobserved', 'PROVIDER_INCOMPLETE_STREAM', 3], ['cancel-rejected', 'CLEANUP_UNCERTAIN', 3], ['cancel-unjoinable', 'CLEANUP_UNCERTAIN', 3]])
  test(`native ${mode} preserves original failure without thinking or cancellation account credit`, { timeout: 30000 }, async () => {
    const f = await fixture(mode), report = await f.run();
    assert.equal(report.passed, false, JSON.stringify(report)); assert.equal(report.error.code, code);
    assert.equal(report.accountVerified, false); assert.equal(report.thinking.accountVerified, false); assert.equal(report.cancellation.accountVerified, false);
    assert.equal(report.actualRequestCount, count); assert.equal(f.requests.length, count); assert.equal(report.engineClosed, true);
    if (mode === 'cancel-rejected' || mode === 'cancel-unjoinable') {
      assert.equal(report.cleanupConfirmed, false); assert.equal(report.state, 'uncertain');
      assert.equal(report.actualRequests[2].bodyCloseConfirmed, false); assert.equal(report.nativeAttempts[2].cleanup.confirmed, true);
    }
    await access(join(report.retainedEvidenceDirectory, 'engine.sqlite'));
  });

for (const changedField of ['signature', 'input', 'id'])
test(`changed native replay ${changedField} is rejected before its continuation reaches transport`, { timeout: 30000 }, async () => {
  class ChangedReplay extends api.AnthropicProvider {
    async *streamTurn(request, signal) {
      const changedTool = call => ({ ...call, [changedField]: changedField === 'input' ? { path: './challenge.txt' } : call.id + '-changed' });
      for await (const event of super.streamTurn(request, signal)) {
        if (event.type === 'finish') yield { ...event, replayItems: event.replayItems.map(block => changedField === 'signature' && block.type === 'thinking'
          ? { ...block, signature: block.signature + '-changed' } : changedField !== 'signature' && block.type === 'tool_use'
            ? changedTool(block) : block) };
        else if (event.type === 'tool.call' && changedField !== 'signature') yield { ...event, call: changedTool(event.call) };
        else yield event;
      }
    }
  }
  const f = await fixture('complete', { ...api, AnthropicProvider: ChangedReplay }), report = await f.run();
  assert.equal(report.passed, false); assert.equal(report.accountVerified, false); assert.equal(report.error.code, 'PROVIDER_TRANSPORT_ERROR');
  assert.equal(report.originalHostFailure.code, 'VERIFY_REPLAY_SOURCE_MISMATCH');
  assert.equal(report.actualRequestCount, 1); assert.equal(f.requests.length, 1); assert.equal(report.cleanupConfirmed, true);
  assert.notEqual(report.toolContinuation.replayComparison.source.semanticSha256, report.toolContinuation.replayComparison.native.semanticSha256);
});

test('foreign response model is rejected without switching or dispatching continuation', { timeout: 30000 }, async () => {
  const f = await fixture('response-model-mismatch'), report = await f.run();
  assert.equal(report.passed, false); assert.equal(report.accountVerified, false); assert.equal(report.actualRequestCount, 1);
  assert.equal(report.originalHostFailure.code, 'VERIFY_RESPONSE_MODEL_MISMATCH'); assert.equal(report.actualRequests[0].responseModelMatched, false);
});

test('actual loopback HTTP cancellation joins reader before fetch abort without server credit', { timeout: 30000 }, async t => {
  let observedClose;
  const closed = new Promise(resolveClose => { observedClose = resolveClose; }), errors = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.method, 'POST'); assert.equal(incoming.headers['x-api-key'], key);
      const chunks = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      assert.equal(JSON.parse(Buffer.concat(chunks)).model, model);
      outgoing.on('close', observedClose);
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-workspace-id': workspace });
      outgoing.write(wire([start()]));
    })().catch(error => { errors.push(error); outgoing.destroy(); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); assert.deepEqual(errors, []); });
  const f = await fixture('http-cancel', api, `http://127.0.0.1:${server.address().port}/messages`), report = await f.run();
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP socket did not close')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(report.transport, 'local-fixture'); assert.equal(report.actualRequestCount, 3); assert.equal(report.accountVerified, false);
  assert.equal(report.cancellation.sseStarted, true); assert.equal(report.cancellation.run.state, 'cancelled'); assert.equal(f.signals[2].aborted, true);
  assert.equal(report.actualRequests[2].bodyCloseRequested, true); assert.equal(report.actualRequests[2].readerReleased, true);
  assert.equal(report.nativeAttempts[2].cleanup.confirmed, true);
  assert.equal(report.actualRequests[2].bodyCloseConfirmed, true, JSON.stringify({ path: f.directory, state: report.state,
    error: report.error, request: report.actualRequests[2] }));
  assert.equal(report.cleanupConfirmed, true); assert.equal(report.passed, true); assert.equal(report.state, 'completed');
  assert.equal(report.cancellation.serverExecutionStopped, null); assert.equal(report.cancellation.billingCancelled, null);
  await writeFile(join(f.directory, 'loopback-proof.json'), JSON.stringify({ actualNodeHttp: true, socketCloseObserved: true,
    actualRequestCount: 3, ownedFetchSignalAborted: f.signals[2].aborted, readerCancelFulfilled: report.actualRequests[2].bodyCloseConfirmed,
    readerReleased: report.actualRequests[2].readerReleased, nativeAttemptCleanupConfirmed: report.nativeAttempts[2].cleanup.confirmed,
    fixtureReportPath: join(f.directory, 'fixture-result.json'),
    fixtureReportSha256: createHash('sha256').update(JSON.stringify({ localFixture: { mode: 'http-cancel', actualLoopbackHttp: true }, ...report }, null, 2) + '\n').digest('hex'),
    accountVerified: false, serverExecutionStopped: null, billingCancelled: null }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await access(join(report.retainedEvidenceDirectory, 'engine.sqlite'));
});

for (const mode of ['workspace-missing', 'workspace-mismatch'])
  test(`${mode} preserves local observations but cannot produce account credit`, { timeout: 30000 }, async () => {
    const f = await fixture(mode), report = await f.run();
    assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.transport, 'local-fixture'); assert.equal(report.accountVerified, false);
    assert.equal(report.actualRequestCount, 3); assert.ok(report.actualRequests.every(request => request.workspaceBindingConfirmed === false));
  });

test('source drift revokes a successful native observation and keeps originals', { timeout: 30000 }, async () => {
  let freezes = 0;
  const f = await fixture(), report = await f.run({ freeze: async () => ({ source: { sha256: freezes++ ? 'b'.repeat(64) : 'a'.repeat(64), files: 1 },
    runtime: { sha256: 'c'.repeat(64), files: 1 } }) });
  assert.equal(report.toolContinuation.passed, true); assert.equal(report.cancellation.passed, true);
  assert.equal(report.passed, false); assert.equal(report.sourceRuntimeUnchanged, false); assert.equal(report.error.code, 'VERIFY_SOURCE_CHANGED');
  assert.equal(report.accountVerified, false); assert.equal(report.actualRequestCount, 3);
  await access(join(report.retainedEvidenceDirectory, 'engine.sqlite'));
});
