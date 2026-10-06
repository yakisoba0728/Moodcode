import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../storage/index.js';
import { openWorkspace } from '../workspace/index.js';
import { WorktreeManager } from './index.js';
import { delegationBaseCommit, safeCheckoutArguments } from './safe-checkout.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-safe-checkout-'))), repo = join(root, 'repo');
  await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'file.txt'), 'committed\n');
  await writeFile(join(repo, '.gitattributes'), 'file.txt filter=fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const store = new SqliteStore(join(root, 'state.sqlite')), workspace = await openWorkspace(repo);
  store.putWorkspace(workspace); store.createSession({ id: 'session', workspaceId: workspace.id, title: 'fixture', createdAt: new Date().toISOString() });
  const manager = new WorktreeManager({ directory: join(root, 'worktrees'), documents: store });
  t.after(async () => { await manager.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repo, manager, workspace, signal: new AbortController().signal };
}

test('safe checkout disables actual post-checkout hook, configured named hook, smudge/process filters and automatic helpers', async t => {
  const f = await fixture(t), marker = join(f.root, 'unexpected-execution');
  const hook = join(f.repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker}'\n`); await chmod(hook, 0o700);
  for (const [key, value] of [['filter.fixture.smudge', `printf executed > '${marker}'; cat`], ['filter.fixture.process', `printf executed > '${marker}'`], ['filter.fixture.required', 'true'], ['hook.fixture.command', hook], ['hook.fixture.event', 'post-checkout'], ['core.fsmonitor', hook], ['maintenance.auto', 'true'], ['gc.auto', '1']]) execFileSync('git', ['-C', f.repo, 'config', key!, value!]);
  const args = await safeCheckoutArguments(f.repo, f.signal);
  for (const setting of ['filter.fixture.smudge=', 'filter.fixture.process=', 'filter.fixture.required=false', 'hook.fixture.enabled=false', 'core.hooksPath=/dev/null', 'maintenance.auto=false', 'gc.auto=0', 'core.fsmonitor=false']) assert.ok(args.includes(setting), setting);
  const commit = await delegationBaseCommit(f.repo, f.signal);
  await writeFile(join(f.repo, 'file.txt'), 'uncommitted\n');
  const tree = await f.manager.create({ sessionId: 'session', requestId: 'safe', workspace: f.workspace, reference: commit, safeCheckout: true }, f.signal);
  assert.equal(await readFile(join(tree.root, 'file.txt'), 'utf8'), 'committed\n');
  assert.equal(await readFile(join(f.repo, 'file.txt'), 'utf8'), 'uncommitted\n');
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(execFileSync('git', ['-C', f.repo, 'config', 'filter.fixture.required'], { encoding: 'utf8' }).trim(), 'true');
});

test('unsafe config driver syntax fails before a worktree or durable intent is created', async t => {
  const f = await fixture(t);
  execFileSync('git', ['-C', f.repo, 'config', 'filter.driver.with.dots.smudge', 'cat']);
  await assert.rejects(f.manager.create({ sessionId: 'session', requestId: 'unsafe', workspace: f.workspace, safeCheckout: true }, f.signal), { code: 'SAFE_CHECKOUT_CONFIG_UNSUPPORTED' });
  assert.deepEqual(f.manager.list('session'), []);
});

test('safe and ordinary checkout identities cannot silently share a prior request and abort creates nothing', async t => {
  const f = await fixture(t);
  await f.manager.create({ sessionId: 'session', requestId: 'ordinary', workspace: f.workspace }, f.signal);
  await assert.rejects(f.manager.create({ sessionId: 'session', requestId: 'ordinary', workspace: f.workspace, safeCheckout: true }, f.signal), { code: 'WORKTREE_REQUEST_CONFLICT' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.manager.create({ sessionId: 'session', requestId: 'aborted', workspace: f.workspace, safeCheckout: true }, abort.signal), { code: 'CANCELLED' });
  assert.equal(f.manager.list('session').length, 1);
});
