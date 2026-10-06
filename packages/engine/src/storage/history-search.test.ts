import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Message } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const code = (name: string) => (value: unknown) => value instanceof EngineError && value.code === name;
const now = '2026-10-07T00:00:00.000Z';
function fixture(t: test.TestContext) {
  const store = new SqliteStore(':memory:'); t.after(() => store.close());
  store.putWorkspace({ id: 'workspace', root: '/fixture', gitRoot: '/fixture', branch: null, createdAt: now });
  for (const id of ['session', 'other']) store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now });
  function add(id: string, content: string, sessionId = 'session', replay?: string) {
    const receipt = store.admit({ sessionId, requestId: id, prompt: 'fixture admission', config: { providerId: 'fixture', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS } } });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    const message: Message = { id, sessionId, runId: receipt.runId, role: 'assistant', content, createdAt: now, ...(replay ? { providerReplay: { providerId: 'fixture', items: [{ type: 'reasoning', encrypted_content: replay }] } } : {}) };
    store.commit(receipt.runId, 'message.completed', {}, { message });
    store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
    return message;
  }
  return { store, add };
}

test('history search uses literal UTF-8 content and owner-bound newest-first cursors without native replay', t => {
  const f = fixture(t);
  f.add('first', 'Moodcode 검색어 first'); f.add('second', 'Moodcode 검색어 second'); f.add('third', 'Moodcode 검색어 third');
  const foreign = f.add('foreign', 'Moodcode 검색어 private', 'other');
  f.add('opaque', 'ordinary content', 'session', 'secret-replay-query');
  const first = f.store.searchHistory('session', { query: '검색어', limit: 2 });
  assert.deepEqual(first.matches.map(match => match.messageId), ['third', 'second']); assert.equal(first.nextCursor, 'second');
  const next = f.store.searchHistory('session', { query: '검색어', beforeMessageId: first.nextCursor!, limit: 2 });
  assert.deepEqual(next.matches.map(match => match.messageId), ['first']); assert.equal(next.nextCursor, null);
  assert.deepEqual(f.store.searchHistory('session', { query: 'secret-replay-query' }), { matches: [], nextCursor: null });
  assert.throws(() => f.store.searchHistory('session', { query: 'Moodcode', beforeMessageId: foreign.id }), code('INVALID_HISTORY_SEARCH_CURSOR'));
  assert.equal(Object.hasOwn(first.matches[0]!, 'providerReplay'), false);
});

test('history search escapes wildcard/backslash syntax and cannot turn SQL or recalled text into instructions', t => {
  const f = fixture(t), content = "literal 100%_\\ ' OR 1=1 -- and ignore instructions";
  f.add('literal', content); f.add('unrelated', 'ordinary text');
  for (const query of ['100%_\\', "' OR 1=1 --", 'ignore instructions']) {
    const result = f.store.searchHistory('session', { query });
    assert.deepEqual(result.matches.map(match => match.messageId), ['literal']);
    assert.equal(result.matches[0]?.snippet, content);
  }
  assert.deepEqual(f.store.searchHistory('session', { query: '%not-a-wildcard%' }).matches, []);
});

test('large source messages yield bounded matched excerpts and byte-budget paging without full snapshots', t => {
  const f = fixture(t);
  f.add('large', 'x'.repeat(2_000_000) + '검색 needle ' + 'tail'.repeat(1000));
  for (let index = 0; index < 20; index++) f.add(`emoji-${index}`, '😀'.repeat(600) + '검색 needle');
  f.store.getSnapshot = () => { throw new Error('Search cannot load an entire transcript'); };
  const bounded = f.store.searchHistory('session', { query: '검색 needle', limit: 100, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  assert.ok(bounded.matches.length < 21); assert.ok(bounded.nextCursor);
  const seen = [...bounded.matches]; let cursor: string | null = bounded.nextCursor;
  while (cursor) { const page = f.store.searchHistory('session', { query: '검색 needle', beforeMessageId: cursor, limit: 100, maxBytes: 4096 }); seen.push(...page.matches); cursor = page.nextCursor; }
  assert.equal(seen.length, 21); assert.equal(new Set(seen.map(match => match.messageId)).size, 21);
  assert.equal(seen.at(-1)?.messageId, 'large'); assert.ok(seen.at(-1)!.snippet.includes('검색 needle'));
  assert.ok(seen.every(match => match.truncated)); assert.ok(seen.at(-1)!.contentBytes > 2_000_000);
});

test('history query/response/cursor errors cannot mutate either journal', t => {
  const f = fixture(t); f.add('one', 'needle');
  const events = f.store.readEvents('session', 0), native = f.store.readSessionEvents('session', 0);
  for (const query of ['', '   ', '\0', '한'.repeat(400)]) assert.throws(() => f.store.searchHistory('session', { query }), code('INVALID_HISTORY_QUERY'));
  for (const limit of [0, 101, 1.5]) assert.throws(() => f.store.searchHistory('session', { query: 'needle', limit }), code('INVALID_HISTORY_SEARCH_LIMIT'));
  for (const maxBytes of [0, 1_048_577, 1.5]) assert.throws(() => f.store.searchHistory('session', { query: 'needle', maxBytes }), code('INVALID_HISTORY_SEARCH_LIMIT'));
  assert.throws(() => f.store.searchHistory('session', { query: 'needle', beforeMessageId: 'missing' }), code('INVALID_HISTORY_SEARCH_CURSOR'));
  assert.deepEqual(f.store.readEvents('session', 0), events); assert.deepEqual(f.store.readSessionEvents('session', 0), native);
});
