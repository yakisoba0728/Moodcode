import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
test('restart preserves durable cursor history and never treats a saved record as a live process', async t => {
  const root = await temporary(t), journal = new SqliteTerminalJournal(join(root, 'terminals.sqlite')), backend = fakeBackend();
  const service = new TerminalService({ backend, journal, resolveOwner: input => ({ ...input, root }) });
  const terminal = await service.create({ owner }); backend.outputs[0]!('saved output');
  const restarted = new TerminalService({ backend: fakeBackend(), journal, resolveOwner: input => ({ ...input, root }) });
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
