import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type Checkpoint, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolResult } from '../../ports.js';
import { COMMAND_LIMITS, createCommandTool as originalCreateCommandTool } from './index.js';
import { acquireExecutionLock, assertExecutionLockAvailable } from './execution-lock.js';
import { registerCredentialEnvNames } from './process-control.js';
import { commandBackendCapability } from './backends.js';
import { directoryFixture } from './windows-native-test-helpers.fixture.js';

const posix = process.platform !== 'win32';
const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const fixtureExecutions = new WeakMap<AbortSignal, (execution: Promise<ToolResult>) => void>();
function createCommandTool() {
  const tool = originalCreateCommandTool();
  return {
    ...tool,
    execute(prepared: PreparedTool, context: ToolContext) {
      const execution = tool.execute(prepared, context);
      fixtureExecutions.get(context.signal)?.(execution);
      return execution;
    },
  };
}
const diagnosticText = (error: unknown): string => {
  try { return String(error).slice(0, 512); }
  catch { return 'Unprintable fixture failure'; }
};
function diagnostic(t: TestContext, message: string): void {
  try { t.diagnostic(message.slice(0, 512)); }
  catch { /* Reporting cannot replace the original failure. */ }
}
async function bounded<T>(operation: Promise<T>, milliseconds: number, detail: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error(detail)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

interface OutputData {
  text: string;
  totalBytes: number;
  capturedBytes: number;
  captureTruncatedBytes: number;
  modelBytes: number;
  modelSourceBytes: number;
  modelTruncatedBytes: number;
  artifactBytes: number;
  artifactTruncatedBytes: number;
}

interface CommandData {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
  cleanupConfirmed: boolean;
  started: boolean;
  stdout: OutputData;
  stderr: OutputData;
  warnings: string[];
}

async function fixture(t: TestContext, controller = new AbortController()) {
  const temporary = await mkdtemp(join(tmpdir(), 'moodcode-command-test-'));
  await mkdir(join(temporary, 'workspace'));
  const root = await realpath(join(temporary, 'workspace'));
  const checkpoints: Checkpoint[] = [];
  const executions = new Map<Promise<ToolResult>, Record<string, unknown>>();
  const children: { child: ChildProcess; closed: Promise<void>; exited: boolean; error?: unknown }[] = [];
  const context: ToolContext = {
    workspace: { id: 'workspace-command', root, gitRoot: root, branch: null, createdAt: '2026-10-04T00:00:00.000Z' },
    sessionId: 'session-command', runId: 'run-command', toolCallId: 'tool-command',
    signal: controller.signal,
    limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 5_000, maxOutputBytes: 4_096 },
    artifactDir: join(temporary, 'artifacts'),
    recordCheckpoint(checkpoint) { checkpoints.push(checkpoint); },
  };
  fixtureExecutions.set(controller.signal, execution => {
    const observation: Record<string, unknown> = { state: 'pending' };
    executions.set(execution, observation);
    void execution.then(result => {
      observation.state = 'fulfilled'; observation.result = result;
    }, error => {
      observation.state = 'rejected'; observation.error = diagnosticText(error);
    });
  });
  const ownChild = (child: ChildProcess): Promise<void> => {
    const original = { child, closed: Promise.resolve(), exited: false, error: undefined as unknown };
    original.closed = new Promise<void>(yes => child.once('close', () => { original.exited = true; yes(); }));
    child.on('error', error => { original.error = error; });
    children.push(original);
    return original.closed;
  };
  t.after(async () => {
    const reasons = new Set<string>(['native-cleanup-not-proven']);
    if (t.error) reasons.add('test-failed');
    if (t.passed !== true) reasons.add('test-outcome-unknown-or-failed');
    if (executions.size || children.length) reasons.add('native-effects-observed');
    let cleanupError: unknown, cleanupFailed = false;
    const save = async (phase: string) => {
      try {
        const raw = JSON.stringify({ schemaVersion: 1, phase, originalPath: temporary,
          context: { workspaceId: context.workspace.id, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId },
          checkpoints, executions: [...executions.values()],
          children: children.map(owner => ({ pidObservation: owner.child.pid, closedObserved: owner.exited,
            error: owner.error === undefined ? null : diagnosticText(owner.error) })),
          nativeCleanupConfirmed: null, retentionReasons: [...reasons] }, null, 2) + '\n';
        assert.ok(Buffer.byteLength(raw) <= 8_388_608, 'Fixture native DATA exceeds its byte ceiling');
        await writeFile(join(temporary, `${phase}.json`), raw, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        reasons.add('native-evidence-capture-failed');
        diagnostic(t, `Native fixture evidence failed: ${diagnosticText(error)}`);
      }
    }
    await save('before-fixture-close');
    controller.abort();
    for (const original of children) {
      try {
        if (!original.exited) original.child.kill('SIGKILL');
        await bounded(original.closed, 5_000, 'Original fixture ChildProcess close did not settle');
      } catch (error) {
        reasons.add('original-child-close-unknown');
        if (!cleanupFailed) cleanupError = error;
        cleanupFailed = true;
      }
    }
    try {
      await bounded(Promise.allSettled([...executions.keys()]), 8_000, 'Original fixture command executions did not settle after abort');
    } catch (error) {
      reasons.add('original-execution-close-unknown');
      if (!cleanupFailed) cleanupError = error;
      cleanupFailed = true;
    }
    await save('after-fixture-close');
    diagnostic(t, `Retained native command fixture: ${temporary}`);
    if (cleanupFailed) throw cleanupError;
  });
  return { temporary, root, context, controller, checkpoints, ownChild };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function dataOf(result: ToolResult): CommandData {
  assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
  return result.data as unknown as CommandData;
}

async function assertAbsent(path: string): Promise<void> {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function verifyOutput(data: OutputData): void {
  for (const [name, value] of Object.entries(data)) {
    if (name !== 'text') assert.ok(Number.isSafeInteger(value) && Number(value) >= 0, `${name} must be a nonnegative byte count`);
  }
  assert.equal(data.capturedBytes + data.captureTruncatedBytes, data.totalBytes);
  assert.equal(data.modelSourceBytes + data.modelTruncatedBytes, data.totalBytes);
  assert.equal(data.artifactBytes + data.artifactTruncatedBytes, data.totalBytes);
  assert.equal(Buffer.byteLength(data.text), data.modelBytes);
  assert.ok(data.modelSourceBytes <= data.capturedBytes);
}

async function running(pid: number): Promise<boolean> {
  // A reparented zombie has stopped executing; its new parent owns reaping it.
  try {
    const result = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]);
    return result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(`Condition was not reached within ${timeoutMs} ms`);
}

function processTreeCommand(root: string, ignoreTerm = false): string {
  const grandchild = `
    const fs = require('node:fs');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    fs.writeFileSync(${JSON.stringify(join(root, 'grandchild.pid'))}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  return nodeCommand(`
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    fs.writeFileSync(${JSON.stringify(join(root, 'command.pid'))}, String(process.pid));
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `);
}

async function observeTree(root: string): Promise<number[]> {
  const pids: number[] = [];
  for (const name of ['command.pid', 'grandchild.pid']) {
    const path = join(root, name);
    await waitUntil(async () => {
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        pids.push(pid);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    });
  }
  for (const pid of pids) assert.equal(await running(pid), true, `Fixture process ${pid} started`);
  return pids;
}

test('diagnostic PID copies cannot retarget fixture cleanup', { timeout: 15_000 }, async t => {
  const hooks: (() => void | Promise<void>)[] = [];
  const observations: string[] = [];
  const captured = {
    error: null, passed: undefined,
    after(hook: () => void | Promise<void>) { hooks.push(hook); },
    diagnostic(message: string) { observations.push(message); },
  } as unknown as TestContext;
  const f = await fixture(captured);
  const windowsDirectory = directoryFixture(captured);
  const spawnOriginal = () => {
    const child = spawn(process.execPath, ['-e', `
      process.on('message', packet => process.send({ nonce: packet.nonce, pid: process.pid }));
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let closedObserved = false;
    const closed = new Promise<void>(yes => child.once('close', () => { closedObserved = true; yes(); }));
    child.on('error', () => {});
    child.stderr?.on('data', bytes => observations.push(String(bytes).slice(0, 512)));
    return { child, closed, get closedObserved() { return closedObserved; } };
  };
  const cleanupOwned = spawnOriginal(), unrelated = spawnOriginal();
  const originalClosed = f.ownChild(cleanupOwned.child);
  let originalFailure: unknown, failed = false;
  const responses: { phase: string; nonce: number; pid: number }[] = [];
  let nonce = 0;
  const ping = async (child: ChildProcess, phase: string) => {
    const request = ++nonce;
    const response = await new Promise<{ nonce: number; pid: number }>((yes, no) => {
      const timer = setTimeout(() => finish(new Error('Original live child did not respond over IPC')), 3_000);
      const message = (value: unknown) => {
        const packet = value as { nonce: number; pid: number };
        if (packet.nonce === request) finish(undefined, packet);
      };
      const error = (failure: Error) => finish(failure);
      const closed = () => finish(new Error('Original child closed before its IPC response'));
      const finish = (failure?: Error, packet?: { nonce: number; pid: number }) => {
        clearTimeout(timer);
        child.off('message', message); child.off('error', error); child.off('close', closed);
        if (failure) no(failure); else yes(packet!);
      };
      child.on('message', message); child.once('error', error); child.once('close', closed);
      try { child.send({ nonce: request }, failure => { if (failure) finish(failure); }); }
      catch (failure) { finish(failure as Error); }
    });
    assert.equal(response.pid, child.pid, 'The exact Original ChildProcess must answer');
    responses.push({ phase, ...response });
  };
  try {
    await ping(cleanupOwned.child, 'cleanup-owned-before'); await ping(unrelated.child, 'unrelated-before');
    const diagnosticCopy = { pids: [cleanupOwned.child.pid!] };
    const publishCopies = async () => {
      for (const path of [
        ...['command', 'grandchild', 'remaining'].map(role => join(f.root, `${role}.pid`)),
        ...['root', 'branch', 'leaf'].map(role => join(windowsDirectory, `${role}.pid`)),
      ]) await writeFile(path, String(diagnosticCopy.pids[0]));
      await writeFile(join(windowsDirectory, 'ready.json'), JSON.stringify(diagnosticCopy));
    };
    await publishCopies();
    diagnosticCopy.pids[0] = unrelated.child.pid!;
    await publishCopies();
    assert.equal(hooks.length, 2);
    for (const hook of hooks) await hook();
    await bounded(originalClosed, 5_000, 'Cleanup-owned Original child was not joined');
    assert.equal(cleanupOwned.closedObserved, true);
    assert.equal(f.controller.signal.aborted, true);
    await ping(unrelated.child, 'unrelated-after-actual-hooks');
    assert.equal(unrelated.closedObserved, false);
    assert.equal(await readFile(join(windowsDirectory, 'root.pid'), 'utf8'), String(unrelated.child.pid));
    assert.equal(await readFile(join(f.root, 'command.pid'), 'utf8'), String(unrelated.child.pid));
    assert.ok(observations.every(value => Buffer.byteLength(value) <= 2048));
    t.diagnostic(`Retained copied-PID oracle originals: ${f.temporary}, ${windowsDirectory}`);
  } catch (error) {
    originalFailure = error; failed = true;
  } finally {
    const joined = await Promise.allSettled([cleanupOwned, unrelated].map(async original => {
      if (!original.closedObserved) original.child.kill('SIGKILL');
      await bounded(original.closed, 5_000, 'Regression Original ChildProcess close did not settle');
    }));
    for (const result of joined) {
      if (result.status !== 'rejected') continue;
      diagnostic(t, `Original regression child join failed: ${diagnosticText(result.reason)}`);
      if (!failed) { originalFailure = result.reason; failed = true; }
    }
    try {
      await writeFile(join(f.temporary, 'copied-pid-oracle-data.json'), JSON.stringify({
        schemaVersion: 1, responses, pidDataIsObservationOnly: true,
        originalHandleCloseObservations: [cleanupOwned, unrelated].map(original => ({
          pidObservation: original.child.pid, closedObserved: original.closedObserved,
          exitCode: original.child.exitCode, signalCode: original.child.signalCode,
        })), nativeCleanupConfirmed: null,
      }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      diagnostic(t, `Original oracle DATA capture failed: ${diagnosticText(error)}`);
      if (!failed) { originalFailure = error; failed = true; }
    }
  }
  if (failed) throw originalFailure;
});

test('prepare has no effects and fingerprints the exact command, cwd, timeout, and execution identity', { skip: !posix }, async t => {
  const { root, context, checkpoints } = await fixture(t);
  await mkdir(join(root, 'nested'));
  const marker = join(root, 'prepared-effect');
  const command = nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'effect')`);
  const tool = createCommandTool();
  const input = { command, cwd: '.', timeoutMs: 2_500 };
  const first = await tool.prepare(input, context);
  const same = await tool.prepare(input, context);
  assert.equal(first.name, 'run_command');
  assert.equal(first.requiresApproval, true);
  assert.equal(first.fingerprint, same.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.preview.command, command);
  assert.equal(first.preview.cwd, root);
  assert.equal(first.preview.timeoutMs, 2_500);
  assert.equal(first.preview.workspaceId, context.workspace.id);
  assert.equal(first.preview.runId, context.runId);
  assert.equal(first.preview.toolCallId, context.toolCallId);
  assert.equal(first.preview.termination, 'posix-process-group');
  for (const candidate of [
    await tool.prepare({ ...input, command: `${command} ` }, context),
    await tool.prepare({ ...input, cwd: 'nested' }, context),
    await tool.prepare({ ...input, timeoutMs: 2_499 }, context),
    await tool.prepare(input, { ...context, runId: 'other-run' }),
    await tool.prepare(input, { ...context, toolCallId: 'other-tool' }),
    await tool.prepare(input, { ...context, sessionId: 'other-session' }),
  ]) assert.notEqual(candidate.fingerprint, first.fingerprint);
  await assertAbsent(marker);
  await assertAbsent(context.artifactDir);
  assert.equal(checkpoints.length, 0);
});

test('prepare rejects external and symlink cwd, malformed input, and nonexistent directories', { skip: !posix }, async t => {
  const { root, temporary, context } = await fixture(t);
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
  await writeFile(join(root, 'regular.txt'), 'file');
  const tool = createCommandTool();
  for (const cwd of [outside, '../outside', 'escape']) {
    await assert.rejects(tool.prepare({ command: 'true', cwd }, context), { code: 'PATH_OUTSIDE_WORKSPACE' });
  }
  for (const cwd of ['missing', 'regular.txt']) await assert.rejects(tool.prepare({ command: 'true', cwd }, context));
  for (const input of [
    null, [], {}, { command: '' }, { command: '   ' }, { command: 'x\0y' },
    { command: 'x'.repeat(COMMAND_LIMITS.maxCommandBytes + 1) },
    { command: 'é'.repeat(COMMAND_LIMITS.maxCommandBytes / 2 + 1) },
    { command: 'true', timeoutMs: 0 }, { command: 'true', timeoutMs: 1.5 },
    { command: 'true', timeoutMs: COMMAND_LIMITS.maxTimeoutMs + 1 },
    { command: 'true', timeoutMs: '100' }, { command: 'true', cwd: '' },
    { command: 'true', unexpected: true },
  ]) await assert.rejects(tool.prepare(input, context), { code: 'INVALID_TOOL_INPUT' });
});

test('execute rejects altered preparation and identity before command effects', { skip: !posix }, async t => {
  const { root, context } = await fixture(t);
  const marker = join(root, 'tampered-effect');
  const tool = createCommandTool();
  const prepared = await tool.prepare({ command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'effect')`) }, context);
  const changes: PreparedTool[] = [
    { ...prepared, requiresApproval: false },
    { ...prepared, name: 'other-command' },
    { ...prepared, fingerprint: '0'.repeat(64) },
    { ...prepared, input: { ...(prepared.input as JsonObject), command: `${(prepared.input as JsonObject).command} ` } },
    { ...prepared, preview: { ...prepared.preview, timeoutMs: 1 } },
    { ...prepared, data: { ...(prepared.data as JsonObject), sessionId: 'other-session' } },
  ];
  for (const changed of changes) await assert.rejects(tool.execute(changed, context), { code: 'COMMAND_APPROVAL_MISMATCH' });
  await assert.rejects(tool.execute(prepared, { ...context, runId: 'other-run' }), { code: 'COMMAND_APPROVAL_MISMATCH' });
  await assertAbsent(marker);
  await assertAbsent(context.artifactDir);
});

test('execute rechecks an approved cwd after its directory is replaced by an external symlink', { skip: !posix }, async t => {
  const { root, temporary, context } = await fixture(t);
  const directory = join(root, 'approved');
  const outside = join(temporary, 'outside');
  await mkdir(directory);
  await mkdir(outside);
  const tool = createCommandTool();
  const prepared = await tool.prepare({ command: nodeCommand("require('node:fs').writeFileSync('marker', 'effect')"), cwd: 'approved' }, context);
  await rm(directory, { recursive: true });
  await symlink(outside, directory);
  await assert.rejects(tool.execute(prepared, context), { code: 'PATH_OUTSIDE_WORKSPACE' });
  await assertAbsent(join(outside, 'marker'));
  await assertAbsent(context.artifactDir);
});

test('commands capture stdout and stderr and checkpoint changes against existing user content', { skip: !posix }, async t => {
  const { root, context, checkpoints } = await fixture(t);
  const existing = 'existing user edits\n';
  await writeFile(join(root, 'edited.txt'), existing);
  await writeFile(join(root, 'unchanged.txt'), 'existing unchanged edits\n');
  await writeFile(join(root, 'deleted.txt'), 'delete me\n');
  const tool = createCommandTool();
  const prepared = await tool.prepare({ command: nodeCommand(`
    const fs = require('node:fs');
    process.stdout.write('hello stdout\\n');
    process.stderr.write('hello stderr\\n');
    fs.writeFileSync('edited.txt', 'command edits\\n');
    fs.writeFileSync('created.txt', 'new file\\n');
    fs.unlinkSync('deleted.txt');
  `) }, context);
  const result = await tool.execute(prepared, context);
  const data = dataOf(result);
  assert.equal(data.status, 'completed');
  assert.equal(data.exitCode, 0);
  assert.equal(data.signal, null);
  assert.equal(data.cancelled, false);
  assert.equal(data.timedOut, false);
  assert.equal(data.cleanupConfirmed, true);
  assert.equal(data.started, true);
  assert.notEqual(result.isError, true);
  assert.equal(data.stdout.text, 'hello stdout\n');
  assert.equal(data.stderr.text, 'hello stderr\n');
  verifyOutput(data.stdout);
  verifyOutput(data.stderr);
  assert.equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0]!;
  assert.equal(checkpoint.kind, 'command');
  assert.equal(checkpoint.runId, context.runId);
  assert.equal(checkpoint.toolCallId, context.toolCallId);
  assert.deepEqual(checkpoint.files.map(file => file.path), ['created.txt', 'deleted.txt', 'edited.txt']);
  assert.deepEqual(checkpoint.files.find(file => file.path === 'edited.txt'), {
    path: 'edited.txt', before: existing, after: 'command edits\n', beforeHash: hash(existing), afterHash: hash('command edits\n'),
  });
  assert.equal(checkpoint.files.find(file => file.path === 'created.txt')!.before, null);
  assert.equal(checkpoint.files.find(file => file.path === 'deleted.txt')!.after, null);
  assert.match(checkpoint.warnings.join('\n'), /concurrent external edits.*attributed/i);
  assert.equal(await readFile(join(root, 'unchanged.txt'), 'utf8'), 'existing unchanged edits\n');
  await assert.rejects(tool.execute(prepared, context), { code: 'COMMAND_ALREADY_EXECUTED' });
});

test('host-declared credential names reach neither the command supervisor nor its shell', { skip: !posix }, async t => {
  const { context } = await fixture(t);
  const names = ['COMMAND_TEST_HOST_CREDENTIAL', 'COMMAND_TEST_HOST_VISIBLE'] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  process.env.COMMAND_TEST_HOST_CREDENTIAL = 'host-credential-fixture';
  process.env.COMMAND_TEST_HOST_VISIBLE = 'visible-fixture';
  registerCredentialEnvNames(['COMMAND_TEST_HOST_CREDENTIAL']);
  const tool = createCommandTool();
  const result = await tool.execute(await tool.prepare({ command: nodeCommand(`process.stdout.write(JSON.stringify([${names.map(name => `process.env.${name} ?? null`).join(', ')}]))`) }, context), context);
  assert.equal(dataOf(result).stdout.text, JSON.stringify([null, 'visible-fixture']));
});

test('nonzero exit is an explicit failed command result', { skip: !posix }, async t => {
  const { context } = await fixture(t);
  const tool = createCommandTool();
  const result = await tool.execute(await tool.prepare({ command: nodeCommand("process.stderr.write('expected failure'); process.exitCode = 7") }, context), context);
  const data = dataOf(result);
  assert.equal(data.status, 'failed');
  assert.equal(data.exitCode, 7);
  assert.equal(data.cleanupConfirmed, true);
  assert.equal(data.stderr.text, 'expected failure');
  assert.equal(result.isError, true);
});

test('large output applies independent shared capture, model, and private artifact limits', { skip: !posix }, async t => {
  const { context } = await fixture(t);
  const bytesPerStream = COMMAND_LIMITS.artifactBytes + 65_537;
  const tool = createCommandTool();
  const result = await tool.execute(await tool.prepare({ command: nodeCommand(`
    const fs = require('node:fs');
    fs.writeSync(1, Buffer.alloc(${bytesPerStream}, 65));
    fs.writeSync(2, Buffer.alloc(${bytesPerStream}, 66));
  `) }, context), context);
  const data = dataOf(result);
  assert.equal(data.status, 'completed');
  assert.equal(data.stdout.totalBytes, bytesPerStream);
  assert.equal(data.stderr.totalBytes, bytesPerStream);
  verifyOutput(data.stdout);
  verifyOutput(data.stderr);
  assert.equal(data.stdout.capturedBytes + data.stderr.capturedBytes, COMMAND_LIMITS.captureBytes);
  assert.equal(data.stdout.artifactBytes + data.stderr.artifactBytes, COMMAND_LIMITS.artifactBytes);
  assert.ok(data.stdout.modelBytes + data.stderr.modelBytes < context.limits.maxOutputBytes);
  assert.ok(Buffer.byteLength(result.content) <= context.limits.maxOutputBytes);
  assert.ok(data.stdout.captureTruncatedBytes + data.stderr.captureTruncatedBytes > 0);
  assert.ok(data.stdout.modelTruncatedBytes + data.stderr.modelTruncatedBytes > 0);
  assert.ok(data.stdout.artifactTruncatedBytes + data.stderr.artifactTruncatedBytes > 0);
  assert.equal(result.artifacts?.length, 2);
  const artifactRoot = await realpath(context.artifactDir);
  let artifactBytes = 0;
  for (const artifact of result.artifacts!) {
    const metadata = await stat(artifact.path);
    assert.equal(metadata.size, artifact.bytes);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal((await stat(dirname(artifact.path))).mode & 0o777, 0o700);
    assert.ok(!relative(artifactRoot, artifact.path).startsWith('..'));
    assert.equal(artifact.truncated, true);
    artifactBytes += metadata.size;
  }
  assert.equal(artifactBytes, COMMAND_LIMITS.artifactBytes);
});

test('UTF-8 model prefixes preserve complete two-byte characters at 2 and 4 byte budgets', { skip: !posix }, async t => {
  const framing = 'Command completed; exitCode=0; signal=null; cleanupConfirmed=true.\nstdout:\n\nstderr:\n';
  for (const outputBytes of [2, 4]) {
    const { context } = await fixture(t);
    context.limits.maxOutputBytes = Buffer.byteLength(framing) + outputBytes;
    const tool = createCommandTool();
    const result = await tool.execute(await tool.prepare({ command: nodeCommand("process.stdout.write('ééé')") }, context), context);
    const data = dataOf(result);
    assert.equal(data.stdout.text, 'é'.repeat(outputBytes / 2));
    assert.equal(data.stdout.modelBytes, outputBytes);
    assert.equal(data.stdout.modelTruncatedBytes, 6 - outputBytes);
    assert.ok(Buffer.byteLength(result.content) <= context.limits.maxOutputBytes);
    assert.equal(result.content.includes('\uFFFD'), false);
  }
});

test('the command model ceiling applies when the caller permits a larger output', { skip: !posix }, async t => {
  const { context } = await fixture(t);
  context.limits.maxOutputBytes = COMMAND_LIMITS.modelBytes * 2;
  const tool = createCommandTool();
  const bytes = COMMAND_LIMITS.modelBytes + 16;
  const result = await tool.execute(await tool.prepare({ command: nodeCommand(`require('node:fs').writeSync(1, Buffer.alloc(${bytes}, 65))`) }, context), context);
  const data = dataOf(result);
  assert.equal(data.status, 'completed');
  assert.equal(data.stdout.totalBytes, bytes);
  assert.ok(Buffer.byteLength(result.content) <= COMMAND_LIMITS.modelBytes);
  assert.ok(data.stdout.modelTruncatedBytes > 0);
  verifyOutput(data.stdout);
});

test('tiny model limits bound the complete result framing as well as output', { skip: !posix }, async t => {
  const { context } = await fixture(t);
  context.limits.maxOutputBytes = 1;
  const tool = createCommandTool();
  const result = await tool.execute(await tool.prepare({ command: nodeCommand("process.stdout.write('unbounded framing must not bypass the budget')") }, context), context);
  const data = dataOf(result);
  assert.equal(data.status, 'completed');
  assert.ok(Buffer.byteLength(result.content) <= 1);
  assert.equal(data.stdout.text, '');
  assert.equal(data.stdout.modelBytes, 0);
  assert.equal(data.stdout.modelTruncatedBytes, data.stdout.totalBytes);
});

test('concurrent execution of the same preparation creates one effect', { skip: !posix }, async t => {
  const { root, context } = await fixture(t);
  const tool = createCommandTool();
  const prepared = await tool.prepare({ command: nodeCommand("require('node:fs').appendFileSync('once.txt', 'x')") }, context);
  const results = await Promise.allSettled([tool.execute(prepared, context), tool.execute(prepared, context)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(rejected.reason.code, 'COMMAND_ALREADY_EXECUTED');
  assert.equal(await readFile(join(root, 'once.txt'), 'utf8'), 'x');
});

test('an already aborted signal returns cancellation without process, artifact, or checkpoint effects', { skip: !posix }, async t => {
  const { root, context, controller, checkpoints } = await fixture(t);
  const marker = join(root, 'cancelled-effect');
  const tool = createCommandTool();
  const prepared = await tool.prepare({ command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'effect')`) }, context);
  controller.abort();
  const result = await tool.execute(prepared, context);
  const data = dataOf(result);
  assert.equal(data.status, 'cancelled');
  assert.equal(data.cancelled, true);
  assert.equal(data.timedOut, false);
  assert.equal(data.cleanupConfirmed, true);
  assert.equal(data.started, false);
  assert.equal(result.isError, true);
  await assertAbsent(marker);
  await assertAbsent(context.artifactDir);
  assert.equal(checkpoints.length, 0);
});

test('binary capture omissions do not become false checkpoint creation or deletion', { skip: !posix }, async t => {
  for (const direction of ['text-to-binary', 'binary-to-text']) {
    const { root, context, checkpoints } = await fixture(t);
    await writeFile(join(root, 'changed.dat'), direction === 'text-to-binary' ? 'existing text' : Buffer.from([0, 1, 2]));
    const tool = createCommandTool();
    const replacement = direction === 'text-to-binary' ? 'Buffer.from([0, 1, 2])' : "'new text'";
    const result = await tool.execute(await tool.prepare({ command: nodeCommand(`require('node:fs').writeFileSync('changed.dat', ${replacement})`) }, context), context);
    assert.equal(dataOf(result).status, 'completed');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]!.incomplete, true);
    assert.equal(checkpoints[0]!.files.some(file => file.path === 'changed.dat'), false);
    assert.match(checkpoints[0]!.warnings.join('\n'), /absence|unverified|not verified/i);
  }
});

test('output artifacts inside the workspace are excluded from command checkpoints', { skip: !posix }, async t => {
  const { root, context, checkpoints } = await fixture(t);
  context.artifactDir = join(root, 'artifacts');
  const tool = createCommandTool();
  const result = await tool.execute(await tool.prepare({ command: nodeCommand("process.stdout.write('output'); require('node:fs').writeFileSync('user.txt', 'change')") }, context), context);
  assert.equal(dataOf(result).status, 'completed');
  assert.deepEqual(checkpoints[0]!.files.map(file => file.path), ['user.txt']);
  assert.equal(result.artifacts?.length, 2);
});

test('cancellation confirms both child and grandchild stopped before returning', { skip: !posix, timeout: 12_000 }, async t => {
  const { root, context, controller } = await fixture(t);
  const tool = createCommandTool();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root), timeoutMs: 5_000 }, context), context);
  const pids = await observeTree(root);
  controller.abort();
  const result = await execution;
  const data = dataOf(result);
  assert.equal(data.status, 'cancelled');
  assert.equal(data.cancelled, true);
  assert.equal(data.timedOut, false);
  assert.equal(data.cleanupConfirmed, true);
  assert.equal(result.isError, true);
  for (const pid of pids) assert.equal(await running(pid), false, `Process ${pid} stopped before cancellation result`);
});

test('the command supervisor holds the persistent effects lock until cancelled children are stopped', { skip: !posix, timeout: 12_000 }, async t => {
  const { root, temporary, context, controller } = await fixture(t);
  context.executionLockPath = join(temporary, 'state', 'effects.sqlite');
  const tool = createCommandTool();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root, true) }, context), context);
  const pids = await observeTree(root);
  assert.throws(() => assertExecutionLockAvailable(context.executionLockPath!), { code: 'COMMAND_EFFECTS_BUSY' });
  controller.abort();
  const result = await execution;
  assert.equal(dataOf(result).status, 'cancelled');
  assert.equal(dataOf(result).cleanupConfirmed, true);
  for (const pid of pids) assert.equal(await running(pid), false);
  assert.doesNotThrow(() => assertExecutionLockAvailable(context.executionLockPath!));
});

test('a busy persistent effects lock prevents supervisor command effects', { skip: !posix, timeout: 12_000 }, async t => {
  const { root, temporary, context } = await fixture(t);
  context.executionLockPath = join(temporary, 'state', 'effects.sqlite');
  const owner = acquireExecutionLock(context.executionLockPath);
  try {
    const tool = createCommandTool();
    const prepared = await tool.prepare({ command: nodeCommand("require('node:fs').writeFileSync('blocked.txt', 'effect')") }, context);
    const result = await tool.execute(prepared, context);
    const data = dataOf(result);
    assert.equal(data.status, 'failed');
    assert.equal(data.started, false);
    assert.equal(data.cleanupConfirmed, true);
    assert.equal(result.isError, true);
    await assertAbsent(join(root, 'blocked.txt'));
    assert.throws(() => assertExecutionLockAvailable(context.executionLockPath!), { code: 'COMMAND_EFFECTS_BUSY' });
  } finally { owner.release(true); }
  assert.doesNotThrow(() => assertExecutionLockAvailable(context.executionLockPath!));
});

test('timeout escalates SIGTERM-ignoring child and grandchild to SIGKILL within a bound', { skip: !posix, timeout: 12_000 }, async t => {
  const { root, context } = await fixture(t);
  const tool = createCommandTool();
  const started = performance.now();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root, true), timeoutMs: 600 }, context), context);
  const pids = await observeTree(root);
  const result = await execution;
  const data = dataOf(result);
  assert.equal(data.status, 'timed_out');
  assert.equal(data.cancelled, false);
  assert.equal(data.timedOut, true);
  assert.equal(data.cleanupConfirmed, true);
  assert.equal(result.isError, true);
  assert.ok(performance.now() - started < 6_000, 'Timeout and cleanup remain bounded');
  for (const pid of pids) assert.equal(await running(pid), false, `SIGTERM-ignoring process ${pid} stopped`);
});

test('a shell that exits while a descendant lives returns failed after descendant cleanup', { skip: !posix, timeout: 12_000 }, async t => {
  const { root, context } = await fixture(t);
  const pidPath = join(root, 'remaining.pid');
  const descendantSource = `
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `;
  const command = nodeCommand(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => { child.stdout.destroy(); child.unref(); process.exit(0); });
  `);
  const tool = createCommandTool();
  const execution = tool.execute(await tool.prepare({ command }, context), context);
  let descendantPid = 0;
  await waitUntil(async () => {
    try {
      descendantPid = Number(await readFile(pidPath, 'utf8'));
      if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) return false;
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  });
  const result = await execution;
  const data = dataOf(result);
  assert.equal(data.status, 'failed');
  assert.equal(data.cancelled, false);
  assert.equal(data.timedOut, false);
  assert.equal(data.cleanupConfirmed, true, JSON.stringify(data));
  assert.equal(result.isError, true);
  assert.match(data.warnings.join('\n'), /descendant/i);
  assert.equal(await running(descendantPid), false);
});

test('the command tree is stopped and its effects lock released after its engine parent is killed', { skip: !posix, timeout: 15_000 }, async t => {
  const { root, temporary, context, ownChild } = await fixture(t);
  context.executionLockPath = join(temporary, 'state', 'effects.sqlite');
  const moduleUrl = new URL('./index.js', import.meta.url).href;
  const command = processTreeCommand(root, true);
  const source = `
    const { createCommandTool } = await import(${JSON.stringify(moduleUrl)});
    const context = ${JSON.stringify({ ...context, signal: undefined, recordCheckpoint: undefined })};
    context.signal = new AbortController().signal;
    context.recordCheckpoint = () => {};
    context.limits.toolTimeoutMs = 30000;
    const tool = createCommandTool();
    const prepared = await tool.prepare({ command: ${JSON.stringify(command)}, timeoutMs: 30000 }, context);
    await tool.execute(prepared, context);
  `;
  const engineFixture = join(temporary, 'engine-parent.mjs');
  await writeFile(engineFixture, source);
  const tsxLoader = import.meta.resolve('tsx');
  const engineParent = spawn(process.execPath, ['--import', tsxLoader, engineFixture], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const parentClosed = ownChild(engineParent);
  assert.ok(engineParent.pid);
  let diagnostics = '';
  engineParent.stdout.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2048); });
  engineParent.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2048); });
  engineParent.on('error', error => { diagnostics = (diagnostics + error.message).slice(-2048); });
  let pids: number[];
  try { pids = await observeTree(root); }
  catch (error) { assert.fail(`${error instanceof Error ? error.message : String(error)}\nEngine subprocess: ${diagnostics}`); }
  assert.throws(() => assertExecutionLockAvailable(context.executionLockPath!), { code: 'COMMAND_EFFECTS_BUSY' });
  engineParent.kill('SIGKILL');
  await bounded(parentClosed, 5_000, 'Original engine parent ChildProcess close did not settle');
  await waitUntil(async () => (await Promise.all(pids!.map(pid => running(pid)))).every(alive => !alive), 6_000);
  for (const pid of pids!) assert.equal(await running(pid), false, `Process ${pid} stopped after engine parent death`);
  await waitUntil(async () => {
    try { assertExecutionLockAvailable(context.executionLockPath!); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'COMMAND_EFFECTS_BUSY') return false;
      throw error;
    }
  }, 6_000);
});

test('supervisor loader flags resolve against the engine host instead of the supervisor cwd', { skip: !posix }, async t => {
  const host = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-command-host-')));
  t.after(() => rm(host, { recursive: true, force: true }));
  await writeFile(join(host, 'hook.mjs'), '');
  await writeFile(join(host, 'hook.cjs'), '');
  const tsxLoader = import.meta.resolve('tsx');
  const cjs = createRequire(import.meta.url);
  const bare = 'tsx/suppress-warnings';
  const probe = `const { supervisorExecArgv } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)}); process.stdout.write(JSON.stringify(supervisorExecArgv()));`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxLoader, '--import', './hook.mjs', '--require=./hook.cjs', '-r', bare, '--input-type=module', '-e', probe],
    { cwd: host, env: { PATH: process.env.PATH, NODE_PATH: dirname(dirname(cjs.resolve('tsx/package.json'))) }, timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout), ['--import', tsxLoader, '--import', pathToFileURL(join(host, 'hook.mjs')).href,
    `--require=${join(host, 'hook.cjs')}`, '-r', cjs.resolve(bare), '--no-warnings']);
});

async function executeInEngineParent(temporary: string, context: ToolContext, execArgv: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const source = `
    const { createCommandTool } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
    const context = ${JSON.stringify({ ...context, signal: undefined, recordCheckpoint: undefined })};
    context.signal = new AbortController().signal;
    context.recordCheckpoint = () => {};
    const calls = [], record = name => () => { calls.push(name); };
    const observer = { beforeSpawn: () => (calls.push('beforeSpawn'), {}), started: record('started'), output() {}, closed: record('closed'), failed: record('failed') };
    const tool = createCommandTool({ observer });
    const result = await tool.execute(await tool.prepare({ command: 'echo ok' }, context), context);
    process.stdout.write(JSON.stringify({ data: result.data, calls }), () => process.exit(0));
  `;
  const engineFixture = join(temporary, 'engine-parent.mjs');
  await writeFile(engineFixture, source);
  const { stdout } = await execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), ...execArgv, engineFixture], { ...options, timeout: 10_000 });
  return JSON.parse(stdout) as { data: CommandData; calls: string[] };
}

test('a relative host loader is never resolved from the workspace by the command supervisor', { skip: !posix, timeout: 15_000 }, async t => {
  const { root, temporary, context } = await fixture(t);
  const host = join(temporary, 'host'), marker = join(temporary, 'workspace-loader-ran');
  await mkdir(host);
  await writeFile(join(host, 'hook.mjs'), '');
  await writeFile(join(root, 'hook.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const { data } = await executeInEngineParent(temporary, context, ['--import', './hook.mjs'], { cwd: host });
  assert.equal(data.status, 'completed');
  assert.equal(data.exitCode, 0);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('an inherited NODE_OPTIONS loader is never resolved from the workspace by the command supervisor', { skip: !posix, timeout: 15_000 }, async t => {
  const { root, temporary, context } = await fixture(t);
  const host = join(temporary, 'host'), marker = join(temporary, 'workspace-loader-ran');
  await mkdir(host);
  await writeFile(join(host, 'hook.mjs'), '');
  await writeFile(join(root, 'hook.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  await executeInEngineParent(temporary, context, [], { cwd: host, env: { ...process.env, NODE_OPTIONS: '--import ./hook.mjs' } });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('a host loader the engine cannot resolve leaves the command definitely not started', { skip: !posix, timeout: 15_000 }, async t => {
  const { temporary, context } = await fixture(t);
  const host = join(temporary, 'host'), loader = join(host, 'node_modules', 'moodcode-host-only-loader');
  await mkdir(loader, { recursive: true });
  await writeFile(join(loader, 'index.js'), '');
  const { data, calls } = await executeInEngineParent(temporary, context, ['-r', 'moodcode-host-only-loader'], { cwd: host });
  assert.deepEqual(calls, ['beforeSpawn', 'closed']);
  assert.equal(data.status, 'failed');
  assert.equal(data.started, false);
  assert.equal(data.cleanupConfirmed, true);
});

test('Windows commands require the available real native process-tree backend', { skip: posix }, async t => {
  const { context } = await fixture(t);
  if (commandBackendCapability().available) {
    const prepared = await createCommandTool().prepare({ command: 'echo hello' }, context);
    assert.equal(prepared.preview.platform, 'win32'); assert.equal(prepared.preview.termination, 'windows-job-object');
  } else await assert.rejects(createCommandTool().prepare({ command: 'echo hello' }, context), { code: 'WINDOWS_JOB_BACKEND_UNAVAILABLE' });
});
