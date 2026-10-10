import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { readSseData, SseDataParser } from './sse.js';

const limits = { maxFrameBytes: 4096, maxResponseBytes: 65_536 };
function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}
async function collect(chunks: Uint8Array[]): Promise<string[]> {
  return collectStream(readSseData(body(chunks), new AbortController().signal, limits));
}
async function collectStream(stream: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
function code(expected: string) { return (error: unknown) => error instanceof EngineError && error.code === expected; }

test('SSE handles every byte boundary of UTF-8, BOM, CRLF, comments and multiple data lines', async () => {
  const bytes = new TextEncoder().encode('\uFEFF: keepalive\r\n\r\ndata: {"text":\r\ndata: "한글🌊"}\r\n\r\nevent: message\nid: unused\ndata:[DONE]\r\n\r\n');
  const expected = ['{"text":\n"한글🌊"}', '[DONE]'];
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    assert.deepEqual(await collect([bytes.subarray(0, boundary), bytes.subarray(boundary)]), expected, `boundary ${boundary}`);
  }
  assert.deepEqual(await collect([...bytes].map(byte => Uint8Array.of(byte))), expected);
});

test('SSE accepts LF or CR delimiters and discards frames without data', async () => {
  assert.deepEqual(await collect([new TextEncoder().encode('retry: 100\n\n: heartbeat\r\rdata: one\rdata: two\r\rdata\n\n')]), ['one\ntwo', '']);
});

test('SSE rejects invalid UTF-8 without exposing decoder details', async () => {
  await assert.rejects(collect([Uint8Array.of(100, 97, 116, 97, 58, 32, 0xff, 10, 10)]), code('PROVIDER_MALFORMED_STREAM'));
});

test('SSE EOF never dispatches an unfinished data frame', async () => {
  for (const text of ['data: [DONE]', 'data: [DONE]\n']) {
    await assert.rejects(collect([new TextEncoder().encode(text)]), code('PROVIDER_INCOMPLETE_STREAM'));
  }
});

test('SSE frame and total byte limits count fragmented data and ignored fields', async () => {
  const encoder = new TextEncoder();
  for (const text of ['data: large payload\n\n', ': large comment\n\n', 'unknown: large value\n\n']) {
    const bytes = encoder.encode(text);
    await assert.rejects(collectStream(readSseData(body([...bytes].map(byte => Uint8Array.of(byte))), new AbortController().signal, { maxFrameBytes: 8, maxResponseBytes: 128 })), code('PROVIDER_LIMIT_EXCEEDED'));
  }
  await assert.rejects(collectStream(readSseData(body([encoder.encode('data: 1\n\n'), encoder.encode('data: 2\n\n')]), new AbortController().signal, { maxFrameBytes: 16, maxResponseBytes: 17 })), code('PROVIDER_LIMIT_EXCEEDED'));
});

test('SSE counts both CRLF bytes before dispatch, including a split delimiter', async () => {
  const bytes = new TextEncoder().encode('data: x\r\n\r\n');
  assert.equal(bytes.length, 11);
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    const chunks = [bytes.subarray(0, boundary), bytes.subarray(boundary)];
    await assert.rejects(collectStream(readSseData(body(chunks), new AbortController().signal, { maxFrameBytes: 10, maxResponseBytes: 128 })), code('PROVIDER_LIMIT_EXCEEDED'));
    assert.deepEqual(await collectStream(readSseData(body(chunks), new AbortController().signal, { maxFrameBytes: 11, maxResponseBytes: 128 })), ['x']);
  }
});

test('SSE parser reports frame limits and malformed UTF-8 with the caller errors', () => {
  const errors = { frameLimit: () => new EngineError('CALLER_LIMIT', 'limit'), malformed: () => new EngineError('CALLER_MALFORMED', 'malformed') };
  assert.throws(() => [...new SseDataParser(8, errors).push(new TextEncoder().encode('data: large\n\n'))], code('CALLER_LIMIT'));
  assert.throws(() => [...new SseDataParser(64, errors).push(Uint8Array.of(100, 97, 116, 97, 58, 32, 0xff, 10, 10))], code('CALLER_MALFORMED'));
  const parser = new SseDataParser(64, errors);
  assert.deepEqual([...parser.push(new TextEncoder().encode('data: x\r\r'))], []);
  assert.equal(parser.end(), 'x');
  assert.equal(parser.partial, false);
});

test('SSE consumer return cancels the underlying reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); },
    cancel() { cancelled = true; },
  });
  const iterator = readSseData(stream, new AbortController().signal, limits);
  assert.equal((await iterator.next()).value, 'first');
  await iterator.return(undefined);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('SSE abort wakes a stalled read and suppresses the raw reason', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const iterator = readSseData(stream, controller.signal, limits);
  const result = assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'PROVIDER_CANCELLED');
    assert.doesNotMatch(error.message + error.stack + JSON.stringify(error), /PRIVATE_KEY/);
    return true;
  });
  controller.abort(new Error('PRIVATE_KEY'));
  await result;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
