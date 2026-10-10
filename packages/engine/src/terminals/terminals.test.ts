import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { TerminalService } from './service.js';
import { MemoryTerminalJournal, SqliteTerminalJournal } from './journal.js';
import { PosixPtyBackend } from './backend.js';
import { TERMINAL_LIMITS, type PtyBackend, type PtyOutcome, type PtyProcess, type TerminalOwner, type TerminalSnapshot } from './types.js';
const owner: TerminalOwner = { authority: 'user', workspaceId: 'workspace', sessionId: 'session' };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, description); await pause(); }
}
async function temporary(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-pty-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function fakeBackend(): PtyBackend & { outputs: ((data: string) => void)[]; cancels: number; writes: string[]; finish(index: number, outcome: PtyOutcome): void } {
  const outputs: ((data: string) => void)[] = [], completions: ((outcome: PtyOutcome) => void)[] = [], writes: string[] = [];
  return { outputs, writes, cancels: 0, finish(index, outcome) { completions[index]!(outcome); }, async capability() { return { available: true, platform: 'fixture', backend: 'posix-pty-supervisor', processTree: 'posix-group', isolation: 'host-user' }; }, async spawn(_input, output) {
    const index = outputs.length; outputs.push(output); let resolve!: (outcome: PtyOutcome) => void; const closed = new Promise<PtyOutcome>(done => { resolve = done; }); completions.push(resolve);
    return { pid: index + 1, closed, async write(data) { writes.push(data); }, async resize() {}, cancel: async () => { this.cancels++; const outcome = { exitCode: null, cancelled: true, timedOut: false, cleanupConfirmed: true }; resolve(outcome); return outcome; } };
  } };
}

test('terminal authority is owner-bound and model authority never reaches the PTY backend', async t => {
  const root = await temporary(t), backend = fakeBackend();
  const service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) }); t.after(() => service.close());
  await assert.rejects(service.create({ owner: { ...owner, authority: 'model' } as unknown as TerminalOwner }), code('TERMINAL_AUTHORITY'));
  const terminal = await service.create({ owner });
  const wrong = { ...owner, sessionId: 'other' };
  for (const operation of [() => service.get(terminal.id, wrong), () => service.replay(terminal.id, wrong), () => service.attach(terminal.id, wrong)]) assert.throws(operation, code('TERMINAL_OWNER_MISMATCH'));
  await assert.rejects(service.write(terminal.id, wrong, 'private input'), code('TERMINAL_OWNER_MISMATCH'));
  await assert.rejects(service.resize(terminal.id, wrong, 80, 24), code('TERMINAL_OWNER_MISMATCH'));
  await assert.rejects(service.cancel(terminal.id, wrong), code('TERMINAL_OWNER_MISMATCH'));
  assert.equal(backend.outputs.length, 1); assert.deepEqual(backend.writes, []);
});
test('cwd symlink escapes, malformed dimensions and oversized writes are rejected', async t => {
  const root = await temporary(t), outside = await temporary(t), backend = fakeBackend(); await symlink(outside, join(root, 'escape'));
  const service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) }); t.after(() => service.close());
  await assert.rejects(service.create({ owner, cwd: 'escape' }), code('TERMINAL_CWD_OUTSIDE_WORKSPACE'));
  await assert.rejects(service.create({ owner, cols: 0 }), code('INVALID_TERMINAL_INPUT'));
  const terminal = await service.create({ owner });
  await assert.rejects(service.write(terminal.id, owner, 'x'.repeat(TERMINAL_LIMITS.maxWriteBytes + 1)), code('INVALID_TERMINAL_INPUT'));
  assert.equal(backend.outputs.length, 1); assert.deepEqual(backend.writes, []);
});
test('bounded Unicode output replay reports cursor gaps and slow attachments detach without stopping the terminal', async t => {
  const root = await temporary(t), backend = fakeBackend();
  const service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) }); t.after(() => service.close());
  const terminal = await service.create({ owner }), stalled = service.attach(terminal.id, owner), iterator = stalled.events[Symbol.asyncIterator]();
  const content = '한글🙂'.repeat(40_000); backend.outputs[0]!(content);
  const replay = service.replay(terminal.id, owner, 0, TERMINAL_LIMITS.bufferBytes);
  assert.equal(replay.gap, true); assert.ok(replay.terminal.retainedBytes <= TERMINAL_LIMITS.bufferBytes); assert.equal(replay.terminal.observedBytes, Buffer.byteLength(content));
  assert.equal(replay.output.map(item => item.data).join('').includes('\ufffd'), false); assert.equal(replay.nextSeq, replay.terminal.outputSeq);
  await assert.rejects(iterator.next(), code('TERMINAL_ATTACH_BACKPRESSURE'));
  assert.equal(backend.cancels, 0); await service.write(terminal.id, owner, 'still running');
  const attachment = service.attach(terminal.id, owner, replay.nextSeq); const live = attachment.events[Symbol.asyncIterator](); const reading = live.next(); backend.outputs[0]!('next');
  const event = (await reading).value; assert.ok(event && event.type === 'output'); assert.equal(event.output.data, 'next'); attachment.detach(); assert.equal((await live.next()).done, true);
});
test('session terminal and attachment counts are enforced and detach releases capacity', async t => {
  const root = await temporary(t), backend = fakeBackend(); const service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) }); t.after(() => service.close());
  const terminals = await Promise.all(Array.from({ length: TERMINAL_LIMITS.maxTerminalsPerSession }, () => service.create({ owner })));
  await assert.rejects(service.create({ owner }), code('TERMINAL_COUNT_LIMIT'));
  const terminal = terminals[0]!, attachments = Array.from({ length: TERMINAL_LIMITS.maxAttachments }, () => service.attach(terminal.id, owner));
  assert.throws(() => service.attach(terminal.id, owner), code('TERMINAL_ATTACH_LIMIT')); attachments[0]!.detach(); service.attach(terminal.id, owner).detach();
  await service.cancel(terminal.id, owner); assert.equal(service.get(terminal.id, owner).state, 'cancelled'); await service.create({ owner });
});
function authoredJournalSnapshot(root: string, id = 'authored_history'): TerminalSnapshot {
  return {
    record: {
      version: 1, id, owner: { ...owner }, cwd: root, file: '/authored/history-only', args: [],
      cols: 80, rows: 24, state: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      outputSeq: 2, oldestSeq: 1, observedBytes: 11, retainedBytes: 11,
      cleanupConfirmed: true, exitCode: 0,
    },
    output: [{ seq: 1, data: '한글🙂', bytes: 10 }, { seq: 2, data: '\n', bytes: 1 }],
  };
}

test('terminal journal save, load and read preserve authored history across reopen at the existing row byte cap', async t => {
  const root = await temporary(t), filename = join(root, 'journal-roundtrip.sqlite'),
    expected = authoredJournalSnapshot(root), journal = new SqliteTerminalJournal(filename);
  try {
    journal.save(expected);
    assert.deepEqual(journal.load(), [expected]);
    assert.deepEqual(journal.read(expected.record.id), expected);
    assert.equal(journal.read('missing_history'), undefined);
    const input = structuredClone(expected);
    journal.save(input);
    input.output[0]!.data = 'caller mutation';
    assert.deepEqual(journal.read(expected.record.id), expected);
    const boundary = { ...authoredJournalSnapshot(root, 'boundary_history'), padding: '' };
    boundary.padding = 'x'.repeat(4_194_304 - Buffer.byteLength(JSON.stringify(boundary)));
    assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 4_194_304);
    journal.save(boundary);
    assert.deepEqual(journal.load(), [expected, boundary]);
  } finally { journal.close(); }
  const reopened = new SqliteTerminalJournal(filename);
  try {
    assert.deepEqual(reopened.read(expected.record.id), expected);
    assert.deepEqual(reopened.load().map(value => value.record.id), ['authored_history', 'boundary_history']);
    const observer = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(observer.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.match(String(observer.prepare("SELECT sql FROM sqlite_master WHERE name='terminals'").get()!.sql), /CHECK\(length\(payload\) <= 4194304\)/);
    } finally { observer.close(); }
  } finally { reopened.close(); }
});

test('terminal journal preflights every native UTF8 header before fetching or parsing legacy payloads', async t => {
  const root = process.env.MOODCODE_TERMINAL_JOURNAL_EVIDENCE_ROOT ?? await temporary(t),
    filename = join(root, 'journal-multibyte.sqlite'), journal = new SqliteTerminalJournal(filename),
    writer = new DatabaseSync(filename),
    oversized = { ...authoredJournalSnapshot(root, 'z_legacy'), padding: '🙂'.repeat(1_100_000) },
    payload = JSON.stringify(oversized);
  t.after(() => journal.close()); t.after(() => writer.close());
  writer.prepare('INSERT INTO terminals(id,payload) VALUES (?,?)').run('z_legacy', payload);
  const native = writer.prepare('SELECT length(payload) characters, length(CAST(payload AS BLOB)) bytes FROM terminals').get()!;
  assert.ok(Number(native.characters) <= 4_194_304, 'legacy SQL character CHECK accepts this row');
  assert.ok(Number(native.bytes) > 4_194_304, 'independent native UTF8 size exceeds the byte cap');
  assert.equal(Number(native.bytes), Buffer.byteLength(payload));
  assert.throws(() => journal.load(), code('TERMINAL_JOURNAL_LIMIT'));
  assert.throws(() => journal.read('z_legacy'), code('TERMINAL_JOURNAL_LIMIT'));
  writer.prepare('INSERT INTO terminals(id,payload) VALUES (?,?)').run('a_malformed', '{');
  assert.throws(() => journal.load(), code('TERMINAL_JOURNAL_LIMIT'), 'later oversized header must reject before earlier malformed JSON is parsed');
});

test('terminal journal keeps its record ceiling and checks count before invalid payloads', async t => {
  const root = await temporary(t), filename = join(root, 'journal-count.sqlite'),
    journal = new SqliteTerminalJournal(filename), writer = new DatabaseSync(filename);
  t.after(() => journal.close()); t.after(() => writer.close());
  assert.equal(TERMINAL_LIMITS.maxRecords, 128);
  const records = Array.from({ length: 128 }, (_, i) => authoredJournalSnapshot(root, `history_${String(i).padStart(3, '0')}`));
  for (const record of records) journal.save(record);
  assert.deepEqual(journal.load(), records);
  assert.throws(() => journal.save(authoredJournalSnapshot(root, 'history_overflow')), code('TERMINAL_RECORD_LIMIT'));
  journal.save(records[0]!);
  writer.prepare('INSERT INTO terminals(id,payload) VALUES (?,?)').run('a_malformed_overflow', '{');
  assert.throws(() => journal.load(), code('TERMINAL_RECORD_LIMIT'));
});

test('terminal journal malformed JSON, replay and diagnostics remain invalid observations', async t => {
  const root = await temporary(t), filename = join(root, 'journal-invalid.sqlite'),
    journal = new SqliteTerminalJournal(filename), writer = new DatabaseSync(filename),
    original = authoredJournalSnapshot(root);
  t.after(() => journal.close()); t.after(() => writer.close());
  for (const payload of [
    '{',
    JSON.stringify({ ...original, output: [{ seq: 1, data: '한글🙂', bytes: 9 }] }),
    JSON.stringify({ ...original, record: { ...original.record, diagnostics: { version: 1, authority: 'live-process-handle' } } }),
  ]) {
    writer.prepare('INSERT INTO terminals(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(original.record.id, payload);
    assert.throws(() => journal.load(), code('TERMINAL_JOURNAL_INVALID'));
    assert.throws(() => journal.read(original.record.id), code('TERMINAL_JOURNAL_INVALID'));
  }
});

for (const mutation of ['disappeared', 'changed-bytes'] as const)
  test(`terminal journal guarded native body read rejects a ${mutation} row`, async t => {
    const root = await temporary(t), journal = new SqliteTerminalJournal(join(root, `journal-${mutation}.sqlite`)),
      original = authoredJournalSnapshot(root), db = Reflect.get(journal, 'db') as DatabaseSync;
    t.after(() => journal.close());
    journal.save(original);
    const prepare = db.prepare.bind(db);
    let changed = false;
    t.mock.method(db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (/^SELECT payload FROM terminals/u.test(sql)) {
        const get = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
          if (!changed) {
            changed = true;
            if (mutation === 'disappeared') prepare('DELETE FROM terminals WHERE id=?').run(original.record.id);
            else prepare('UPDATE terminals SET payload=? WHERE id=?').run(JSON.stringify({ ...original, padding: 'actual native byte change' }), original.record.id);
          }
          return get(...args);
        });
      }
      return statement;
    });
    assert.throws(() => journal.load(), code('TERMINAL_JOURNAL_INVALID'));
    assert.equal(changed, true, 'actual SQLite mutation occurred between header selection and guarded body observation');
  });

test('restart preserves durable cursor history and never treats a saved record as a live process', async t => {
  const root = await temporary(t), journal = new SqliteTerminalJournal(join(root, 'terminals.sqlite')), backend = fakeBackend();
  const service = new TerminalService({ backend, journal, resolveOwner: input => ({ ...input, root }) });
  const terminal = await service.create({ owner }); backend.outputs[0]!('saved output');
  const restoredBackend = fakeBackend(), restarted = new TerminalService({ backend: restoredBackend, journal, resolveOwner: input => ({ ...input, root }) });
  assert.equal(restoredBackend.outputs.length, 0); assert.equal(restoredBackend.cancels, 0);
  const recovered = restarted.get(terminal.id, owner); assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.cleanupConfirmed, null); assert.equal(recovered.reason, 'engine_restarted'); assert.equal('pid' in recovered, false);
  assert.equal(restarted.replay(terminal.id, owner).output[0]?.data, 'saved output'); await assert.rejects(restarted.write(terminal.id, owner, 'must not replay'), code('TERMINAL_CLOSED'));
  await restarted.close(); await service.close(); journal.close();
  const reopened = new SqliteTerminalJournal(join(root, 'terminals.sqlite')); assert.equal(reopened.load()[0]?.output[0]?.data, 'saved output'); reopened.close();
});
test('unconfirmed cleanup remains uncertain and close is idempotent', async t => {
  const root = await temporary(t), backend = fakeBackend(), service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) });
  const terminal = await service.create({ owner }); backend.finish(0, { exitCode: null, cancelled: true, timedOut: false, cleanupConfirmed: false, reason: 'fixture uncertainty' }); await pause();
  assert.equal(service.get(terminal.id, owner).state, 'uncertain'); assert.equal(service.get(terminal.id, owner).cleanupConfirmed, false);
  const a = service.close(), b = service.close(); assert.equal(a, b); await a; await assert.rejects(service.create({ owner }), code('ENGINE_CLOSED'));
});

test('close joins a PTY creation that already dispatched and cancels its late owned handle', async t => {
  const root = await temporary(t), backend = fakeBackend(), originalSpawn = backend.spawn.bind(backend);
  let started!: () => void, release!: () => void;
  const dispatch = new Promise<void>(resolve => { started = resolve; }), admission = new Promise<void>(resolve => { release = resolve; });
  backend.spawn = async (input, output) => { started(); await admission; return originalSpawn(input, output); };
  const service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }) });
  const creation = service.create({ owner }); await dispatch;
  let closed = false; const closing = service.close().then(() => { closed = true; }); await pause(); assert.equal(closed, false);
  release(); await assert.rejects(creation, code('ABORTED')); await closing; assert.equal(backend.cancels, 1); assert.equal(service.list(owner)[0]!.cleanupConfirmed, true);
});
test('a failed running persist still settles the spawned handle through its actual outcome', async t => {
  const root = await temporary(t), backend = fakeBackend(), journal = new MemoryTerminalJournal(), save = journal.save.bind(journal), broken = new Error('fixture journal failure');
  let saves = 0;
  journal.save = snapshot => { if (++saves === 2) throw broken; save(snapshot); };
  const service = new TerminalService({ backend, journal, resolveOwner: input => ({ ...input, root }) }); t.after(() => service.close());
  await assert.rejects(service.create({ owner }), error => error === broken); await pause();
  const record = service.list(owner)[0]!;
  assert.equal(backend.cancels, 1); assert.equal(record.state, 'failed'); assert.equal(record.cleanupConfirmed, true);
  assert.deepEqual(journal.read(record.id)!.record, record);
  await assert.rejects(service.resize(record.id, owner, 100, 40), code('TERMINAL_CLOSED'));
});

const posix = { skip: !['darwin', 'linux', 'freebsd'].includes(process.platform) };
test('real PTY has a tty, accepts input, resizes and yields bounded replay after normal exit', posix, async t => {
  const root = await temporary(t), service = new TerminalService({ resolveOwner: input => ({ ...input, root }), maxDurationMs: 10_000 }); t.after(() => service.close());
  assert.equal((await service.capability()).available, true);
  const terminal = await service.create({ owner, file: '/bin/sh', args: ['-c', 'test -t 0 || exit 9; printf "TTY_READY\\n"; read first; stty size; read second; printf "REPLY:%s:%s\\n" "$first" "$second"'], cols: 80, rows: 24 });
  await until(() => service.replay(terminal.id, owner).output.map(item => item.data).join('').includes('TTY_READY'), 'real PTY readiness');
  await service.resize(terminal.id, owner, 100, 40); await service.write(terminal.id, owner, 'one\rtwo\r');
  await until(() => service.get(terminal.id, owner).state !== 'running', 'real PTY completed');
  const replay = service.replay(terminal.id, owner), text = replay.output.map(item => item.data).join('');
  assert.match(text, /40 100/); assert.match(text, /REPLY:one:two/); assert.equal(replay.terminal.state, 'completed'); assert.equal(replay.terminal.cleanupConfirmed, true);
});
test('real PTY cancel and service close remove the inherited process group after readiness', posix, async t => {
  const root = await temporary(t), backend = new PosixPtyBackend(), service = new TerminalService({ backend, resolveOwner: input => ({ ...input, root }), maxDurationMs: 15_000 }); t.after(() => service.close());
  for (const closing of [false, true]) {
    const terminal = await service.create({ owner, file: '/bin/sh', args: ['-c', 'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait'] });
    let pids: number[] = [];
    await until(() => { const text = service.replay(terminal.id, owner).output.map(item => item.data).join(''), match = /PIDS:(\d+):(\d+)/.exec(text); if (match) pids = [Number(match[1]), Number(match[2])]; return pids.length > 0; }, 'PTY child tree readiness');
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
    if (closing) await service.close(); else await service.cancel(terminal.id, owner);
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }), 'PTY process tree removal');
    assert.equal(service.get(terminal.id, owner).cleanupConfirmed, true);
  }
});
test('supervisor IPC disconnect cleans a real PTY even when the parent cannot finalize its journal', posix, async t => {
  const root = await temporary(t), source = import.meta.url.endsWith('.ts');
  const child = fork(fileURLToPath(new URL(`./supervisor.${source ? 'ts' : 'js'}`, import.meta.url)), [], { execArgv: source ? ['--import', 'tsx'] : [], stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.connected) child.disconnect(); await exited; });
  let groupPid = 0, output = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.on('message', message => { const packet = message as { type?: string; pid?: number }; if (packet.type === 'ready') child.send({ type: 'start', input: { file: '/bin/sh', args: ['-c', 'printf "READY\\n"; sleep 60'], cwd: root, cols: 80, rows: 24, maxDurationMs: 20_000 } }); if (packet.type === 'started') groupPid = packet.pid!; });
  await until(() => groupPid > 0 && output.includes('READY'), 'supervisor parent-loss readiness'); child.disconnect(); await exited;
  await until(() => { try { process.kill(-groupPid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, 'group absent after parent disconnect');
});

test('actual SIGKILL of the engine parent leaves its detached PTY supervisor responsible for group cleanup', posix, async t => {
  const root = await temporary(t), source = import.meta.url.endsWith('.ts');
  const parent = fork(fileURLToPath(new URL(`./fixtures/parent.${source ? 'ts' : 'js'}`, import.meta.url)), [], { execArgv: source ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<void>(resolve => parent.once('exit', () => resolve())); let output = '', pids: number[] = [];
  parent.on('message', message => { const packet = message as { type?: string; data?: string }; if (packet.type === 'output') output += packet.data; });
  parent.send({ cwd: root });
  t.after(async () => { parent.kill('SIGKILL'); await exited; });
  await until(() => { const match = /PIDS:(\d+):(\d+)/.exec(output); if (match) pids = [Number(match[1]), Number(match[2])]; return pids.length > 0; }, 'crash fixture actual shell child readiness');
  for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0)); parent.kill('SIGKILL'); await exited;
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }), 'parent SIGKILL still removes owned PTY child tree');
});

test('macOS interactive shell relays hangup to its separate background job process group', { skip: process.platform !== 'darwin' }, async t => {
  const root = await temporary(t), service = new TerminalService({ resolveOwner: input => ({ ...input, root }), maxDurationMs: 15_000 }); t.after(() => service.close());
  const terminal = await service.create({ owner, file: '/bin/zsh', args: ['-f', '-i', '-c', 'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait'] });
  let pids: number[] = [];
  await until(() => { const match = /PIDS:(\d+):(\d+)/.exec(service.replay(terminal.id, owner).output.map(item => item.data).join('')); if (match) pids = [Number(match[1]), Number(match[2])]; return pids.length > 0; }, 'interactive job readiness');
  const groups = execFileSync('/bin/ps', ['-o', 'pid=,pgid=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  assert.equal(groups.length, 2); assert.notEqual(groups[0]![1], groups[1]![1]);
  await service.cancel(terminal.id, owner);
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }), 'interactive background job removed');
  assert.equal(service.get(terminal.id, owner).cleanupConfirmed, true);
});
test('normal exit of a job-control shell cleans the surviving job group in its PTY session', { skip: !['linux', 'freebsd'].includes(process.platform) }, async t => {
  const root = await temporary(t), service = new TerminalService({ resolveOwner: input => ({ ...input, root }), maxDurationMs: 15_000 }); t.after(() => service.close());
  const terminal = await service.create({ owner, file: '/bin/sh', args: ['-c', 'set -m; sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; read answer'] });
  let pids: number[] = [];
  await until(() => { const match = /PIDS:(\d+):(\d+)/.exec(service.replay(terminal.id, owner).output.map(item => item.data).join('')); if (match) pids = [Number(match[1]), Number(match[2])]; return pids.length > 0; }, 'job-control shell readiness');
  const groups = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n').map(Number);
  assert.equal(groups.length, 2); assert.notEqual(groups[0], groups[1]);
  await service.write(terminal.id, owner, 'done\r');
  await until(() => service.get(terminal.id, owner).state !== 'running', 'job-control shell exit settles');
  let survived = true;
  try { process.kill(pids[1]!, 0); } catch (error) { survived = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (survived) process.kill(-pids[1]!, 'SIGKILL');
  const record = service.get(terminal.id, owner);
  assert.equal(survived, false); assert.equal(record.state, 'completed'); assert.equal(record.cleanupConfirmed, true); assert.equal(record.reason, 'descendants');
});
