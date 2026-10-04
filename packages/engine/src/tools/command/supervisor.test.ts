import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { assertExecutionLockAvailable } from './execution-lock.js';
import { cleanupGroup, createCommandEnvironment, executeShell, groupExists, type ProcessOutcome, type ShellInput } from './process-control.js';

const posix = process.platform !== 'win32';
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const command = (code: string): string => `exec ${quote(process.execPath)} -e ${quote(code)}`;

function temporary(t: TestContext): { directory: string; cleanup(fn: () => void | Promise<void>): void } {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-supervisor-'));
  const callbacks: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const callback of callbacks.reverse()) await callback(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, cleanup: fn => callbacks.push(fn) };
}

interface Packet { type: string; pid?: number; warning?: string; outcome?: ProcessOutcome }

async function launchSupervisor(temp: ReturnType<typeof temporary>, input: ShellInput, extraEnv: NodeJS.ProcessEnv = {}): Promise<{
  child: ChildProcess; packets: Packet[]; lockPath: string; closed: Promise<void>; exited: Promise<void>; packet(type: string): Promise<Packet>;
}> {
  const source = import.meta.url.endsWith('.ts');
  const file = fileURLToPath(new URL(`./supervisor.${source ? 'ts' : 'js'}`, import.meta.url));
  const child = fork(file, [], {
    execArgv: source ? ['--import', 'tsx'] : [],
    env: { ...createCommandEnvironment(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const packets: Packet[] = [];
  let groupPid: number | undefined;
  child.on('message', message => {
    const value = message as Packet;
    packets.push(value);
    if (value.type === 'started') groupPid = value.pid;
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  const within = async (promise: Promise<void>, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  temp.cleanup(async () => {
    if (child.connected) child.disconnect();
    child.stdout?.destroy(); child.stderr?.destroy();
    if (!await within(exited, 4000)) {
      if (groupPid !== undefined && groupExists(groupPid)) await cleanupGroup(groupPid);
      child.kill('SIGKILL');
      await exited;
    }
  });
  const packet = (type: string): Promise<Packet> => {
    const existing = packets.find(value => value.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise<Packet>((resolve, reject) => {
      const timeout = setTimeout(() => settle(new Error(`Supervisor did not send ${type}`)), 10000);
      const settle = (error?: Error, value?: Packet): void => {
        clearTimeout(timeout);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve(value!);
      };
      const onMessage = (message: unknown): void => {
        const value = message as Packet;
        if (value.type === type) settle(undefined, value);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => settle(new Error(`Supervisor exited before ${type}: ${code ?? signal}`));
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  };
  const lockPath = join(temp.directory, 'effects.sqlite');
  child.send({ type: 'init', input, executionLockPath: lockPath });
  await packet('ready');
  return { child, packets, lockPath, closed, exited, packet };
}

test('command environments remove provider credentials, engine secrets, and forced Electron Node mode', () => {
  const source = {
    PATH: '/bin', HOME: '/home/test', MOODCODE_PROFILE: 'local', OPENAI_BASE_URL: 'http://fixture',
    MOODCODE_API_KEY: 'fake', OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake',
    GEMINI_API_KEY: 'fake', GOOGLE_API_KEY: 'fake', AZURE_OPENAI_API_KEY: 'fake',
    MOODCODE_PROVIDER_TOKEN: 'fake', MOODCODE_ENGINE_SECRET_KEY: 'fake',
    OPENAI_API_KEY_SECONDARY: 'fake', openai_api_key: 'fake', ELECTRON_RUN_AS_NODE: '1',
  };
  assert.deepEqual(createCommandEnvironment(source), {
    PATH: '/bin', HOME: '/home/test', MOODCODE_PROFILE: 'local', OPENAI_BASE_URL: 'http://fixture',
  });
  assert.equal(source.OPENAI_API_KEY, 'fake', 'the caller environment must remain unchanged');
});

test('normal shell exit waits for slow output delivery without inventing running descendants', { skip: !posix }, async () => {
  const warnings: string[] = [];
  let output = '';
  const outcome = await executeShell({ command: command("process.stdout.write('complete output')"), cwd: tmpdir(), timeoutMs: 2000 }, new AbortController().signal,
    async (_stream, bytes) => { await pause(150); output += bytes.toString(); }, () => {}, warning => warnings.push(warning));
  assert.equal(output, 'complete output');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.outputDiscarded, undefined);
  assert.deepEqual(warnings, []);
});

test('a permanently blocked output callback cannot deadlock process-group cancellation', { skip: !posix, timeout: 6000 }, async () => {
  const abort = new AbortController();
  let pid: number | undefined;
  let deliveries = 0;
  const warnings: string[] = [];
  const outcome = await executeShell({ command: command("process.on('SIGTERM', () => {}); process.stdout.write(Buffer.alloc(1048576)); setInterval(() => {}, 1000)"), cwd: tmpdir(), timeoutMs: 3000 }, abort.signal,
    () => { deliveries++; setTimeout(() => abort.abort(), 30); return new Promise<void>(() => {}); }, group => { pid = group; }, warning => warnings.push(warning));
  assert.equal(deliveries, 1, 'the paused pipe must have at most one pending output callback');
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.outputDiscarded, true);
  assert.ok(warnings.some(warning => warning.includes('Output capture is incomplete')));
  assert.ok(pid !== undefined);
  assert.equal(groupExists(pid), false);
});

test('a paused supervisor consumer applies backpressure and later receives every normal output byte', { skip: !posix, timeout: 15000 }, async t => {
  const temp = temporary(t);
  const progress = join(temp.directory, 'producer-finished');
  const bytesPerStream = 4 * 1024 * 1024;
  const script = `const { once } = require('node:events');
(async () => {
  const chunk = Buffer.alloc(65536, 120);
  for (let i = 0; i < 64; i++) {
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
  }
  require('node:fs').writeFileSync(${JSON.stringify(progress)}, 'done');
})();`;
  const supervisor = await launchSupervisor(temp, { command: command(script), cwd: temp.directory, timeoutMs: 10000 });
  supervisor.child.stdout?.pause();
  supervisor.child.stderr?.pause();
  supervisor.child.send({ type: 'start' });
  await supervisor.packet('started');
  await pause(300);
  assert.equal(existsSync(progress), false, 'unread parent pipes must stop the producer instead of growing supervisor queues');
  assert.equal(supervisor.packets.some(packet => packet.type === 'result'), false);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  supervisor.child.stdout?.on('data', (bytes: Buffer) => { stdoutBytes += bytes.byteLength; });
  supervisor.child.stderr?.on('data', (bytes: Buffer) => { stderrBytes += bytes.byteLength; });
  supervisor.child.stdout?.resume();
  supervisor.child.stderr?.resume();
  const result = await supervisor.packet('result');
  await supervisor.closed;
  assert.equal(result.outcome?.exitCode, 0);
  assert.equal(result.outcome?.cleanupConfirmed, true);
  assert.equal(result.outcome?.error, undefined);
  assert.equal(result.outcome?.outputDiscarded, undefined);
  assert.equal(stdoutBytes, bytesPerStream);
  assert.equal(stderrBytes, bytesPerStream);
  assert.equal(existsSync(progress), true);
  assert.equal(supervisor.packets.some(packet => packet.type === 'warning'), false);
  assertExecutionLockAvailable(supervisor.lockPath);
});

for (const action of ['stop', 'disconnect'] as const) {
  test(`paused supervisor pipes do not block ${action} cleanup or effect-lock release`, { skip: !posix, timeout: 12000 }, async t => {
    const temp = temporary(t);
    const script = `process.on('SIGTERM', () => {}); const {once} = require('node:events');
(async () => { const chunk=Buffer.alloc(65536); while (true) { if (!process.stdout.write(chunk)) await once(process.stdout,'drain'); if (!process.stderr.write(chunk)) await once(process.stderr,'drain'); } })();`;
    const supervisor = await launchSupervisor(temp, { command: command(script), cwd: temp.directory, timeoutMs: 10000 });
    supervisor.child.stdout?.pause();
    supervisor.child.stderr?.pause();
    supervisor.child.send({ type: 'start' });
    const started = await supervisor.packet('started');
    await pause(150);
    if (action === 'stop') {
      supervisor.child.send({ type: 'stop' });
      const result = await supervisor.packet('result');
      assert.equal(result.outcome?.cancelled, true);
      assert.equal(result.outcome?.cleanupConfirmed, true);
      assert.equal(result.outcome?.outputDiscarded, true);
      assert.ok(supervisor.packets.some(packet => packet.warning?.includes('Output capture is incomplete')));
    } else supervisor.child.disconnect();
    await supervisor.exited;
    supervisor.child.stdout?.destroy(); supervisor.child.stderr?.destroy();
    assert.ok(started.pid !== undefined);
    assert.equal(groupExists(started.pid), false);
    assertExecutionLockAvailable(supervisor.lockPath);
  });
}

test('actual supervisor shells receive a sanitized environment', { skip: !posix, timeout: 12000 }, async t => {
  const temp = temporary(t);
  const names = ['MOODCODE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'MOODCODE_ENGINE_SECRET', 'ELECTRON_RUN_AS_NODE'];
  const extraEnv = Object.fromEntries(names.map(name => [name, 'fake-secret']));
  extraEnv.MOODCODE_PROFILE = 'local-fixture';
  const script = `process.stdout.write(JSON.stringify({present:${JSON.stringify(names)}.filter(name => process.env[name] !== undefined), profile:process.env.MOODCODE_PROFILE}));`;
  const supervisor = await launchSupervisor(temp, { command: command(script), cwd: temp.directory, timeoutMs: 5000 }, extraEnv);
  let output = '';
  supervisor.child.stdout?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  supervisor.child.stderr?.resume();
  supervisor.child.send({ type: 'start' });
  const result = await supervisor.packet('result');
  await supervisor.closed;
  assert.equal(result.outcome?.exitCode, 0);
  assert.deepEqual(JSON.parse(output), { present: [], profile: 'local-fixture' });
});
