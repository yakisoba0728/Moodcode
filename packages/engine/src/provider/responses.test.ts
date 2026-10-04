import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { ResponsesProvider, type ResponsesProviderOptions } from './responses.js';

const SECRET = 'sk-responses-fixture-private-1234567890';
const RESPONSE_ID = 'resp-local-fixture';
type Event = Record<string, unknown>;
type Handler = (incoming: IncomingMessage, outgoing: ServerResponse) => void | Promise<void>;

function request(): TurnRequest {
  return { runId: 'fixture-run', turnIndex: 0, modelId: 'explicit-fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], tools: [] };
}
function frame(event: Event): string { return `event: ${String(event.type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`; }
function wire(events: Event[]): string { return events.map(frame).join(''); }
function created(id = RESPONSE_ID): Event { return { type: 'response.created', response: { id, status: 'in_progress' } }; }
function progress(): Event { return { type: 'response.in_progress', response: { id: RESPONSE_ID, status: 'in_progress' } }; }
function added(item: Event, outputIndex = 0): Event { return { type: 'response.output_item.added', output_index: outputIndex, item }; }
function itemDone(item: Event, outputIndex = 0): Event { return { type: 'response.output_item.done', output_index: outputIndex, item }; }
function terminal(output: Event[], usage?: Event): Event {
  return { type: 'response.completed', response: { id: RESPONSE_ID, status: 'completed', output, ...(usage === undefined ? {} : { usage }) } };
}
function incomplete(output: Event[], reason: string = 'max_output_tokens'): Event {
  return { type: 'response.incomplete', response: { id: RESPONSE_ID, status: 'incomplete', output, incomplete_details: { reason } } };
}
function message(text: string, id = 'msg-fixture', kind: 'output_text' | 'refusal' = 'output_text', status = 'completed'): Event {
  return { id, type: 'message', status, role: 'assistant', content: [{ type: kind, ...(kind === 'output_text' ? { text } : { refusal: text }) }] };
}
function messageAdded(id = 'msg-fixture', outputIndex = 0): Event {
  return added({ id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }, outputIndex);
}
function textEvent(type: string, value: string, id = 'msg-fixture', outputIndex = 0, contentIndex = 0): Event {
  return { type, item_id: id, output_index: outputIndex, content_index: contentIndex, ...(type.endsWith('.delta') ? { delta: value } : type.includes('refusal') ? { refusal: value } : { text: value }) };
}
function part(type: 'added' | 'done', text: string, id = 'msg-fixture', outputIndex = 0, kind: 'output_text' | 'refusal' = 'output_text'): Event {
  return { type: `response.content_part.${type}`, item_id: id, output_index: outputIndex, content_index: 0, part: { type: kind, ...(kind === 'output_text' ? { text } : { refusal: text }) } };
}
function textItems(text: string, kind: 'output_text' | 'refusal' = 'output_text', id = 'msg-fixture', outputIndex = 0, doneOnly = false): Event[] {
  return [messageAdded(id, outputIndex), part('added', '', id, outputIndex, kind),
    ...(doneOnly ? [] : [textEvent(`response.${kind}.delta`, text, id, outputIndex)]),
    textEvent(`response.${kind}.done`, text, id, outputIndex), part('done', text, id, outputIndex, kind), itemDone(message(text, id, kind), outputIndex)];
}
function textStream(text = 'fixture answer', usage?: Event): Event[] {
  return [created(), progress(), ...textItems(text), terminal([message(text)], usage)];
}
function call(args = '{}', id = 'fc-fixture', callId = 'call-fixture', name = 'read_file', status = 'completed'): Event {
  return { id, type: 'function_call', status, call_id: callId, name, arguments: args };
}
function callAdded(id = 'fc-fixture', callId = 'call-fixture', name = 'read_file', outputIndex = 0, args = ''): Event {
  return added(call(args, id, callId, name, 'in_progress'), outputIndex);
}
function argsEvent(type: 'delta' | 'done', args: string, id = 'fc-fixture', outputIndex = 0): Event {
  return { type: `response.function_call_arguments.${type}`, item_id: id, output_index: outputIndex, ...(type === 'delta' ? { delta: args } : { arguments: args }) };
}
function callItems(args = '{}', id = 'fc-fixture', callId = 'call-fixture', name = 'read_file', outputIndex = 0, doneOnly = false): Event[] {
  return [callAdded(id, callId, name, outputIndex), ...(doneOnly ? [] : [argsEvent('delta', args, id, outputIndex)]), argsEvent('done', args, id, outputIndex), itemDone(call(args, id, callId, name), outputIndex)];
}
function callStream(args = '{}'): Event[] { return [created(), progress(), ...callItems(args), terminal([call(args)])]; }
function sse(outgoing: ServerResponse): void { outgoing.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); }
async function fixture(t: TestContext, handler: Handler): Promise<{ baseURL: string; requestCount: () => number }> {
  let count = 0;
  const errors: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    count += 1;
    void Promise.resolve().then(() => handler(incoming, outgoing)).catch(error => { errors.push(error); outgoing.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, [], 'Local HTTP fixture failed.');
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requestCount: () => count };
}
async function body(incoming: IncomingMessage): Promise<Event> {
  const parts: Buffer[] = [];
  for await (const item of incoming) parts.push(Buffer.from(item));
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as Event;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolved => { resolve = resolved; });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local fixture timed out.')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function noSecret(value: unknown): void {
  const rendered = value instanceof Error ? `${value.name}\n${value.message}\n${value.stack}\n${JSON.stringify(value)}\n${String(value.cause)}` : JSON.stringify(value);
  assert.ok(!rendered.includes(SECRET), 'Public provider output reflected the injected credential.');
}
function text(events: ProviderEvent[]): string { return events.filter(event => event.type === 'text.delta').map(event => event.delta).join(''); }
function visible(events: ProviderEvent[]): ProviderEvent[] {
  return events.map(event => event.type === 'finish' ? { type: 'finish', reason: event.reason } : event);
}
function jsonItems(items: Event[]): JsonObject[] { return JSON.parse(JSON.stringify(items)) as JsonObject[]; }
async function collect(provider: ResponsesProvider, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamTurn(input, signal)) events.push(event);
  for (const event of events) if (event.type === 'finish') {
    if (event.reason === 'length') assert.equal(event.replayItems, undefined, 'Incomplete output must not be replayed.');
    else assert.ok(Array.isArray(event.replayItems), 'Completed native output must include replay items.');
  }
  return events;
}
async function failure(provider: ResponsesProvider, code: string, input = request(), signal = new AbortController().signal): Promise<{ error: EngineError; events: ProviderEvent[] }> {
  const events: ProviderEvent[] = [];
  let found: EngineError | undefined;
  await assert.rejects(async () => { for await (const event of provider.streamTurn(input, signal)) events.push(event); }, error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, code); assert.equal(error.cause, undefined); noSecret(error); found = error; return true;
  });
  assert.ok(found); noSecret(events);
  assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish'), 'Invalid streams must not expose executable calls or finish.');
  return { error: found, events };
}

test('stateless POST maps stored messages to flat Responses input and function tools', async t => {
  const received: Event[] = [];
  const local = await fixture(t, async (incoming, outgoing) => {
    received.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization, accept: incoming.headers.accept, body: await body(incoming) });
    sse(outgoing); outgoing.end(wire(textStream('result', { input_tokens: 7, output_tokens: 3, total_tokens: 10, output_tokens_details: { reasoning_tokens: 2 } })));
  });
  const input = request();
  input.messages = [{ role: 'system', content: 'system instruction' }, { role: 'user', content: 'user instruction' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'old-call', name: 'read_file', input: { path: 'file.txt' } }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'empty-call', name: 'read_file', input: { path: 'empty.txt' } }] },
    { role: 'tool', content: 'old result', toolCallId: 'old-call' }];
  input.tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const provider = new ResponsesProvider({ baseURL: `${local.baseURL}/`, apiKey: SECRET, id: 'fixture-responses' });
  const events = await collect(provider, input);
  await collect(provider, input);
  assert.equal(provider.id, 'fixture-responses');
  assert.deepEqual(received[0], { method: 'POST', url: '/v1/responses', authorization: `Bearer ${SECRET}`, accept: 'text/event-stream', body: {
    model: 'explicit-fixture-model', input: [{ role: 'system', content: 'system instruction' }, { role: 'user', content: 'user instruction' },
      { role: 'assistant', content: 'checking' }, { type: 'function_call', call_id: 'old-call', name: 'read_file', arguments: '{"path":"file.txt"}' },
      { type: 'function_call', call_id: 'empty-call', name: 'read_file', arguments: '{"path":"empty.txt"}' }, { type: 'function_call_output', call_id: 'old-call', output: 'old result' }],
    stream: true, store: false, include: ['reasoning.encrypted_content'], tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: input.tools[0]!.inputSchema, strict: false }],
  } });
  assert.deepEqual(received[1], received[0], 'Provider response identifiers must not create implicit history.');
  assert.equal(text(events), 'result');
  assert.deepEqual(visible(events).slice(-2), [{ type: 'usage', inputTokens: 7, outputTokens: 3 }, { type: 'finish', reason: 'stop' }]);
});

test('injected fetch defaults to native endpoint and omits authorization and empty tools', async () => {
  let endpoint: string | undefined;
  let init: RequestInit | undefined;
  const transport: typeof fetch = async (url, options) => { endpoint = String(url); init = options; return new Response(wire(textStream()), { headers: { 'Content-Type': 'text/event-stream' } }); };
  const provider = new ResponsesProvider({ fetch: transport });
  assert.equal(provider.id, 'openai-responses');
  await collect(provider);
  assert.equal(endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(new Headers(init?.headers).get('authorization'), null);
  assert.equal(init?.redirect, 'error');
  assert.equal(JSON.parse(String(init?.body)).tools, undefined);
});

test('native completed lifecycle needs no Chat Completions DONE marker', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), terminal([])])); });
  assert.deepEqual(await collect(new ResponsesProvider({ baseURL: local.baseURL })), [{ type: 'finish', reason: 'stop', replayItems: [] }]);
});

test('UTF-8, BOM, CRLF, comments and multiline data survive single-byte boundaries', async t => {
  const local = await fixture(t, async (_incoming, outgoing) => {
    sse(outgoing);
    const events = textStream('안녕 🌊 café');
    const json = JSON.stringify(events[0]);
    const split = json.indexOf('"response"');
    const bytes = Buffer.from(`\uFEFF: keepalive\r\n\r\nevent: response.created\r\ndata: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n${wire(events.slice(1))}`);
    for (let i = 0; i < bytes.length; i++) { outgoing.write(bytes.subarray(i, i + 1)); if (i % 16 === 0) await nextTick(); }
    outgoing.end();
  });
  assert.equal(text(await collect(new ResponsesProvider({ baseURL: local.baseURL }))), '안녕 🌊 café');
});

test('text.done and arguments.done can supply complete values without deltas', async t => {
  const args = '{"path":"done-only.txt"}';
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing); outgoing.end(wire([created(), ...textItems('done only', 'output_text', 'msg-fixture', 0, true), ...callItems(args, 'fc-fixture', 'call-fixture', 'read_file', 1, true), terminal([message('done only'), call(args)])]));
  });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL }));
  assert.equal(text(events), 'done only');
  assert.deepEqual(events.find(event => event.type === 'tool.call'), { type: 'tool.call', call: { id: 'call-fixture', name: 'read_file', input: { path: 'done-only.txt' } } });
  assert.deepEqual(visible(events).at(-1), { type: 'finish', reason: 'tool_calls' });
});

test('interleaved calls require arguments done, item done and completed response before exposure', async t => {
  const argsObserved = deferred(), itemsObserved = deferred(), sendItems = deferred(), sendComplete = deferred();
  t.after(() => { sendItems.resolve(); sendComplete.resolve(); });
  const a = '{"path":"a.txt"}', b = '{"path":"b.txt"}';
  const local = await fixture(t, async (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.write(wire([created(), callAdded('fc-b', 'call-b', 'read_file', 1), callAdded('fc-a', 'call-a', 'read_file', 0),
      argsEvent('delta', '{"path":', 'fc-a', 0), argsEvent('delta', b, 'fc-b', 1), argsEvent('delta', '"a.txt"}', 'fc-a', 0), argsEvent('done', b, 'fc-b', 1), argsEvent('done', a, 'fc-a', 0),
      messageAdded('msg-gate', 2), textEvent('response.output_text.delta', 'args ready.', 'msg-gate', 2)]));
    await sendItems.promise;
    outgoing.write(wire([itemDone(call(a, 'fc-a', 'call-a'), 0), itemDone(call(b, 'fc-b', 'call-b'), 1), textEvent('response.output_text.delta', ' items ready.', 'msg-gate', 2)]));
    await sendComplete.promise;
    outgoing.end(wire([textEvent('response.output_text.done', 'args ready. items ready.', 'msg-gate', 2), itemDone(message('args ready. items ready.', 'msg-gate'), 2),
      terminal([call(a, 'fc-a', 'call-a'), call(b, 'fc-b', 'call-b'), message('args ready. items ready.', 'msg-gate')], { output_tokens: 4 })]));
  });
  const events: ProviderEvent[] = [];
  const consuming = (async () => {
    for await (const event of new ResponsesProvider({ baseURL: local.baseURL }).streamTurn(request(), new AbortController().signal)) {
      events.push(event);
      if (event.type === 'text.delta' && event.delta === 'args ready.') argsObserved.resolve();
      if (event.type === 'text.delta' && event.delta === ' items ready.') itemsObserved.resolve();
    }
  })();
  await deadline(argsObserved.promise); assert.deepEqual(events, [{ type: 'text.delta', delta: 'args ready.' }]);
  sendItems.resolve(); await deadline(itemsObserved.promise); assert.deepEqual(events, [{ type: 'text.delta', delta: 'args ready.' }, { type: 'text.delta', delta: ' items ready.' }]);
  sendComplete.resolve(); await deadline(consuming);
  assert.deepEqual(visible(events), [{ type: 'text.delta', delta: 'args ready.' }, { type: 'text.delta', delta: ' items ready.' }, { type: 'tool.call', call: { id: 'call-a', name: 'read_file', input: { path: 'a.txt' } } },
    { type: 'tool.call', call: { id: 'call-b', name: 'read_file', input: { path: 'b.txt' } } }, { type: 'usage', outputTokens: 4 }, { type: 'finish', reason: 'tool_calls' }]);
});

test('reasoning summary, encrypted content and reasoning_text parts stay opaque', async t => {
  const reasoning = { id: 'reason-fixture', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: SECRET }], encrypted_content: 'opaque-ciphertext-fixture' };
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing); outgoing.end(wire([created(), added({ ...reasoning, status: 'in_progress', summary: [] }),
      { type: 'response.reasoning_summary_part.added', item_id: 'reason-fixture', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'reason-fixture', output_index: 0, summary_index: 0, delta: SECRET },
      { type: 'response.reasoning_summary_text.done', item_id: 'reason-fixture', output_index: 0, summary_index: 0, text: SECRET },
      { type: 'response.reasoning_summary_part.done', item_id: 'reason-fixture', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: SECRET } },
      { type: 'response.content_part.added', item_id: 'reason-fixture', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } },
      { type: 'response.reasoning_text.delta', item_id: 'reason-fixture', output_index: 0, content_index: 0, delta: SECRET },
      { type: 'response.reasoning_text.done', item_id: 'reason-fixture', output_index: 0, content_index: 0, text: SECRET },
      { type: 'response.content_part.done', item_id: 'reason-fixture', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: SECRET } },
      itemDone(reasoning), ...textItems('public answer', 'output_text', 'msg-fixture', 1), terminal([reasoning, message('public answer')])]));
  });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }));
  noSecret(events); assert.equal(text(events), 'public answer'); assert.deepEqual(visible(events).at(-1), { type: 'finish', reason: 'stop' });
});

test('refusal deltas normalize to text and final snapshot is verified', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), ...textItems('cannot help', 'refusal'), terminal([message('cannot help', 'msg-fixture', 'refusal')])])); });
  assert.equal(text(await collect(new ResponsesProvider({ baseURL: local.baseURL }))), 'cannot help');
});

test('split credential text and complete call identifiers, names, keys and values are redacted', async t => {
  const args = JSON.stringify({ nested: [SECRET, 'safe'], [`key-${SECRET}`]: `value-${SECRET}` });
  const completeText = `before ${SECRET} after ${SECRET}`;
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing); outgoing.end(wire([created(), messageAdded(), textEvent('response.output_text.delta', `before ${SECRET.slice(0, 9)}`),
      textEvent('response.output_text.delta', `${SECRET.slice(9)} after ${SECRET}`), textEvent('response.output_text.done', completeText), itemDone(message(completeText)),
      ...callItems(args, 'fc-fixture', `call-${SECRET}`, `function-${SECRET}`, 1), terminal([message(completeText), call(args, 'fc-fixture', `call-${SECRET}`, `function-${SECRET}`)])]));
  });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }));
  noSecret(events); assert.equal(text(events), 'before [REDACTED] after [REDACTED]');
  assert.deepEqual(events.find(event => event.type === 'tool.call'), { type: 'tool.call', call: { id: 'call-[REDACTED]', name: 'function-[REDACTED]', input: { nested: ['[REDACTED]', 'safe'], 'key-[REDACTED]': 'value-[REDACTED]' } } });
});

test('text-only max_output_tokens incomplete lifecycle normalizes to length', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), messageAdded(), textEvent('response.output_text.delta', 'partial'), incomplete([message('partial', 'msg-fixture', 'output_text', 'incomplete')])])); });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL }));
  assert.equal(text(events), 'partial'); assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
});

test('incomplete message item done before max_output_tokens terminal normalizes to length', async t => {
  const partial = message('partial', 'msg-fixture', 'output_text', 'incomplete');
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), messageAdded(), textEvent('response.output_text.delta', 'partial'), itemDone(partial), incomplete([partial])])); });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL }));
  assert.equal(text(events), 'partial'); assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
});

const invalid: { name: string; events?: Event[]; raw?: string | Buffer; code?: string }[] = [
  { name: 'JSON malformed', raw: 'data: {invalid}\r\n\r\n' },
  { name: 'nonobject event', raw: 'data: []\r\n\r\n' },
  { name: 'missing event type', events: [{}] },
  { name: 'created missing', events: [messageAdded(), terminal([])] },
  { name: 'created repeated', events: [created(), created()] },
  { name: 'created incorrect status', events: [{ type: 'response.created', response: { id: RESPONSE_ID, status: 'completed' } }] },
  { name: 'progress repeated', events: [created(), progress(), progress()] },
  { name: 'progress conflicting response id', events: [created(), { type: 'response.in_progress', response: { id: 'other', status: 'in_progress' } }] },
  { name: 'event conflicting response id', events: [created(), { ...messageAdded(), response_id: 'other' }] },
  { name: 'created conflicting response id', events: [{ ...created(), response_id: 'other' }] },
  { name: 'terminal conflicting response id', events: [created(), { type: 'response.completed', response: { id: 'other', status: 'completed', output: [] } }] },
  { name: 'terminal missing', events: [created(), ...callItems()], code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'EOF midframe', raw: wire([created()]) + 'data: {"type":', code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'Chat Completions DONE without native terminal', raw: wire([created(), ...callItems()]) + 'data: [DONE]\r\n\r\n', code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'output item repeated index', events: [created(), callAdded(), callAdded('fc-other', 'call-other')] },
  { name: 'output item repeated id', events: [created(), callAdded(), callAdded('fc-fixture', 'call-other', 'read_file', 1)] },
  { name: 'duplicate call identifiers', events: [created(), callAdded(), callAdded('fc-other', 'call-fixture', 'read_file', 1)] },
  { name: 'argument wrong item id', events: [created(), callAdded(), argsEvent('done', '{}', 'other')] },
  { name: 'argument wrong index', events: [created(), callAdded(), argsEvent('done', '{}', 'fc-fixture', 1)] },
  { name: 'argument conflicting call id', events: [created(), callAdded(), { ...argsEvent('done', '{}'), call_id: 'other' }] },
  { name: 'argument conflicting name', events: [created(), callAdded(), { ...argsEvent('done', '{}'), name: 'other' }] },
  { name: 'argument done missing', events: [created(), callAdded(), argsEvent('delta', '{}'), itemDone(call()), terminal([call()])] },
  { name: 'argument done repeated', events: [created(), callAdded(), argsEvent('done', '{}'), argsEvent('done', '{}')] },
  { name: 'argument delta after done', events: [created(), callAdded(), argsEvent('done', '{}'), argsEvent('delta', 'late')] },
  { name: 'argument done conflicts with deltas', events: [created(), callAdded(), argsEvent('delta', '{}'), argsEvent('done', '{"late":true}')] },
  { name: 'argument malformed JSON', events: callStream('{"path":') },
  { name: 'second invalid call prevents first valid call exposure', events: [created(), ...callItems('{}', 'fc-a', 'call-a', 'read_file', 0), ...callItems('{"path":', 'fc-b', 'call-b', 'read_file', 1), terminal([call('{}', 'fc-a', 'call-a'), call('{"path":', 'fc-b', 'call-b')])] },
  { name: 'call item done missing', events: [created(), callAdded(), argsEvent('done', '{}'), terminal([call()])] },
  { name: 'item done repeated', events: [created(), ...callItems(), itemDone(call())] },
  { name: 'item done snapshot conflicting argument', events: [created(), callAdded(), argsEvent('done', '{}'), itemDone(call('{"other":true}'))] },
  { name: 'item done snapshot conflicting call id', events: [created(), callAdded(), argsEvent('done', '{}'), itemDone(call('{}', 'fc-fixture', 'other'))] },
  { name: 'terminal snapshot conflicts with completed call', events: [created(), ...callItems(), terminal([call('{"other":true}')])] },
  { name: 'terminal missing output item', events: [created(), ...callItems(), terminal([])] },
  { name: 'terminal output gap', events: [created(), ...callItems('{}', 'fc-fixture', 'call-fixture', 'read_file', 1), terminal([call()])] },
  { name: 'terminal incorrect status', events: [created(), { type: 'response.completed', response: { id: RESPONSE_ID, status: 'incomplete', output: [] } }] },
  { name: 'completed terminal with incomplete details', events: [created(), { type: 'response.completed', response: { id: RESPONSE_ID, status: 'completed', output: [], incomplete_details: { reason: 'max_output_tokens' } } }] },
  { name: 'incomplete item cannot become completed', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'partial'), itemDone(message('partial', 'msg-fixture', 'output_text', 'incomplete')), terminal([message('partial')])] },
  { name: 'text done missing before completed item', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'partial'), itemDone(message('partial')), terminal([message('partial')])] },
  { name: 'text done conflicts with delta', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'partial'), textEvent('response.output_text.done', 'different')] },
  { name: 'text after done', events: [created(), messageAdded(), textEvent('response.output_text.done', 'answer'), textEvent('response.output_text.delta', 'late')] },
  { name: 'text wrong item id', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'answer', 'other')] },
  { name: 'text on function call item', events: [created(), callAdded(), textEvent('response.output_text.delta', 'answer', 'fc-fixture')] },
  { name: 'text item done snapshot conflicts', events: [created(), ...textItems('answer').slice(0, -1), itemDone(message('other'))] },
  { name: 'text terminal snapshot conflicts', events: [created(), ...textItems('answer'), terminal([message('other')])] },
  { name: 'content part done before text done', events: [created(), messageAdded(), part('done', '')] },
  { name: 'content part added after delta', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'answer'), part('added', 'answer')] },
  { name: 'refusal conflicts with text part', events: [created(), messageAdded(), textEvent('response.output_text.delta', 'answer'), textEvent('response.refusal.done', 'refusal')] },
  { name: 'unsupported output item', events: [created(), added({ id: 'web-fixture', type: 'web_search_call' })], code: 'PROVIDER_UNSUPPORTED_OUTPUT' },
  { name: 'unsupported content part', events: [created(), messageAdded(), { type: 'response.content_part.added', item_id: 'msg-fixture', output_index: 0, content_index: 0, part: { type: 'audio' } }], code: 'PROVIDER_UNSUPPORTED_OUTPUT' },
  { name: 'unsupported event', events: [created(), { type: 'response.unknown', message: SECRET }], code: 'PROVIDER_UNSUPPORTED_EVENT' },
  { name: 'remote error event', events: [{ type: 'error', message: SECRET, code: SECRET }], code: 'PROVIDER_REMOTE_ERROR' },
  { name: 'remote failed response', events: [created(), { type: 'response.failed', response: { id: RESPONSE_ID, status: 'failed', error: { message: SECRET } } }], code: 'PROVIDER_REMOTE_ERROR' },
  { name: 'completed response with error', events: [created(), { type: 'response.completed', response: { id: RESPONSE_ID, status: 'completed', output: [], error: { message: SECRET } } }], code: 'PROVIDER_REMOTE_ERROR' },
  { name: 'content filter incomplete', events: [created(), incomplete([], 'content_filter')], code: 'PROVIDER_CONTENT_FILTERED' },
  { name: 'other incomplete reason', events: [created(), incomplete([], 'unexpected')], code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'incomplete tools never become executable', events: [created(), ...callItems(), incomplete([call()])], code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'negative usage', events: [created(), terminal([], { input_tokens: -1 })] },
  { name: 'invalid usage suppresses validated calls', events: [created(), ...callItems(), terminal([call()], { input_tokens: -1 })] },
  { name: 'fractional usage', events: [created(), terminal([], { output_tokens: 1.5 })] },
  { name: 'nonobject usage', events: [created(), { type: 'response.completed', response: { id: RESPONSE_ID, status: 'completed', output: [], usage: 'wrong' } }] },
  { name: 'negative output index', events: [created(), { ...callAdded(), output_index: -1 }] },
  { name: 'fractional content index', events: [created(), messageAdded(), { ...textEvent('response.output_text.done', 'answer'), content_index: 0.5 }] },
  { name: 'sequence repeats', events: [{ ...created(), sequence_number: 1 }, { ...progress(), sequence_number: 1 }] },
  { name: 'sequence decreases', events: [{ ...created(), sequence_number: 2 }, { ...progress(), sequence_number: 1 }] },
  { name: 'sequence fractional', events: [{ ...created(), sequence_number: 0.5 }] },
  { name: 'duplicate public call ids after redaction', events: [created(), ...callItems('{}', 'fc-a', `call-${SECRET}`, 'read_file', 0), ...callItems('{}', 'fc-b', 'call-[REDACTED]', 'read_file', 1), terminal([call('{}', 'fc-a', `call-${SECRET}`), call('{}', 'fc-b', 'call-[REDACTED]')])] },
  { name: 'duplicate public argument keys after redaction', events: callStream(JSON.stringify({ [`key-${SECRET}`]: 1, 'key-[REDACTED]': 2 })) },
  { name: 'reasoning delta must be a string', events: [created(), added({ id: 'rs-malformed', type: 'reasoning', status: 'in_progress', summary: [] }),
    { type: 'response.reasoning_text.delta', item_id: 'rs-malformed', output_index: 0, content_index: 0, delta: { private: SECRET } }] },
  { name: 'reasoning text done must be a string', events: [created(), added({ id: 'rs-malformed', type: 'reasoning', status: 'in_progress', summary: [] }),
    { type: 'response.reasoning_text.done', item_id: 'rs-malformed', output_index: 0, content_index: 0, text: 42 }] },
  { name: 'reasoning content index must be nonnegative', events: [created(), added({ id: 'rs-malformed', type: 'reasoning', status: 'in_progress', summary: [] }),
    { type: 'response.reasoning_text.delta', item_id: 'rs-malformed', output_index: 0, content_index: -1, delta: 'opaque' }] },
  { name: 'reasoning summary done must be a string', events: [created(), added({ id: 'rs-malformed', type: 'reasoning', status: 'in_progress', summary: [] }),
    { type: 'response.reasoning_summary_text.done', item_id: 'rs-malformed', output_index: 0, summary_index: 0, text: 42 }] },
];
for (const invalidCase of invalid) {
  test(`invalid native stream: ${invalidCase.name}`, async t => {
    const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(invalidCase.raw ?? wire(invalidCase.events ?? [])); });
    await failure(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }), invalidCase.code ?? 'PROVIDER_MALFORMED_STREAM');
  });
}

test('malformed UTF-8 fails rather than replacing bytes in completion text', async t => {
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing); outgoing.end(Buffer.concat([Buffer.from(wire([created(), messageAdded()]) + 'data: {"type":"response.output_text.delta","item_id":"msg-fixture","output_index":0,"content_index":0,"delta":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\r\n\r\n')]));
  });
  await failure(new ResponsesProvider({ baseURL: local.baseURL }), 'PROVIDER_MALFORMED_STREAM');
});

test('HTTP error exposes only safe numeric status, without body or status text', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.writeHead(429, SECRET, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ error: { message: SECRET } })); });
  const result = await failure(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_HTTP_ERROR');
  assert.deepEqual(result.error.details, { status: 429 });
});

test('JSON and bodyless successful responses are invalid SSE', async () => {
  for (const response of [new Response(JSON.stringify({ text: SECRET }), { headers: { 'Content-Type': 'application/json' } }), new Response(null, { headers: { 'Content-Type': 'text/event-stream' } })]) {
    const transport: typeof fetch = async () => response;
    await failure(new ResponsesProvider({ fetch: transport, apiKey: SECRET }), 'PROVIDER_MALFORMED_STREAM');
  }
});

test('pre-aborted turn does not reach HTTP or expose abort reason', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.end(); });
  const controller = new AbortController(); controller.abort(new Error(SECRET));
  await failure(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_CANCELLED', request(), controller.signal);
  assert.equal(local.requestCount(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation after a text delta closes response and removes listeners', async t => {
  const closed = deferred();
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.once('close', closed.resolve); sse(outgoing); outgoing.write(wire([created(), messageAdded(), textEvent('response.output_text.delta', 'first')])); });
  const controller = new AbortController();
  const iterator = new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }).streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await deadline(iterator.next()), { done: false, value: { type: 'text.delta', delta: 'first' } });
  controller.abort(new Error(SECRET));
  await assert.rejects(deadline(iterator.next()), error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_CANCELLED'); noSecret(error); return true; });
  await deadline(closed.promise); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation between completed calls suppresses remaining calls and finish', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), ...callItems('{}', 'fc-a', 'call-a', 'read_file', 0), ...callItems('{}', 'fc-b', 'call-b', 'read_file', 1), terminal([call('{}', 'fc-a', 'call-a'), call('{}', 'fc-b', 'call-b')])])); });
  const controller = new AbortController(); const events: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const event of new ResponsesProvider({ baseURL: local.baseURL }).streamTurn(request(), controller.signal)) { events.push(event); controller.abort(SECRET); } }, error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_CANCELLED'); noSecret(error); return true;
  });
  assert.deepEqual(events, [{ type: 'tool.call', call: { id: 'call-a', name: 'read_file', input: {} } }]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('timeout interrupts stalled SSE and closes response', async t => {
  const closed = deferred();
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.once('close', closed.resolve); sse(outgoing); outgoing.flushHeaders(); });
  const controller = new AbortController();
  await deadline(failure(new ResponsesProvider({ baseURL: local.baseURL, timeoutMs: 40 }), 'PROVIDER_TIMEOUT', request(), controller.signal));
  await deadline(closed.promise); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('consumer return closes unfinished stream and removes abort listeners', async t => {
  const closed = deferred();
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.once('close', closed.resolve); sse(outgoing); outgoing.write(wire([created(), messageAdded(), textEvent('response.output_text.delta', 'first')])); });
  const controller = new AbortController();
  const iterator = new ResponsesProvider({ baseURL: local.baseURL }).streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  assert.equal((await deadline(iterator.next())).done, false); assert.ok(iterator.return);
  await deadline(iterator.return(undefined)); await deadline(closed.promise); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

const limits: { name: string; options: ResponsesProviderOptions; events?: Event[]; raw?: string }[] = [
  { name: 'frame bytes with multibyte text', options: { maxFrameBytes: 256 }, events: textStream('🌊'.repeat(30)) },
  { name: 'aggregate response bytes including comments', options: { maxResponseBytes: 200 }, raw: ': ignored comment\r\n\r\n'.repeat(30) + wire([created(), terminal([])]) },
  { name: 'aggregate argument bytes', options: { maxToolArgumentBytes: 20 }, events: [created(), ...callItems('{"path":"a.txt"}', 'fc-a', 'call-a', 'read_file', 0), ...callItems('{"path":"b.txt"}', 'fc-b', 'call-b', 'read_file', 1)] },
  { name: 'argument done-only bytes', options: { maxToolArgumentBytes: 4 }, events: [created(), ...callItems('{"path":"done-only.txt"}', 'fc-fixture', 'call-fixture', 'read_file', 0, true)] },
  { name: 'initial argument bytes', options: { maxToolArgumentBytes: 4 }, events: [created(), callAdded('fc-fixture', 'call-fixture', 'read_file', 0, '{"path":"initial.txt"}')] },
  { name: 'call count', options: { maxToolCalls: 1 }, events: [created(), callAdded(), callAdded('fc-other', 'call-other', 'read_file', 1)] },
  { name: 'output item count', options: { maxOutputItems: 1 }, events: [created(), messageAdded(), callAdded('fc-fixture', 'call-fixture', 'read_file', 1)] },
  { name: 'content index bound', options: { maxOutputItems: 1 }, events: [created(), messageAdded(), textEvent('response.output_text.done', 'answer', 'msg-fixture', 0, 1)] },
  { name: 'argument nesting', options: {}, events: callStream('['.repeat(66) + '0' + ']'.repeat(66)) },
  { name: 'reasoning summary index bound', options: { maxOutputItems: 1 }, events: [created(), added({ id: 'rs-limited', type: 'reasoning', status: 'in_progress', summary: [] }),
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs-limited', output_index: 0, summary_index: 1, delta: 'opaque' }] },
];
for (const limit of limits) {
  test(`configured native limit: ${limit.name}`, async t => {
    const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(limit.raw ?? wire(limit.events ?? [])); });
    await failure(new ResponsesProvider({ baseURL: local.baseURL, ...limit.options }), 'PROVIDER_LIMIT_EXCEEDED');
  });
}

test('response byte limit accepts exact bound and rejects one byte less', async () => {
  const bytes = wire(textStream('🌊'));
  const fetcher: typeof fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } });
  const maxResponseBytes = Buffer.byteLength(bytes);
  assert.equal(text(await collect(new ResponsesProvider({ fetch: fetcher, maxResponseBytes }))), '🌊');
  await failure(new ResponsesProvider({ fetch: fetcher, maxResponseBytes: maxResponseBytes - 1 }), 'PROVIDER_LIMIT_EXCEEDED');
});

test('split UTF-16 argument deltas account joined Unicode bytes correctly', async t => {
  const args = '{"text":"🌊"}';
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing); outgoing.end(wire([created(), callAdded(), argsEvent('delta', '{"text":"\ud83c'), argsEvent('delta', '\udf0a"}'), argsEvent('done', args), itemDone(call(args)), terminal([call(args)])]));
  });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL, maxToolArgumentBytes: Buffer.byteLength(args) }));
  assert.deepEqual(events[0], { type: 'tool.call', call: { id: 'call-fixture', name: 'read_file', input: { text: '🌊' } } });
});

test('oversized and invalid requests fail before fetch', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('Unexpected fetch.'); };
  const long = request(); long.messages = [{ role: 'user', content: '🌊'.repeat(500) }];
  await failure(new ResponsesProvider({ fetch: transport, maxRequestBytes: 128 }), 'PROVIDER_LIMIT_EXCEEDED', long);
  for (const modelId of ['', '   ']) await failure(new ResponsesProvider({ fetch: transport }), 'PROVIDER_INVALID_REQUEST', { ...request(), modelId });
  await failure(new ResponsesProvider({ fetch: transport }), 'PROVIDER_INVALID_REQUEST', { ...request(), messages: [{ role: 'tool', content: 'missing id' }] });
  assert.equal(calls, 0);
});

test('fetch exception message, cause and private EngineError details are not reflected', async () => {
  const rejected: typeof fetch = async () => { throw new Error(SECRET, { cause: SECRET }); };
  await failure(new ResponsesProvider({ fetch: rejected, apiKey: SECRET }), 'PROVIDER_TRANSPORT_ERROR');
  const publicCode: typeof fetch = async () => { const error = new EngineError('PROVIDER_MALFORMED_STREAM', SECRET, { private: SECRET }); error.cause = new Error(SECRET); throw error; };
  assert.equal((await failure(new ResponsesProvider({ fetch: publicCode, apiKey: SECRET }), 'PROVIDER_MALFORMED_STREAM')).error.details, undefined);
});

test('body stream read errors preserve transport privacy and release reader', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(SECRET)); } });
  const transport: typeof fetch = async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  await failure(new ResponsesProvider({ fetch: transport, apiKey: SECRET }), 'PROVIDER_TRANSPORT_ERROR');
  assert.equal(body.locked, false);
});

test('invalid provider configuration remains private and fails immediately', () => {
  const options: ResponsesProviderOptions[] = [{ apiKey: '' }, { apiKey: `${SECRET}\n` }, { id: 'Invalid Provider' }, { id: SECRET, apiKey: SECRET },
    { baseURL: `https://${SECRET}@example.invalid/v1` }, { baseURL: `https://example.invalid/v1?key=${SECRET}` }, { baseURL: 'file:///private/api' },
    { baseURL: 'invalid-url' }, { maxFrameBytes: 0 }, { maxResponseBytes: -1 }, { maxOutputItems: 0.5 }, { maxToolCalls: Number.NaN }, { timeoutMs: 2_147_483_648 }];
  for (const option of options) assert.throws(() => new ResponsesProvider(option), error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_INVALID_CONFIG'); noSecret(error); return true; });
});

test('two HTTP turns replay native reasoning, commentary phase and call before tool output', async t => {
  const received: Event[] = [];
  const reasoning = { id: 'rs-two-turn', type: 'reasoning', status: 'completed', encrypted_content: 'opaque-two-turn-ciphertext', summary: [{ type: 'summary_text', text: 'checking the file' }] };
  const commentary = { ...message('I will check the file.', 'msg-commentary'), phase: 'commentary' };
  const tool = call('{"path":"file.txt"}', 'fc-two-turn', 'call-two-turn');
  const answer = { ...message('The file contains fixture data.', 'msg-answer'), phase: 'final_answer' };
  const local = await fixture(t, async (incoming, outgoing) => {
    received.push(await body(incoming));
    sse(outgoing);
    if (received.length === 1) outgoing.end(wire([created(), added({ ...reasoning, status: 'in_progress', summary: [] }), itemDone(reasoning),
      ...textItems('I will check the file.', 'output_text', 'msg-commentary', 1).map(event => event.type === 'response.output_item.done' ? { ...event, item: commentary }
        : event.type === 'response.output_item.added' ? { ...event, item: { ...(event.item as Event), phase: 'commentary' } } : event),
      ...callItems('{"path":"file.txt"}', 'fc-two-turn', 'call-two-turn', 'read_file', 2), terminal([reasoning, commentary, tool])]));
    else outgoing.end(wire([created('resp-second-turn'), { ...messageAdded('msg-answer'), item: { id: 'msg-answer', type: 'message', status: 'in_progress', role: 'assistant', content: [], phase: 'final_answer' }, response_id: 'resp-second-turn' },
      textEvent('response.output_text.done', 'The file contains fixture data.', 'msg-answer'), itemDone(answer),
      { type: 'response.completed', response: { id: 'resp-second-turn', status: 'completed', output: [answer], usage: { input_tokens: 20, output_tokens: 7 } } }]));
  });
  const provider = new ResponsesProvider({ baseURL: local.baseURL, id: 'native-two-turn' });
  const first = await collect(provider);
  const finish = first.find(event => event.type === 'finish');
  const emittedCall = first.find(event => event.type === 'tool.call');
  assert.ok(finish?.type === 'finish' && emittedCall?.type === 'tool.call');
  assert.deepEqual(finish.replayItems, [reasoning, commentary, tool]);
  const secondRequest = request(); secondRequest.turnIndex = 1;
  secondRequest.messages.push({ role: 'assistant', content: text(first), toolCalls: [emittedCall.call], providerReplay: { providerId: provider.id, items: finish.replayItems! } },
    { role: 'tool', content: 'fixture data', toolCallId: emittedCall.call.id });
  const second = await collect(provider, secondRequest);
  assert.deepEqual(received[1], { model: 'explicit-fixture-model', input: [{ role: 'user', content: 'fixture prompt' }, reasoning, commentary, tool,
    { type: 'function_call_output', call_id: 'call-two-turn', output: 'fixture data' }], stream: true, store: false, include: ['reasoning.encrypted_content'] });
  assert.equal(text(second), 'The file contains fixture data.');
  const secondFinish = second.find(event => event.type === 'finish'); assert.ok(secondFinish?.type === 'finish');
  assert.deepEqual(secondFinish.replayItems, [answer]);
  assert.deepEqual(visible(second).slice(-2), [{ type: 'usage', inputTokens: 20, outputTokens: 7 }, { type: 'finish', reason: 'stop' }]);
});

test('foreign-provider replay falls back to normalized assistant text and calls', async t => {
  let received: Event | undefined;
  const local = await fixture(t, async (incoming, outgoing) => { received = await body(incoming); sse(outgoing); outgoing.end(wire([created(), terminal([])])); });
  const input = request();
  input.messages = [{ role: 'assistant', content: 'fallback text', toolCalls: [{ id: 'fallback-call', name: 'read_file', input: { path: 'fallback.txt' } }],
    providerReplay: { providerId: 'other-provider', items: [{ type: 'unsupported', private: 'unused native payload' }] } }];
  await collect(new ResponsesProvider({ baseURL: local.baseURL }), input);
  assert.deepEqual(received?.input, [{ role: 'assistant', content: 'fallback text' }, { type: 'function_call', call_id: 'fallback-call', name: 'read_file', arguments: '{"path":"fallback.txt"}' }]);
});

test('same-provider replay text and call bindings reject conflicts before HTTP', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('Unexpected fetch.'); };
  const provider = new ResponsesProvider({ fetch: transport });
  const base = { role: 'assistant' as const, content: 'native text', toolCalls: [{ id: 'call-fixture', name: 'read_file', input: { path: 'file.txt' } }],
    providerReplay: { providerId: provider.id, items: jsonItems([message('native text'), call('{"path":"file.txt"}')]) } };
  for (const change of [{ content: 'conflicting text' }, { toolCalls: [] }, { toolCalls: [{ id: 'other-call', name: 'read_file', input: { path: 'file.txt' } }] },
    { toolCalls: [{ id: 'call-fixture', name: 'other_name', input: { path: 'file.txt' } }] }, { toolCalls: [{ id: 'call-fixture', name: 'read_file', input: { path: 'other.txt' } }] }]) {
    await failure(provider, 'PROVIDER_INVALID_REPLAY', { ...request(), messages: [{ ...base, ...change }] });
  }
  assert.equal(calls, 0);
});

test('ciphertext reflecting injected credential is rejected before calls and finish', async t => {
  const reasoning = { id: 'rs-private', type: 'reasoning', status: 'completed', summary: [], encrypted_content: `cipher-${SECRET}` };
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), added({ ...reasoning, status: 'in_progress' }), itemDone(reasoning),
    ...callItems('{}', 'fc-fixture', 'call-fixture', 'read_file', 1), terminal([reasoning, call()])])); });
  await failure(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_INVALID_REPLAY');
});

test('escaped credential argument strings are semantically redacted in native replay', async t => {
  const escaped = [...SECRET].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const args = `{"secret":"${escaped}","safe":"unchanged"}`;
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire(callStream(args))); });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }));
  noSecret(events);
  const emitted = events.find(event => event.type === 'tool.call'); assert.ok(emitted?.type === 'tool.call');
  assert.deepEqual(emitted.call.input, { secret: '[REDACTED]', safe: 'unchanged' });
  const finish = events.find(event => event.type === 'finish'); assert.ok(finish?.type === 'finish');
  const replayedCall = finish.replayItems?.find(item => item.type === 'function_call'); assert.ok(replayedCall);
  assert.deepEqual(JSON.parse(String(replayedCall.arguments)), { secret: '[REDACTED]', safe: 'unchanged' });
});

test('compact exponent numeric arguments remain valid native calls and replay', async t => {
  const args = '{"n":1e20}';
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire(callStream(args))); });
  const events = await collect(new ResponsesProvider({ baseURL: local.baseURL }));
  assert.deepEqual(events.find(event => event.type === 'tool.call'), { type: 'tool.call', call: { id: 'call-fixture', name: 'read_file', input: { n: 1e20 } } });
  const finish = events.find(event => event.type === 'finish'); assert.ok(finish?.type === 'finish');
  assert.equal(finish.replayItems?.[0]?.arguments, args, 'Valid numeric argument formatting is preserved.');
});

for (const acrossItems of [false, true]) {
  test(`credential spanning native text ${acrossItems ? 'items' : 'parts'} cannot enter executable replay`, async t => {
    const first = `before ${SECRET.slice(0, 11)}`, second = `${SECRET.slice(11)} after`;
    let textEvents: Event[], outputs: Event[];
    if (acrossItems) {
      textEvents = [...textItems(first, 'output_text', 'msg-first', 0), ...textItems(second, 'output_text', 'msg-second', 1)];
      outputs = [message(first, 'msg-first'), message(second, 'msg-second')];
    } else {
      const final = { id: 'msg-fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: first }, { type: 'output_text', text: second }] };
      textEvents = [messageAdded(), textEvent('response.output_text.delta', first), textEvent('response.output_text.done', first),
        textEvent('response.output_text.delta', second, 'msg-fixture', 0, 1), textEvent('response.output_text.done', second, 'msg-fixture', 0, 1), itemDone(final)];
      outputs = [final];
    }
    const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire([created(), ...textEvents,
      ...callItems('{}', 'fc-fixture', 'call-fixture', 'read_file', outputs.length), terminal([...outputs, call()])])); });
    const result = await failure(new ResponsesProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_INVALID_REPLAY');
    assert.equal(text(result.events), 'before [REDACTED] after');
  });
}
