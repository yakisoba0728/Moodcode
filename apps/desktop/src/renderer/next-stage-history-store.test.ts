import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type CommandEnvelope, type CommandResult, type EngineCapabilities, type SessionHistoryPage, type SessionMetrics, type SessionSnapshot } from '@moodcode/contracts';
import type { DesktopApi, DesktopBootstrap, DesktopUpdate, HostStatus } from '../shared/protocol.js';
import { createDesktopStore } from './store.js';

const createdAt = '2026-10-04T00:00:00Z';
const config = { providerId: 'scripted', modelId: 'local', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
const workspace = { id: 'workspace', root: '/fixture', gitRoot: '/fixture', branch: 'main', createdAt };
const sessions = ['one', 'two'].map(id => ({ id, workspaceId: workspace.id, title: id, createdAt }));
const metrics = (inputTokens: number): SessionMetrics => ({ observedUsageEvents: 1, inputTokens, outputTokens: 0, usageWindowTruncated: false, context: { bytes: 100, limit: 8192, summaryIncluded: false, turnIndex: 0 } });

function snapshot(sessionId: string, runId: string, lastSeq = 10): SessionSnapshot {
  return { session: sessions.find(session => session.id === sessionId)!, runs: [{ id: runId, inputId: runId, requestId: runId, sessionId, workspaceId: workspace.id, prompt: 'fixture', config, state: 'completed', createdAt, updatedAt: createdAt }], messages: [], tools: [], approvals: [], lastSeq };
}
function page(sessionId: string, older = false, lastSeq = 10): SessionHistoryPage {
  const data = snapshot(sessionId, `${older ? 'older' : 'latest'}-${sessionId}-${lastSeq}`, lastSeq);
  return { snapshot: data, beforeRunId: data.runs[0]!.id, hasMore: !older, truncatedRecords: older };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext, withFeatures = true) {
  const calls: CommandEnvelope[] = [];
  const removed: string[] = [];
  const subscriptions: { id: string; sessionId: string; afterSeq: number }[] = [];
  let latestSeq = 10;
  let update: ((value: DesktopUpdate) => void) | undefined;
  let host: ((value: HostStatus) => void) | undefined;
  const capabilities: EngineCapabilities = { schemaVersion: 1, runtime: { node: 'fixture', electron: null, platform: 'fixture', commandExecution: 'posix-process-group' }, providerIds: ['scripted'], tools: [], modes: ['plan', 'build'], defaults: config, ...(withFeatures ? { features: { historyPaging: true, sessionMetrics: true } } : {}) };
  const bootstrap: DesktopBootstrap = { host: { state: 'ready', generation: 1 }, workspaces: [workspace], capabilities, version: 'fixture', platform: 'fixture', settings: { providerId: 'scripted', modelId: 'local', baseURL: '', keyConfigured: false, keySource: 'none', credentialStorage: 'unavailable' } };
  const defaultHandler = async (command: CommandEnvelope): Promise<unknown> => {
    const id = command.payload.sessionId as string;
    if (command.type === 'session.list') return sessions;
    if (command.type === 'session.getHistory') return page(id, command.payload.beforeRunId !== undefined, latestSeq);
    if (command.type === 'session.getSnapshot') return page(id, false, latestSeq).snapshot;
    if (command.type === 'session.getMetrics') return metrics(id === 'one' ? 1 : 2);
    if (command.type === 'review.getDiff') return { runId: command.payload.runId, files: [], checkpoints: [], warnings: [] };
    throw new Error(`Unexpected command ${command.type}`);
  };
  let handler = defaultHandler;
  const api: DesktopApi = {
    getBootstrap: async () => bootstrap,
    command: async command => { calls.push(structuredClone(command)); return { schemaVersion: 1, commandId: command.commandId, ok: true, result: JSON.parse(JSON.stringify(await handler(command))) } as CommandResult; },
    subscribe: async (sessionId, afterSeq) => { const id = `sub-${subscriptions.length}`; subscriptions.push({ id, sessionId, afterSeq }); return id; },
    unsubscribe: async id => { removed.push(id); },
    onUpdate: listener => { update = listener; return () => { update = undefined; }; },
    onHostState: listener => { host = listener; return () => { host = undefined; }; },
    chooseWorkspace: async () => null, saveSettings: async () => bootstrap.settings, retryEngine: async () => bootstrap.host, openExternal: async () => {},
  };
  const store = createDesktopStore(api, { workspaceId: workspace.id, sessionId: 'one' });
  t.after(() => store.stop());
  return { store, calls, subscriptions, removed, defaultHandler, setHandler(value: typeof handler) { handler = value; }, setSeq(value: number) { latestSeq = value; }, update(value: DesktopUpdate) { update?.(value); }, host(value: HostStatus) { host?.(value); } };
}

test('paged desktop history remains separate from the live snapshot/cursor and survives refresh until showing latest', async t => {
  const f = fixture(t);
  await f.store.initialize();
  await setImmediate();
  assert.ok(f.calls.some(call => call.type === 'session.getHistory'));
  assert.ok(!f.calls.some(call => call.type === 'session.getSnapshot'));
  assert.equal(f.subscriptions[0]!.afterSeq, 10);
  assert.equal(f.store.getSnapshot().metrics!.inputTokens, 1);
  await f.store.loadOlder();
  const history = f.store.getSnapshot().historyPage!;
  assert.equal(history.runs[0]!.id, 'older-one-10');
  assert.equal(f.store.getSnapshot().snapshot!.runs[0]!.id, 'latest-one-10');
  assert.equal(f.store.getSnapshot().historyTruncated, true);
  f.setSeq(11);
  await f.store.refresh();
  assert.strictEqual(f.store.getSnapshot().historyPage, history);
  assert.equal(f.store.getSnapshot().historyCursor, 'older-one-10');
  assert.equal(f.store.getSnapshot().snapshot!.lastSeq, 11);
  f.store.showLatest();
  assert.equal(f.store.getSnapshot().historyPage, null);
  assert.equal(f.store.getSnapshot().historyCursor, 'latest-one-11');
  assert.equal(f.store.getSnapshot().historyHasMore, true);
  assert.equal(f.store.getSnapshot().historyTruncated, false);
});

test('late older history cannot replace a newly selected session and concurrent older requests are coalesced', async t => {
  const f = fixture(t);
  await f.store.initialize();
  const late = deferred<SessionHistoryPage>();
  f.setHandler(command => command.type === 'session.getHistory' && command.payload.beforeRunId ? late.promise : f.defaultHandler(command));
  const older = f.store.loadOlder();
  await setImmediate();
  await f.store.loadOlder();
  assert.equal(f.calls.filter(call => call.type === 'session.getHistory' && call.payload.beforeRunId).length, 1);
  assert.equal(f.store.getSnapshot().loadingHistory, true);
  await f.store.selectSession('two');
  late.resolve(page('one', true));
  await older;
  assert.equal(f.store.getSnapshot().sessionId, 'two');
  assert.equal(f.store.getSnapshot().snapshot!.session.id, 'two');
  assert.equal(f.store.getSnapshot().historyPage, null);
  assert.equal(f.store.getSnapshot().historyCursor, 'latest-two-10');
  assert.equal(f.store.getSnapshot().loadingHistory, false);
});

test('show latest invalidates a pending history failure without overwriting the current error or loading state', async t => {
  const f = fixture(t);
  await f.store.initialize();
  const late = deferred<SessionHistoryPage>();
  f.setHandler(command => command.type === 'session.getHistory' && command.payload.beforeRunId ? late.promise : f.defaultHandler(command));
  const older = f.store.loadOlder();
  await setImmediate();
  f.store.showLatest();
  late.reject(new Error('stale old-page failure'));
  await older;
  assert.equal(f.store.getSnapshot().historyPage, null);
  assert.equal(f.store.getSnapshot().loadingHistory, false);
  assert.equal(f.store.getSnapshot().error, null);
  assert.equal(f.store.getSnapshot().historyCursor, 'latest-one-10');
});

test('late metrics from another session and stopped history responses cannot mutate the selected store', async t => {
  const f = fixture(t);
  const oldMetrics = deferred<SessionMetrics>();
  f.setHandler(command => command.type === 'session.getMetrics' && command.payload.sessionId === 'one' ? oldMetrics.promise : f.defaultHandler(command));
  await f.store.initialize();
  await f.store.selectSession('two');
  await setImmediate();
  assert.equal(f.store.getSnapshot().metrics!.inputTokens, 2);
  oldMetrics.resolve(metrics(999));
  await setImmediate();
  assert.equal(f.store.getSnapshot().metrics!.inputTokens, 2);
  const late = deferred<SessionHistoryPage>();
  f.setHandler(command => command.type === 'session.getHistory' && command.payload.beforeRunId ? late.promise : f.defaultHandler(command));
  const older = f.store.loadOlder();
  await setImmediate();
  await f.store.stop();
  const stopped = f.store.getSnapshot();
  late.resolve(page('two', true));
  await older;
  assert.strictEqual(f.store.getSnapshot(), stopped);
});

test('older desktop API capabilities retain snapshot/subscription fallback and do not require the new metrics commands', async t => {
  const f = fixture(t, false);
  await f.store.initialize();
  assert.ok(f.calls.some(call => call.type === 'session.getSnapshot'));
  assert.ok(!f.calls.some(call => call.type === 'session.getHistory' || call.type === 'session.getMetrics'));
  assert.equal(f.store.getSnapshot().metrics, null);
  assert.equal(f.store.getSnapshot().historyHasMore, false);
  await f.store.loadOlder();
  assert.ok(!f.calls.some(call => call.type === 'session.getHistory'));
  assert.equal(f.subscriptions[0]!.afterSeq, 10);
});
