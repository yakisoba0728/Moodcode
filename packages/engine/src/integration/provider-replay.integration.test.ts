import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LIMITS, type EngineEvent, type JsonObject, type RunConfig, type RunReceipt, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { ResponsesProvider } from '../provider/responses.js';
import { SqliteStore } from '../storage/index.js';
import { createReadTools } from '../tools/read/index.js';

type Engine = ReturnType<typeof createEngine>;
const execFileAsync = promisify(execFile);
const PROVIDER_ID = 'native-replay-integration';
const MODEL_ID = 'loopback-fixture-model';
const PROMPT = 'Read the first two lines of file.txt and describe them.';
const FOLLOWUP = 'Continue using the saved conversation.';
const FILE_CONTENT = 'first fixture line\nsecond fixture line\nthird line is outside the requested range\n';
const COMMENTARY = 'Checking the first two lines.';
const ANSWER = 'The file starts with first fixture line and second fixture line.';
// These values parse to integers and file.txt, but serialization would change
// their native argument text. Replay must retain the completed wire formatting.
const ARGUMENTS = '{\n  "path" : "fi\\u006ce.txt",\n  "startLine" : 1e0,\n  "endLine" : 2.0\n}';
const REASONING: JsonObject = {
  id: 'rs-native-replay', type: 'reasoning', status: 'completed',
  summary: [{ type: 'summary_text', text: 'Fixture-only summary' }],
  encrypted_content: 'opaque-native-replay-fixture-ciphertext',
};
const COMMENTARY_ITEM: JsonObject = {
  id: 'msg-native-commentary', type: 'message', status: 'completed', role: 'assistant', phase: 'commentary',
  content: [{ type: 'output_text', text: COMMENTARY, annotations: [] }],
};
const CALL: JsonObject = {
  id: 'fc-native-read', type: 'function_call', status: 'completed',
  call_id: 'call-native-read', name: 'read_file', arguments: ARGUMENTS,
};
const FIRST_ITEMS = [REASONING, COMMENTARY_ITEM, CALL];
const ANSWER_ITEM: JsonObject = {
  id: 'msg-native-final-answer', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
  content: [{ type: 'output_text', text: ANSWER, annotations: [] }],
};
const FOLLOWUP_ITEM: JsonObject = {
  id: 'msg-native-followup', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
  content: [{ type: 'output_text', text: 'Follow-up completed with saved native history.', annotations: [] }],
};
const CONFIG: RunConfig = {
  providerId: PROVIDER_ID, modelId: MODEL_ID, mode: 'plan',
  limits: { ...DEFAULT_LIMITS, maxDurationMs: 15_000, toolTimeoutMs: 5_000 },
};

function frame(event: JsonObject): string {
  return `event: ${String(event.type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
}

function itemAdded(item: JsonObject, outputIndex: number): JsonObject {
  return { type: 'response.output_item.added', output_index: outputIndex, item };
}

function itemDone(item: JsonObject, outputIndex: number): JsonObject {
  return { type: 'response.output_item.done', output_index: outputIndex, item };
}

function messageLifecycle(item: JsonObject, outputIndex: number): JsonObject[] {
  const part = (item.content as JsonObject[])[0]!;
  const text = part.text as string;
  const position = { item_id: item.id!, output_index: outputIndex, content_index: 0 };
  const split = Math.floor(text.length / 2);
  return [
    itemAdded({ id: item.id!, type: 'message', status: 'in_progress', role: 'assistant', phase: item.phase!, content: [] }, outputIndex),
    { type: 'response.content_part.added', ...position, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', ...position, delta: text.slice(0, split) },
    { type: 'response.output_text.delta', ...position, delta: text.slice(split) },
    { type: 'response.output_text.done', ...position, text },
    { type: 'response.content_part.done', ...position, part },
    itemDone(item, outputIndex),
  ];
}

function responseLifecycle(responseId: string, items: JsonObject[], contentEvents: JsonObject[]): JsonObject[] {
  return [
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    { type: 'response.in_progress', response: { id: responseId, status: 'in_progress' } },
    ...contentEvents,
    { type: 'response.completed', response: { id: responseId, status: 'completed', output: items, usage: { input_tokens: 20, output_tokens: 7 } } },
  ];
}

function firstResponse(): JsonObject[] {
  const summaryPosition = { item_id: REASONING.id!, output_index: 0, summary_index: 0 };
  const summary = (REASONING.summary as JsonObject[])[0]!;
  const callPosition = { item_id: CALL.id!, output_index: 2 };
  const split = Math.floor(ARGUMENTS.length / 2);
  return responseLifecycle('resp-native-tool-turn', FIRST_ITEMS, [
    itemAdded({ id: REASONING.id!, type: 'reasoning', status: 'in_progress', summary: [] }, 0),
    { type: 'response.reasoning_summary_part.added', ...summaryPosition, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', ...summaryPosition, delta: summary.text! },
    { type: 'response.reasoning_summary_text.done', ...summaryPosition, text: summary.text! },
    { type: 'response.reasoning_summary_part.done', ...summaryPosition, part: summary },
    itemDone(REASONING, 0),
    ...messageLifecycle(COMMENTARY_ITEM, 1),
    itemAdded({ ...CALL, status: 'in_progress', arguments: '' }, 2),
    { type: 'response.function_call_arguments.delta', ...callPosition, delta: ARGUMENTS.slice(0, split) },
    { type: 'response.function_call_arguments.delta', ...callPosition, delta: ARGUMENTS.slice(split) },
    { type: 'response.function_call_arguments.done', ...callPosition, arguments: ARGUMENTS },
    itemDone(CALL, 2),
  ]);
}

async function readRequest(incoming: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
}

async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(result.ok, true, `${type}: ${JSON.stringify(result.error)}`);
  return result.result as unknown as T;
}

async function submit(engine: Engine, sessionId: string, requestId: string, prompt = PROMPT): Promise<RunReceipt> {
  return command(engine, 'run.submit', { sessionId, requestId, prompt, config: CONFIG as unknown as JsonObject });
}

async function eventsForCompletedRun(engine: Engine, sessionId: string, runId: string): Promise<EngineEvent[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('journal replay timed out')), 5_000);
  const events: EngineEvent[] = [];
  try {
    for await (const event of engine.subscribe(sessionId, 0, abort.signal)) {
      events.push(event);
      if (event.runId === runId && event.type === 'run.completed') return events;
    }
    assert.fail('journal ended without run.completed');
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

test('native Responses replay survives the real coding loop, SQLite reopen, duplicate delivery and follow-up history', { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-native-replay-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet', repository]);
  await writeFile(join(repository, 'file.txt'), FILE_CONTENT);
  const requests: JsonObject[] = [];
  const serverErrors: unknown[] = [];
  let engine: Engine | undefined;
  const server = createServer((incoming, outgoing: ServerResponse) => {
    void (async () => {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/v1/responses');
      assert.equal(incoming.headers.authorization, undefined, 'the loopback fixture needs no API key');
      assert.equal(incoming.headers.accept, 'text/event-stream');
      requests.push(await readRequest(incoming));
      const requestIndex = requests.length - 1;
      assert.ok(requestIndex < 3, 'duplicate delivery or history replay must not cause unexpected HTTP calls');
      const events = requestIndex === 0 ? firstResponse()
        : requestIndex === 1 ? responseLifecycle('resp-native-answer-turn', [ANSWER_ITEM], messageLifecycle(ANSWER_ITEM, 0))
          : responseLifecycle('resp-native-followup-turn', [FOLLOWUP_ITEM], messageLifecycle(FOLLOWUP_ITEM, 0));
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      // Separate writes exercise streaming lifecycle processing rather than a
      // completed response object injected directly into the runner.
      for (const event of events) outgoing.write(frame(event));
      outgoing.end();
    })().catch((error: unknown) => { serverErrors.push(error); outgoing.destroy(); });
  });
  t.after(async () => {
    try {
      await engine?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(serverErrors, [], 'the loopback SSE fixture completed successfully');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const dbPath = join(root, 'engine.sqlite');
  const options = () => ({
    dbPath, artifactDir: join(root, 'artifacts'),
    providers: [new ResponsesProvider({ id: PROVIDER_ID, baseURL, timeoutMs: 5_000 })],
    tools: createReadTools(),
  });
  engine = createEngine(options());
  assert.ok(engine.store instanceof SqliteStore, 'the test uses the real SQLite journal and projections');
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: repository });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: 'Native replay integration' });
  const receipt = await submit(engine, session.id, 'native-read-request');
  const run = await engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  assert.equal(requests.length, 2, 'the runner executes a real read tool between two native HTTP turns');
  const snapshot = await command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  const toolMessage = snapshot.messages.find((message) => message.role === 'tool' && message.toolCallId === CALL.call_id);
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /first fixture line/);
  assert.match(toolMessage.content, /second fixture line/);
  assert.ok(!toolMessage.content.includes('third line is outside the requested range'));
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0]?.state, 'completed', JSON.stringify(snapshot.tools[0]));
  assert.equal(snapshot.tools[0]?.name, 'read_file');
  assert.deepEqual(snapshot.tools[0]?.input, { path: 'file.txt', startLine: 1, endLine: 2 });
  assert.equal(snapshot.approvals.length, 0, 'read_file requires no mutation approval');
  const assistantWithCall = snapshot.messages.find((message) => message.role === 'assistant' && message.toolCalls?.length);
  assert.ok(assistantWithCall);
  assert.equal(assistantWithCall.content, COMMENTARY);
  assert.deepEqual(assistantWithCall.providerReplay, { providerId: PROVIDER_ID, items: FIRST_ITEMS, modelId: MODEL_ID, protocol: 'openai-responses', version: 1 });
  assert.deepEqual(assistantWithCall.toolCalls, [{ id: CALL.call_id, name: 'read_file', input: { path: 'file.txt', startLine: 1, endLine: 2 } }]);
  const finalAssistant = snapshot.messages.find((message) => message.role === 'assistant' && message.content === ANSWER);
  assert.deepEqual(finalAssistant?.providerReplay, { providerId: PROVIDER_ID, items: [ANSWER_ITEM], modelId: MODEL_ID, protocol: 'openai-responses', version: 1 });
  const originalInput = requests[0]?.input;
  assert.ok(Array.isArray(originalInput));
  assert.equal((originalInput.at(-1) as JsonObject).content, PROMPT);
  const toolOutput = { type: 'function_call_output', call_id: CALL.call_id, output: toolMessage.content };
  assert.deepEqual(requests[1]?.input, [...originalInput, ...FIRST_ITEMS, toolOutput], 'native reasoning, commentary and call remain in order immediately before the real tool output');
  assert.notEqual(ARGUMENTS, JSON.stringify(snapshot.tools[0]?.input), 'the fixture detects accidental argument reserialization');
  for (const request of requests) {
    assert.equal(request.model, MODEL_ID);
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.deepEqual(request.include, ['reasoning.encrypted_content']);
    assert.equal(request.previous_response_id, undefined, 'the engine owns persisted history rather than provider-side continuation');
  }
  const events = await eventsForCompletedRun(engine, session.id, receipt.runId);
  assert.ok(events.every((event, index) => event.seq === index + 1));
  assert.equal(events.at(-1)?.seq, snapshot.lastSeq);
  assert.equal(events.filter((event) => event.type === 'message.completed').length, 2);
  const order = ['input.admitted', 'run.started', 'message.completed', 'tool.requested', 'tool.running', 'tool.completed', 'run.completed'];
  assert.ok(order.every((type, index) => index === 0 || events.findIndex((event) => event.type === type) > events.findIndex((event) => event.type === order[index - 1])));
  const publicTextEvents = events.filter((event) => event.type === 'message.delta');
  assert.ok(publicTextEvents.length > 0);
  assert.ok(!JSON.stringify(publicTextEvents).includes(String(REASONING.encrypted_content)), 'opaque replay is never a text delta');
  assert.ok(!JSON.stringify(publicTextEvents).includes('Fixture-only summary'));
  assert.equal(events.filter((event) => event.type.startsWith('run.') && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)).length, 1);

  await engine.close();
  engine = createEngine(options());
  const restored = await command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  assert.deepEqual(restored.messages, snapshot.messages, 'SQLite persists native replay including ciphertext, phases, IDs and original arguments');
  assert.equal(restored.lastSeq, snapshot.lastSeq);
  const duplicate = await submit(engine, session.id, 'native-read-request');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, receipt.runId);
  assert.equal(duplicate.admittedSeq, receipt.admittedSeq);
  assert.equal(requests.length, 2, 'reopening and redelivering a completed request causes no external HTTP execution');
  const followup = await submit(engine, session.id, 'native-followup-request', FOLLOWUP);
  const followupRun = await engine.waitForRun(followup.runId);
  assert.equal(followupRun.state, 'completed', JSON.stringify(followupRun.error));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2]?.input, [...originalInput, ...FIRST_ITEMS, toolOutput, ANSWER_ITEM, { role: 'user', content: FOLLOWUP }], 'buildContext carries stored native history through a new Run after reopening');
  const followupSnapshot = await command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  assert.equal(followupSnapshot.tools.length, 1, 'the completed read call is historical and is never re-executed');
  assert.deepEqual(followupSnapshot.messages.find((message) => message.runId === followup.runId && message.role === 'assistant')?.providerReplay, { providerId: PROVIDER_ID, items: [FOLLOWUP_ITEM], modelId: MODEL_ID, protocol: 'openai-responses', version: 1 });
});
