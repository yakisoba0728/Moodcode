import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, release, arch } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, type Message, type Run, type SubmitInput } from '@moodcode/contracts';
import { SqliteStore } from '../index.js';

const timestamp = '2026-10-07T00:00:00.000Z';
const config = { providerId: 'fixture', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const groups = 50;
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
const gc = () => (globalThis as typeof globalThis & { gc?: () => void }).gc?.();

/** Synthetic storage benchmark only: direct bulk fixture rows avoid measuring provider/admission work. */
async function measure(messageCount: number) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-history-benchmark-'));
  const path = join(directory, 'engine.sqlite'), store = new SqliteStore(path);
  const database = new DatabaseSync(path);
  try {
    store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: timestamp });
    store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Synthetic history benchmark', createdAt: timestamp });
    database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const inputStatement = database.prepare('INSERT INTO inputs(id,session_id,request_id,fingerprint,admitted_seq,data) VALUES(?,?,?,?,?,?)');
    const runStatement = database.prepare('INSERT INTO runs(id,input_id,session_id,workspace_id,state,data) VALUES(?,?,?,?,?,?)');
    const messageStatement = database.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)');
    const eventStatement = database.prepare('INSERT INTO session_events(session_id,seq,event_id,schema_version,run_id,type,data) VALUES(?,?,?,?,?,?,?)');
    for (let index = 0; index < messageCount / groups; index++) {
      const id = `run-${index}`, inputId = `input-${index}`, requestId = `request-${index}`;
      const input: SubmitInput = { sessionId: 'session', requestId, prompt: 'benchmark fixture', config };
      inputStatement.run(inputId, 'session', requestId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), index + 1, JSON.stringify(input));
      const run: Run = { id, inputId, sessionId: 'session', workspaceId: 'workspace', requestId, prompt: input.prompt, config, state: 'completed', createdAt: timestamp, updatedAt: timestamp };
      runStatement.run(id, inputId, 'session', 'workspace', 'completed', JSON.stringify(run));
      for (let item = 0; item < groups; item++) {
        const ordinal = index * groups + item + 1;
        const message: Message = { id: `message-${ordinal}`, sessionId: 'session', runId: id, role: item % 2 ? 'assistant' : 'user', content: '한국어'.repeat(100) + 'x'.repeat(124), createdAt: timestamp };
        messageStatement.run(message.id, 'session', id, JSON.stringify(message));
        const event = { schemaVersion: 2, stream: 'session-v2', eventId: `event-${ordinal}`, sessionId: 'session', runId: id, seq: ordinal, timestamp, type: 'fixture.message', payload: { messageId: message.id } };
        eventStatement.run('session', ordinal, event.eventId, 2, id, event.type, JSON.stringify(event));
      }
    }
    database.prepare('INSERT INTO session_sequences(session_id,last_seq) VALUES(?,?)').run('session', messageCount);
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    for (let index = 0; index < 5; index++) store.readModelHistory('session');
    gc(); const heapBefore = process.memoryUsage().heapUsed;
    const latencies: number[] = []; let peakHeap = heapBefore, responseMessages = 0, responseBytes = 0;
    for (let index = 0; index < 30; index++) {
      const start = performance.now(), page = store.readModelHistory('session');
      latencies.push(performance.now() - start);
      responseMessages = page.snapshot.messages.length; responseBytes = Buffer.byteLength(JSON.stringify(page));
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    gc(); const retainedHeapDelta = process.memoryUsage().heapUsed - heapBefore;
    const signal = new AbortController(), subscriber = store.subscribeSessionEvents('session', 0, signal.signal)[Symbol.asyncIterator]();
    const subscriptionStart = performance.now(); let pulled = 0, subscriptionBytes = 0;
    for (; pulled < 100; pulled++) {
      const result = await subscriber.next();
      if (result.done) break;
      subscriptionBytes += Buffer.byteLength(JSON.stringify(result.value));
    }
    signal.abort(); await subscriber.return?.();
    const subscriptionMs = performance.now() - subscriptionStart;
    gc(); const pressureHeapBefore = process.memoryUsage().heapUsed;
    let pressurePeakHeap = pressureHeapBefore, produced = 0;
    const slowSignal = new AbortController(), slow = store.subscribeSessionEvents('session', 0, slowSignal.signal)[Symbol.asyncIterator]();
    const pressureStart = performance.now();
    const producer = (async () => {
      for (let batch = 0; batch < 64; batch++) {
        for (let item = 0; item < 4; item++) { store.setSessionPaused('session', produced % 2 === 0, 'user'); produced++; }
        pressurePeakHeap = Math.max(pressurePeakHeap, process.memoryUsage().heapUsed);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })();
    let slowPulled = 0;
    for (; slowPulled < 100; slowPulled++) {
      if ((await slow.next()).done) break;
      pressurePeakHeap = Math.max(pressurePeakHeap, process.memoryUsage().heapUsed);
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    await producer; slowSignal.abort(); await slow.return?.(); gc();
    const pressureRetainedHeap = process.memoryUsage().heapUsed - pressureHeapBefore;
    const plan = database.prepare('EXPLAIN QUERY PLAN SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(`run-${messageCount / groups - 1}`);
    return {
      messageCount, runCount: messageCount / groups, databaseBytes: statSync(path).size,
      history: { samples: latencies.length, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: Math.max(...latencies), responseMessages, responseBytes,
        candidateRunMetadataLimit: 129, candidateMessageMetadataUpperBound: Math.min(messageCount, 129 * groups),
        totalCountMetadataScans: messageCount, physicalIoBytes: null,
        peakHeapDeltaBytes: peakHeap - heapBefore, retainedHeapDeltaBytes: retainedHeapDelta },
      subscription: { persistedBacklog: messageCount, pulled, bytes: subscriptionBytes, elapsedMs: subscriptionMs, pageRecordsLimit: 100, pageBytesLimit: 8_388_608 },
      pressure: { slowConsumerDelayMs: 1, slowPulled, concurrentControlEventsProduced: produced, elapsedMs: performance.now() - pressureStart,
        peakHeapDeltaBytes: pressurePeakHeap - pressureHeapBefore, retainedHeapDeltaBytes: pressureRetainedHeap, pendingWaitersPerSubscriber: 1,
        totalBacklogAfter: messageCount + produced, producerType: 'local durable session-control event writes' },
      plan,
    };
  } finally { database.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

const measurements = [];
for (const count of [1_000, 10_000, 100_000]) measurements.push(await measure(count));
const report = { timestamp: new Date().toISOString(), node: process.version, platform: platform(), release: release(), arch: arch(), exposedGc: typeof (globalThis as typeof globalThis & { gc?: unknown }).gc === 'function',
  source: 'synthetic local SQLite fixtures, 50 messages per completed Run, UTF-8 ~1KiB message content, 30 warm samples',
  limitations: ['Physical filesystem I/O was not measured; selected JSON bytes and SQL metadata scan bounds are recorded separately.', 'The pressure probe uses a slow consumer and concurrent local session-control event producer; live provider/network backpressure and slow effect cleanup are outside this benchmark.', 'Peak heap includes transient allocations and is affected by GC; retained heap is sampled after explicit GC when available.', 'Model history still scans the session message index for omitted-message counts.'], measurements };
const output = JSON.stringify(report, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], output, { mode: 0o600 });
else process.stdout.write(output);
