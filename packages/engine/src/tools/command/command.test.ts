import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type Checkpoint, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolResult } from '../../ports.js';
import { COMMAND_LIMITS, createCommandTool } from './index.js';
import { acquireExecutionLock, assertExecutionLockAvailable } from './execution-lock.js';

const posix = process.platform !== 'win32';
const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  const ownedPids = new Set<number>();
  const context: ToolContext = {
    workspace: { id: 'workspace-command', root, gitRoot: root, branch: null, createdAt: '2026-10-04T00:00:00.000Z' },
    sessionId: 'session-command', runId: 'run-command', toolCallId: 'tool-command',
    signal: controller.signal,
    limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 5_000, maxOutputBytes: 4_096 },
    artifactDir: join(temporary, 'artifacts'),
    recordCheckpoint(checkpoint) { checkpoints.push(checkpoint); },
  };
  t.after(async () => {
    for (const pid of ownedPids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    await rm(temporary, { recursive: true, force: true });
  });
  return { temporary, root, context, controller, checkpoints, ownedPids };
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
  try { process.kill(pid, 0); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
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

async function observeTree(root: string, ownedPids: Set<number>): Promise<number[]> {
  const pids: number[] = [];
  for (const name of ['command.pid', 'grandchild.pid']) {
    const path = join(root, name);
    await waitUntil(async () => {
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        ownedPids.add(pid);
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
  const { root, context, controller, ownedPids } = await fixture(t);
  const tool = createCommandTool();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root), timeoutMs: 5_000 }, context), context);
  const pids = await observeTree(root, ownedPids);
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
  const { root, temporary, context, controller, ownedPids } = await fixture(t);
  context.executionLockPath = join(temporary, 'state', 'effects.sqlite');
  const tool = createCommandTool();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root, true) }, context), context);
  const pids = await observeTree(root, ownedPids);
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
  const { root, context, ownedPids } = await fixture(t);
  const tool = createCommandTool();
  const started = performance.now();
  const execution = tool.execute(await tool.prepare({ command: processTreeCommand(root, true), timeoutMs: 600 }, context), context);
  const pids = await observeTree(root, ownedPids);
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
  const { root, context, ownedPids } = await fixture(t);
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
      ownedPids.add(descendantPid);
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
  const { root, temporary, context, ownedPids } = await fixture(t);
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
  assert.ok(engineParent.pid);
  ownedPids.add(engineParent.pid);
  let diagnostics = '';
  engineParent.stdout.on('data', chunk => { diagnostics += String(chunk); });
  engineParent.stderr.on('data', chunk => { diagnostics += String(chunk); });
  engineParent.on('error', error => { diagnostics += error.message; });
  let pids: number[];
  try { pids = await observeTree(root, ownedPids); }
  catch (error) { assert.fail(`${error instanceof Error ? error.message : String(error)}\nEngine subprocess: ${diagnostics}`); }
  assert.throws(() => assertExecutionLockAvailable(context.executionLockPath!), { code: 'COMMAND_EFFECTS_BUSY' });
  const parentExited = new Promise<void>(resolve => engineParent.once('exit', () => resolve()));
  engineParent.kill('SIGKILL');
  await parentExited;
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

test('Windows process-tree support is rejected explicitly', { skip: posix }, async t => {
  const { context } = await fixture(t);
  await assert.rejects(createCommandTool().prepare({ command: 'echo hello' }, context), { code: 'COMMAND_PLATFORM_UNSUPPORTED' });
});
