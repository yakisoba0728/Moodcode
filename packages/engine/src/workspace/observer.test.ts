import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { openWorkspace, WorkspaceObserver, type WorkspaceObservation, type WorkspaceObserverOptions } from './index.js';

const exec = promisify(execFile);
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function errorCode(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
}

async function fixture(t: TestContext, files: Record<string, string> = { 'tracked.txt': 'before' }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moodcode-observer-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository');
  await mkdir(root);
  const git = (...args: string[]) => exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', ...args]);
  await git('init', '--initial-branch=main');
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  await git('add', '.');
  await git('commit', '--allow-empty', '-m', 'Observer fixture');
  const workspace = await openWorkspace(root);
  const observers: WorkspaceObserver[] = [];
  t.after(async () => { await Promise.all(observers.map((observer) => observer.stop())); });
  const observe = (options: WorkspaceObserverOptions = {}) => {
    const observer = new WorkspaceObserver(workspace, { intervalMs: 50, ...options });
    observers.push(observer);
    return observer;
  };
  return { temporary, root, workspace, git, observe };
}

async function deadline<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Observer test exceeded ${milliseconds}ms.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function next(observer: WorkspaceObserver): Promise<WorkspaceObservation> {
  const result = await deadline(observer.next());
  assert.equal(result.done, false);
  return result.value;
}

async function until(observer: WorkspaceObserver, predicate: (observation: WorkspaceObservation) => boolean): Promise<WorkspaceObservation> {
  return deadline((async () => {
    for (;;) {
      const observation = await next(observer);
      if (predicate(observation)) return observation;
    }
  })());
}

test('observer delivers an initial snapshot and observes add/edit/delete/branch/index status', async (t) => {
  const { root, git, observe } = await fixture(t);
  const observer = observe();
  assert.equal(observer.state, 'idle');
  const initial = await next(observer);
  assert.equal(observer.state, 'running');
  assert.equal(initial.type, 'initial');
  assert.equal(initial.sequence, 1);
  assert.equal(initial.git.branch, 'main');
  assert.equal(initial.git.clean, true);
  assert.equal(initial.captureComplete, true);
  assert.deepEqual(initial.changes, []);
  assert.deepEqual(initial.files.get('tracked.txt'), { hash: hash('before'), bytes: 6 });
  assert.equal('content' in initial.files.get('tracked.txt')!, false);

  await writeFile(path.join(root, 'added.txt'), 'new');
  const added = await until(observer, (event) => event.files.has('added.txt'));
  assert.deepEqual(added.changes.find((change) => change.path === 'added.txt'), { path: 'added.txt', kind: 'added', beforeHash: null, afterHash: hash('new') });
  assert.ok(added.git.entries.some((entry) => entry.path === 'added.txt' && entry.index === '?'));

  await writeFile(path.join(root, 'tracked.txt'), 'after');
  const edited = await until(observer, (event) => event.files.get('tracked.txt')?.hash === hash('after'));
  assert.deepEqual(edited.changes.find((change) => change.path === 'tracked.txt'), { path: 'tracked.txt', kind: 'modified', beforeHash: hash('before'), afterHash: hash('after') });

  await rm(path.join(root, 'added.txt'));
  const deleted = await until(observer, (event) => !event.files.has('added.txt'));
  assert.deepEqual(deleted.changes.find((change) => change.path === 'added.txt'), { path: 'added.txt', kind: 'removed', beforeHash: hash('new'), afterHash: null });

  await git('checkout', '-b', 'feature');
  const branch = await until(observer, (event) => event.git.branch === 'feature');
  assert.deepEqual(branch.changes, []);
  await git('add', 'tracked.txt');
  const staged = await until(observer, (event) => event.git.entries.some((entry) => entry.path === 'tracked.txt' && entry.index === 'M'));
  assert.deepEqual(staged.changes, []);
  assert.equal(staged.git.dirty, true);
  await git('commit', '-m', 'Edited');
  const clean = await until(observer, (event) => event.git.clean);
  assert.deepEqual(clean.changes, []);
});

test('unchanged polls do not emit and iterator return wakes a pending next and cleans listeners', async (t) => {
  const { observe } = await fixture(t);
  const controller = new AbortController();
  const observer = observe({ signal: controller.signal });
  await next(observer);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  let resolved = false;
  const waiting = observer.next().then((result) => { resolved = true; return result; });
  await delay(180);
  assert.equal(resolved, false);
  await deadline(observer.return(), 1_000);
  assert.equal((await waiting).done, true);
  assert.equal(observer.state, 'stopped');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await observer.next()).done, true);
  assert.throws(() => observer.start(), errorCode('OBSERVER_CLOSED'));
  await observer.stop();
});

test('slow consumers receive only the latest snapshot with deltas against the last delivered state', async (t) => {
  const { root, observe } = await fixture(t, { 'a.txt': 'a0', 'b.txt': 'b0' });
  const observer = observe();
  await next(observer);
  await writeFile(path.join(root, 'a.txt'), 'a1');
  await delay(220);
  await writeFile(path.join(root, 'b.txt'), 'b1');
  await delay(220);
  await writeFile(path.join(root, 'a.txt'), 'a2');
  await delay(220);
  const latest = await next(observer);
  assert.equal(latest.type, 'change');
  assert.equal(latest.files.get('a.txt')?.hash, hash('a2'));
  assert.equal(latest.files.get('b.txt')?.hash, hash('b1'));
  assert.ok(latest.coalesced >= 1);
  assert.deepEqual(latest.changes, [
    { path: 'a.txt', kind: 'modified', beforeHash: hash('a0'), afterHash: hash('a2') },
    { path: 'b.txt', kind: 'modified', beforeHash: hash('b0'), afterHash: hash('b1') },
  ]);
  let returned = false;
  const pending = observer.next().then((value) => { returned = true; return value; });
  await delay(150);
  assert.equal(returned, false); // No backlog of superseded snapshots.
  await observer.stop();
  assert.equal((await pending).done, true);
});

test('a delayed first consumer receives a latest initial snapshot', async (t) => {
  const { root, observe } = await fixture(t);
  const observer = observe();
  // Synchronize with real completed samples; fixed sleeps can expire while Git
  // is still running when the complete suite contends for child processes.
  let beforeObserved!: () => void;
  let latestObserved!: () => void;
  const beforeSample = new Promise<void>(resolve => { beforeObserved = resolve; });
  const latestSample = new Promise<void>(resolve => { latestObserved = resolve; });
  const sample = Reflect.get(observer, 'sample').bind(observer) as () => Promise<Pick<WorkspaceObservation, 'files'>>;
  Reflect.set(observer, 'sample', async () => {
    const result = await sample();
    if (result.files.get('tracked.txt')?.hash === hash('before')) beforeObserved();
    if (result.files.get('tracked.txt')?.hash === hash('latest')) latestObserved();
    return result;
  });
  observer.start();
  assert.equal(observer.start(), observer);
  await deadline(beforeSample);
  await delay(0); // Let the poll loop retain the observed initial sample.
  await writeFile(path.join(root, 'tracked.txt'), 'latest');
  await deadline(latestSample);
  await delay(0);
  const initial = await next(observer);
  assert.equal(initial.type, 'initial');
  assert.equal(initial.files.get('tracked.txt')?.hash, hash('latest'));
  assert.deepEqual(initial.changes, []);
  assert.ok(initial.coalesced >= 1);
});

test('consumer mutation cannot corrupt the comparison baseline or options', async (t) => {
  const { root, observe } = await fixture(t);
  const capture = { maxFiles: 2 };
  const observer = observe({ capture });
  const sample = Reflect.get(observer, 'sample').bind(observer) as () => Promise<unknown>;
  let published!: () => void, samples = 0;
  const publication = new Promise<void>(resolve => { published = resolve; });
  Reflect.set(observer, 'sample', async () => {
    if (++samples > 1) await publication;
    return sample();
  });
  try {
    capture.maxFiles = 1;
    const initial = await next(observer);
    (initial.files as Map<string, { hash: string; bytes: number }>).get('tracked.txt')!.hash = 'tampered';
    (initial.files as Map<string, unknown>).clear();
    initial.warnings.push('tampered');
    initial.git.branch = 'tampered';
    initial.git.entries.push({ path: 'tampered', index: '?', worktree: '?' });
    await writeFile(path.join(root, 'tracked.txt'), 'changed');
    await writeFile(path.join(root, 'new.txt'), 'new');
  } finally { published(); }
  const latest = await until(observer, (event) => event.files.get('tracked.txt')?.hash === hash('changed') && event.files.get('new.txt')?.hash === hash('new'));
  assert.equal(latest.files.size, 2);
  assert.equal(latest.changes.find((change) => change.path === 'tracked.txt')?.beforeHash, hash('before'));
  assert.equal(latest.git.branch, 'main');
  assert.equal(latest.warnings.includes('tampered'), false);
  assert.equal(latest.git.entries.some((entry) => entry.path === 'tampered'), false);
});

test('separate file publications can produce a genuine intermediate observer sample', async (t) => {
  const { root, observe } = await fixture(t);
  const observer = observe({ capture: { maxFiles: 2 } });
  const sample = Reflect.get(observer, 'sample').bind(observer) as () => Promise<Pick<WorkspaceObservation, 'files'>>;
  let firstWritten!: () => void, captured!: () => void, resume!: () => void, samples = 0;
  const firstPublication = new Promise<void>(resolve => { firstWritten = resolve; });
  const intermediate = new Promise<void>(resolve => { captured = resolve; });
  const later = new Promise<void>(resolve => { resume = resolve; });
  Reflect.set(observer, 'sample', async () => {
    const number = ++samples;
    if (number === 2) await firstPublication;
    if (number > 2) await later;
    const result = await sample();
    if (number === 2) {
      assert.equal(result.files.get('tracked.txt')?.hash, hash('changed'));
      assert.equal(result.files.size, 1);
      captured();
    }
    return result;
  });
  try {
    await next(observer);
    await writeFile(path.join(root, 'tracked.txt'), 'changed');
    firstWritten();
    await deadline(intermediate);
    await writeFile(path.join(root, 'new.txt'), 'new');
    const observed = await next(observer);
    assert.equal(observed.files.size, 1);
    assert.equal(observed.captureComplete, true);
    assert.equal(observed.files.get('tracked.txt')?.hash, hash('changed'));
    assert.equal(observed.changes.find(change => change.path === 'tracked.txt')?.beforeHash, hash('before'));
    assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'new');
  } finally {
    firstWritten();
    resume();
    await deadline(observer.stop());
  }
  assert.equal(observer.state, 'stopped');
  assert.equal((await observer.next()).done, true);
});

test('partial capture marks missing paths unobserved rather than claiming deletion', async (t) => {
  const { root, observe } = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b' });
  const observer = observe({ capture: { maxFileBytes: 8 } });
  await next(observer);
  await writeFile(path.join(root, 'a.txt'), 'now-too-large');
  const partial = await until(observer, (event) => !event.captureComplete);
  assert.equal(partial.incomplete, true);
  assert.ok(partial.warnings.some((warning) => warning.includes('oversized')));
  assert.deepEqual(partial.changes.find((change) => change.path === 'a.txt'), { path: 'a.txt', kind: 'unobserved', beforeHash: hash('a'), afterHash: null });
  assert.equal(partial.files.size, 1);
  await rm(path.join(root, 'b.txt'));
  const absent = await until(observer, (event) => !event.files.has('b.txt'));
  assert.equal(absent.changes.find((change) => change.path === 'b.txt')?.kind, 'unobserved');
  await writeFile(path.join(root, 'a.txt'), 'small');
  const complete = await until(observer, (event) => event.captureComplete);
  assert.equal(complete.files.size, 1);
  assert.equal(complete.files.get('a.txt')?.hash, hash('small'));
  assert.equal(complete.changes.find((change) => change.path === 'a.txt')?.kind, 'observed');
});

test('capture and Git-entry results stay bounded and truncated Git changes still emit', async (t) => {
  const { root, git, observe } = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const observer = observe({ maxGitEntries: 1, capture: { maxFiles: 1 } });
  const initial = await next(observer);
  assert.equal(initial.files.size, 1);
  assert.equal(initial.captureComplete, false);
  await writeFile(path.join(root, 'a.txt'), 'a1');
  await writeFile(path.join(root, 'b.txt'), 'b1');
  const dirty = await until(observer, (event) => event.git.totalEntries === 2);
  assert.equal(dirty.files.size, 1);
  assert.equal(dirty.git.entries.length, 1);
  assert.equal(dirty.git.entriesTruncated, true);
  assert.equal(dirty.incomplete, true);
  assert.ok(dirty.warnings.some((warning) => warning.includes('Git status entries truncated')));
  const visibleStatus = structuredClone(dirty.git.entries);
  await git('add', 'b.txt'); // Change is beyond the returned first Git entry.
  const staged = await next(observer);
  assert.deepEqual(staged.git.entries, visibleStatus);
  assert.deepEqual(staged.changes, []);
  assert.ok(staged.sequence > dirty.sequence);
});

test('AbortSignal, pre-abort and idle stop finish iteration and remove listeners', async (t) => {
  const { observe } = await fixture(t);
  const controller = new AbortController();
  const observer = observe({ signal: controller.signal, intervalMs: 60_000 });
  await next(observer);
  const pending = observer.next();
  controller.abort();
  assert.equal((await deadline(pending, 1_000)).done, true);
  assert.equal(observer.state, 'stopped');
  await deadline(observer.stop(), 1_000);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(observer.state, 'stopped');
  const pre = observe({ signal: AbortSignal.abort() });
  assert.equal((await pre.next()).done, true);
  const idle = observe();
  await idle.stop();
  assert.equal((await idle.next()).done, true);
});

test('observer rejects concurrent pending next calls without stopping its consumer', async (t) => {
  const { observe } = await fixture(t);
  const observer = observe();
  const first = observer.next();
  await assert.rejects(observer.next(), errorCode('OBSERVER_CONCURRENT_NEXT'));
  assert.equal((await deadline(first)).done, false);
  await observer.stop();
});

test('for-await break stops polling and stop cancels an in-flight Git child', { skip: process.platform === 'win32' }, async (t) => {
  const { root, temporary, observe } = await fixture(t);
  const completed = observe();
  for await (const initial of completed) {
    assert.equal(initial.type, 'initial');
    break;
  }
  assert.equal(completed.state, 'stopped');

  const binaryDirectory = path.join(temporary, 'fake-bin');
  await mkdir(binaryDirectory);
  const pidFile = path.join(temporary, 'git-pid');
  await writeFile(path.join(binaryDirectory, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ''}`;
  const observer = observe({ gitTimeoutMs: 60_000 });
  try {
    const pending = observer.next();
    void pending.catch(() => {}); // Preserve the rejection while waiting for fixture startup.
    const pid = await deadline((async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { return Number(await readFile(pidFile, 'utf8')); }
        catch { await delay(20); }
      }
      throw new Error('Fake Git did not publish its PID.');
    })());
    await deadline(observer.stop(), 1_000);
    assert.equal((await pending).done, true);
    assert.throws(() => process.kill(pid, 0), errorCode('ESRCH'));
    assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'before');
  } finally {
    await observer.stop();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});

test('same-path directory replacement fails once and cleans the worker', async (t) => {
  const { root, temporary, git, observe } = await fixture(t);
  const observer = observe();
  await next(observer);
  const pending = observer.next();
  // Root replacement can reject while asynchronous fixture Git setup is still
  // pending. Observe it now, then assert the unchanged rejection below.
  void pending.catch(() => {});
  await rename(root, path.join(temporary, 'original'));
  await mkdir(root);
  await git('init', '--initial-branch=replaced');
  await assert.rejects(deadline(pending), (error) => errorCode('WORKSPACE_ROOT_CHANGED')(error) || errorCode('WORKSPACE_UNAVAILABLE')(error));
  assert.equal(observer.state, 'failed');
  assert.equal((await observer.next()).done, true);
  await observer.stop();
});

test('root replaced by an escaping symlink and failed Git operations propagate once', async (t) => {
  const { root, temporary, observe } = await fixture(t);
  const outside = path.join(temporary, 'outside'), stagedLink = path.join(temporary, 'replacement');
  await mkdir(outside);
  await symlink(outside, stagedLink, process.platform === 'win32' ? 'junction' : 'dir');
  const observer = observe();
  await next(observer);
  // Publish the complete replacement before this in-process observer can poll again.
  renameSync(root, path.join(temporary, 'original'));
  renameSync(stagedLink, root);
  await assert.rejects(deadline(observer.next()), errorCode('WORKSPACE_ROOT_CHANGED'));
  assert.equal(observer.state, 'failed');
  assert.equal((await observer.next()).done, true);
  await observer.stop();
  assert.equal(observer.state, 'stopped');

  const second = await fixture(t);
  const failedGit = second.observe();
  await next(failedGit);
  await rm(path.join(second.root, '.git'), { recursive: true });
  await assert.rejects(deadline(failedGit.next()), errorCode('GIT_FAILED'));
  assert.equal((await failedGit.next()).done, true);
});

test('an observed root publication gap fails unavailable once before a later symlink is published', async (t) => {
  const { root, temporary, observe } = await fixture(t), observer = observe();
  await next(observer);
  await rename(root, path.join(temporary, 'original'));
  await assert.rejects(deadline(observer.next()), errorCode('WORKSPACE_UNAVAILABLE'));
  const outside = path.join(temporary, 'outside');
  await mkdir(outside);
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(observer.state, 'failed');
  assert.equal((await observer.next()).done, true);
  await observer.stop();
  assert.equal(observer.state, 'stopped');
});

test('observer options enforce polling minimum and bounded positive limits', async (t) => {
  const { observe } = await fixture(t);
  for (const options of [
    { intervalMs: 0 }, { intervalMs: 49 }, { intervalMs: Number.NaN }, { intervalMs: 60_001 },
    { maxGitEntries: 0 }, { maxGitEntries: 20_001 }, { gitTimeoutMs: 0 },
    { capture: { maxFiles: 0 } }, { capture: { maxFileBytes: 0 } }, { capture: { maxTotalBytes: 0 } },
    { capture: { maxEntries: 0 } }, { capture: { maxDepth: -1 } },
  ]) assert.throws(() => observe(options), errorCode('INVALID_LIMIT'));
});
