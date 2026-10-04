import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { acquireExecutionLock, assertExecutionLockAvailable } from './execution-lock.js';

function temporaryLock(t: TestContext): { directory: string; path: string; cleanup(fn: () => void | Promise<void>): void } {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-command-lock-'));
  const callbacks: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const callback of callbacks.reverse()) await callback(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, path: join(directory, 'state', 'effects.sqlite'), cleanup: fn => callbacks.push(fn) };
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof EngineError && error.code === code;
}

function marker(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    const row = db.prepare('SELECT id, owner_pid, group_pid, active, updated_at FROM command_execution WHERE id=1').get();
    assert.ok(row);
    return { ...row };
  } finally { db.close(); }
}

test('availability checks create private parents and leave no execution marker', t => {
  const temporary = temporaryLock(t);
  assertExecutionLockAvailable(temporary.path);
  assertExecutionLockAvailable(temporary.path);
  const db = new DatabaseSync(temporary.path);
  try {
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='command_execution'").get(), undefined);
  } finally { db.close(); }
  if (process.platform !== 'win32') assert.equal(statSync(join(temporary.directory, 'state')).mode & 0o077, 0);
});

test('a held lock rejects readers and contenders, then confirmed cleanup permits a successor', t => {
  const temporary = temporaryLock(t);
  const owner = acquireExecutionLock(temporary.path);
  temporary.cleanup(() => owner.release(false));
  owner.recordGroup(12345);
  assert.throws(() => assertExecutionLockAvailable(temporary.path), hasCode('COMMAND_EFFECTS_BUSY'));
  assert.throws(() => acquireExecutionLock(temporary.path), hasCode('COMMAND_EFFECTS_BUSY'));
  owner.release(true);
  const saved = marker(temporary.path);
  assert.equal(saved.owner_pid, process.pid);
  assert.equal(saved.group_pid, 12345);
  assert.equal(saved.active, 0);
  assert.equal(typeof saved.updated_at, 'string');
  assertExecutionLockAvailable(temporary.path);
  assert.deepEqual(marker(temporary.path), saved, 'preflight must not modify an inactive marker');
  const successor = acquireExecutionLock(temporary.path);
  temporary.cleanup(() => successor.release(false));
  successor.release(true);
  assert.equal(marker(temporary.path).group_pid, null, 'a new command starts without a recorded group');
  assertExecutionLockAvailable(temporary.path);
});

test('unconfirmed cleanup retains its durable active marker and rolls back group updates', t => {
  const temporary = temporaryLock(t);
  const owner = acquireExecutionLock(temporary.path);
  temporary.cleanup(() => owner.release(false));
  owner.recordGroup(9876);
  owner.release(false);
  const saved = marker(temporary.path);
  assert.equal(saved.active, 1);
  assert.equal(saved.owner_pid, process.pid);
  assert.equal(saved.group_pid, null, 'recordGroup is intentionally uncommitted until confirmed release');
  assert.throws(() => assertExecutionLockAvailable(temporary.path), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.throws(() => acquireExecutionLock(temporary.path), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.deepEqual(marker(temporary.path), saved, 'blocked checks must preserve the uncertain marker');
  owner.release(true);
  assert.deepEqual(marker(temporary.path), saved, 'later calls cannot clear an already released uncertain lock');
});

test('released locks cannot record groups, and invalid group IDs leave the owner usable', t => {
  const temporary = temporaryLock(t);
  const owner = acquireExecutionLock(temporary.path);
  temporary.cleanup(() => owner.release(false));
  for (const pid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => owner.recordGroup(pid), hasCode('INVALID_COMMAND_GROUP'));
  }
  owner.recordGroup(process.pid);
  owner.release(true);
  owner.release(true);
  assert.throws(() => owner.recordGroup(process.pid), hasCode('COMMAND_EXECUTION_LOCK_RELEASED'));
  assertExecutionLockAvailable(temporary.path);
});

test('path, filesystem, and malformed SQLite failures become engine errors', t => {
  const temporary = temporaryLock(t);
  for (const path of ['', ':memory:', 'relative.sqlite', `${temporary.path}\0bad`]) {
    assert.throws(() => assertExecutionLockAvailable(path), hasCode('COMMAND_EFFECTS_LOCK_FAILED'));
    assert.throws(() => acquireExecutionLock(path), hasCode('COMMAND_EFFECTS_LOCK_FAILED'));
  }
  const parentFile = join(temporary.directory, 'parent-file');
  writeFileSync(parentFile, 'not a directory');
  assert.throws(() => acquireExecutionLock(join(parentFile, 'effects.sqlite')), hasCode('COMMAND_EFFECTS_LOCK_FAILED'));
  const malformed = join(temporary.directory, 'not-sqlite');
  writeFileSync(malformed, 'not a sqlite database');
  assert.throws(() => assertExecutionLockAvailable(malformed), hasCode('COMMAND_EFFECTS_LOCK_FAILED'));
});

interface Exited { code: number | null; signal: NodeJS.Signals | null }

async function childOwner(temporary: ReturnType<typeof temporaryLock>): Promise<{ child: ChildProcess; pid: number; exited: Promise<Exited> }> {
  const source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(`./execution-lock.${source ? 'ts' : 'js'}`, import.meta.url).href;
  const code = `import { acquireExecutionLock } from ${JSON.stringify(moduleUrl)};
const lock = acquireExecutionLock(process.argv[1]);
lock.recordGroup(process.pid);
process.stdout.write(JSON.stringify({pid: process.pid}) + '\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, [
    ...(source ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', code, temporary.path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<Exited>((resolveExit, reject) => {
    child.once('exit', (exitCode, signal) => resolveExit({ code: exitCode, signal }));
    child.once('error', reject);
  });
  temporary.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-8192); });
  const pid = await new Promise<number>((resolvePid, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Execution lock child did not become ready: ${diagnostics}`)), 8000);
    const fail = (error: unknown) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (exitCode, signal) => fail(new Error(`Execution lock child exited before readiness (${exitCode ?? signal}): ${diagnostics}`)));
    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffered.slice(0, newline)) as { pid: unknown };
        assert.equal(typeof value.pid, 'number');
        assert.equal(value.pid, child.pid);
        clearTimeout(timeout);
        resolvePid(Number(value.pid));
      } catch (error) { fail(error); }
    });
  });
  return { child, pid, exited };
}

test('SIGKILL releases the OS lock while the committed marker blocks crash recovery', { timeout: 15000 }, async t => {
  const temporary = temporaryLock(t);
  const { child, pid, exited } = await childOwner(temporary);
  assert.throws(() => assertExecutionLockAvailable(temporary.path), hasCode('COMMAND_EFFECTS_BUSY'));
  assert.throws(() => acquireExecutionLock(temporary.path), hasCode('COMMAND_EFFECTS_BUSY'));
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  const saved = marker(temporary.path);
  assert.equal(saved.owner_pid, pid);
  assert.equal(saved.active, 1);
  assert.equal(saved.group_pid, null);
  assert.throws(() => assertExecutionLockAvailable(temporary.path), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.throws(() => acquireExecutionLock(temporary.path), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.deepEqual(marker(temporary.path), saved);
});
