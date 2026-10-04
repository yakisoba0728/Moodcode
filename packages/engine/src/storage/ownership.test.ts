import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

function temporaryDatabase(t: TestContext): { directory: string; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, dbPath: join(directory, 'engine.sqlite') };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof EngineError && error.code === code;
}

interface Ready {
  sessionId: string;
  runId: string;
  toolId: string;
  approvalId?: string;
  lastSeq: number;
}

async function launchOwner(t: TestContext, dbPath: string, mode: 'running-tool' | 'pending-approval'): Promise<{
  child: ChildProcess;
  ready: Ready;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const source = import.meta.url.endsWith('.ts');
  const fixture = fileURLToPath(new URL(`./fixtures/owner-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const child = spawn(process.execPath, [
    ...(source ? ['--import', 'tsx'] : []), fixture, dbPath, mode,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });

  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_384); });
  const ready = await new Promise<Ready>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => reject(new Error(`Owner fixture did not become ready: ${diagnostics}`)), 8_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Owner fixture exited before readiness (${code ?? signal}): ${diagnostics}`)));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffered.slice(0, newline)) as Ready;
        assert.equal(typeof value.sessionId, 'string');
        assert.equal(typeof value.runId, 'string');
        assert.equal(typeof value.toolId, 'string');
        assert.equal(Number.isSafeInteger(value.lastSeq), true);
        clearTimeout(timeout);
        resolve(value);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
  return { child, ready, exited };
}

test('one owner excludes a second store in the same process and remains usable', (t) => {
  const { dbPath } = temporaryDatabase(t);
  const owner = new SqliteStore(dbPath);
  t.after(() => owner.close());
  assert.throws(() => new SqliteStore(dbPath), hasCode('DB_LOCKED'));
  assert.deepEqual(owner.listWorkspaces(), []);
  assert.throws(() => new SqliteStore(dbPath), hasCode('DB_LOCKED'));
  assert.deepEqual(owner.listWorkspaces(), []);
  owner.close();
  const successor = new SqliteStore(dbPath);
  t.after(() => successor.close());
  assert.deepEqual(successor.listWorkspaces(), []);
});

test('database and parent-directory symlinks share the existing owner lock', (t) => {
  const { directory, dbPath } = temporaryDatabase(t);
  const owner = new SqliteStore(dbPath);
  t.after(() => owner.close());
  const fileAlias = join(directory, 'alias.sqlite');
  const directoryAlias = join(directory, 'parent-alias');
  symlinkSync(dbPath, fileAlias, 'file');
  symlinkSync(directory, directoryAlias, 'dir');
  assert.throws(() => new SqliteStore(fileAlias), hasCode('DB_LOCKED'));
  assert.throws(() => new SqliteStore(join(directoryAlias, 'engine.sqlite')), hasCode('DB_LOCKED'));
  assert.deepEqual(owner.listWorkspaces(), []);
  owner.close();
  const successor = new SqliteStore(fileAlias);
  t.after(() => successor.close());
  assert.throws(() => new SqliteStore(dbPath), hasCode('DB_LOCKED'));
});

test('hard-linked database files are rejected before creating a second owner', (t) => {
  const { directory, dbPath } = temporaryDatabase(t);
  const store = new SqliteStore(dbPath);
  store.close();
  const alias = join(directory, 'hard-link.sqlite');
  linkSync(dbPath, alias);
  assert.throws(() => new SqliteStore(dbPath), hasCode('DB_PATH_UNSUPPORTED'));
  assert.throws(() => new SqliteStore(alias), hasCode('DB_PATH_UNSUPPORTED'));
});

test('an initially dangling file symlink cannot create independent ownership locks', (t) => {
  const { directory, dbPath } = temporaryDatabase(t);
  const alias = join(directory, 'initial-alias.sqlite');
  symlinkSync(dbPath, alias, 'file');
  let owner: SqliteStore;
  try { owner = new SqliteStore(alias); }
  catch (error) {
    // Rejecting an unresolved file alias is also a safe, explicit path policy.
    assert.ok(hasCode('DB_PATH_UNSUPPORTED')(error));
    return;
  }
  t.after(() => owner.close());
  let contender: SqliteStore | undefined;
  try {
    assert.throws(() => { contender = new SqliteStore(dbPath); }, hasCode('DB_LOCKED'));
  } finally { contender?.close(); }
});

for (const mode of ['running-tool', 'pending-approval'] as const) {
  test(`SIGKILL releases ownership and recovery journals ${mode} as interrupted`, { timeout: 15_000 }, async (t) => {
    const { dbPath } = temporaryDatabase(t);
    const { child, ready, exited } = await launchOwner(t, dbPath, mode);
    assert.throws(() => new SqliteStore(dbPath), hasCode('DB_LOCKED'));
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });

    const successor = new SqliteStore(dbPath);
    t.after(() => successor.close());
    const recovered = successor.recoverInterrupted();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, ready.runId);
    assert.equal(recovered[0]?.state, 'interrupted');
    const snapshot = successor.getSnapshot(ready.sessionId);
    assert.equal(snapshot.runs.find((run) => run.id === ready.runId)?.state, 'interrupted');
    assert.equal(snapshot.tools.find((tool) => tool.id === ready.toolId)?.state, 'interrupted');
    assert.ok(snapshot.lastSeq > ready.lastSeq);
    assert.equal(snapshot.messages.filter((message) => message.role === 'user').length, 1);
    const events = successor.readEvents(ready.sessionId, 0, 1_000);
    assert.equal(events.filter((event) => event.type === 'run.interrupted').length, 1);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: snapshot.lastSeq }, (_, i) => i + 1));
    if (ready.approvalId) {
      const approval = successor.getApproval(ready.approvalId);
      assert.equal(approval.status, 'expired');
      assert.equal(typeof approval.resolvedAt, 'string');
    }
    assert.deepEqual(successor.recoverInterrupted(), []);
    assert.equal(successor.getSnapshot(ready.sessionId).lastSeq, snapshot.lastSeq);
    assert.throws(() => new SqliteStore(dbPath), hasCode('DB_LOCKED'));

    const run = successor.getRun(ready.runId);
    const duplicate = successor.admit({ sessionId: run.sessionId, requestId: run.requestId, prompt: run.prompt, config: run.config });
    assert.equal(duplicate.runId, ready.runId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(successor.getSnapshot(ready.sessionId).lastSeq, snapshot.lastSeq);
    const next = successor.admit({ sessionId: run.sessionId, requestId: `after-${run.requestId}`, prompt: run.prompt, config: run.config });
    assert.notEqual(next.runId, ready.runId);
    assert.equal(next.duplicate, false);
  });
}
