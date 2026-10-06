import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { assessCommandPlatform, assessNodeVersion, probeArtifactParent, probeSqlite } from './checks.js';
import { DIAGNOSTICS_LIMITS, getDiagnostics, type DiagnosticsOptions } from './index.js';

const exec = promisify(execFile);
const posixOnly = { skip: process.platform === 'win32' };

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof Error && 'code' in error && error.code === code;
}

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'moodcode-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

async function fakeGit(t: TestContext, body: string): Promise<{ directory: string; executable: string }> {
  const directory = await temporary(t);
  const executable = path.join(directory, 'git fixture');
  await writeFile(executable, `#!${process.execPath}\n'use strict';\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`, { mode: 0o700 });
  return { directory, executable };
}

const workingGit = String.raw`
if (args.includes('--version')) process.stdout.write('git version 2.55.0\n');
else if (args.includes('rev-parse')) process.stdout.write(process.cwd() + '\n');
else if (args.includes('symbolic-ref')) process.stdout.write('main\n');
else if (args.includes('config')) process.exitCode = 1;
else if (args.includes('ls-files')) process.stdout.write('100644\n');
else if (!args.includes('status')) process.exitCode = 99;
`;

async function git(root: string, ...args: string[]): Promise<void> {
  await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root,
    '-c', 'user.name=Moodcode Diagnostics Fixture', '-c', 'user.email=fixture@localhost',
    '-c', 'commit.gpgSign=false', ...args], { timeout: 5_000, maxBuffer: 262_144 });
}

async function repository(t: TestContext): Promise<string> {
  const root = await temporary(t);
  await git(root, 'init', '--initial-branch=main');
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-m', 'Diagnostics fixture');
  return root;
}

function environment(t: TestContext, values: Record<string, string | undefined>): void {
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { return await readFile(file, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('Fixture process did not become ready');
}

async function assertProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Fixture process ${pid} survived cleanup`);
}

test('Node assessment separates actual version, recognized versions and minimum comparison', () => {
  for (const version of ['24.0.0', 'v24.0.0', '24.1.0', '26.9.0']) {
    const result = assessNodeVersion(version);
    assert.equal(result.actualVersion, version);
    assert.equal(result.versionRecognized, true);
    assert.equal(result.meetsMinimum, true);
    assert.equal(result.assessment, 'version_comparison');
  }
  for (const version of ['23.99.99', '24.0.0-rc.1']) assert.equal(assessNodeVersion(version).meetsMinimum, false);
  for (const version of ['future runtime', '24', '24.0', '24.0.0 extra', '999999999999999999999.0.0']) {
    assert.equal(assessNodeVersion(version).versionRecognized, false);
    assert.equal(assessNodeVersion(version).meetsMinimum, null);
  }
});

test('command platform reports Windows unsupported and unknown platforms as unknown', () => {
  assert.deepEqual(assessCommandPlatform('win32'), { platform: 'win32', supported: false, code: 'COMMAND_PLATFORM_UNSUPPORTED', assessment: 'implementation_policy' });
  for (const platform of ['darwin', 'linux', 'freebsd']) assert.equal(assessCommandPlatform(platform).supported, true);
  assert.equal(assessCommandPlatform('future-os').supported, null);
  assert.equal(assessCommandPlatform('future-os').code, 'UNKNOWN_PLATFORM');
});

test('SQLite unavailable module and missing API are diagnosed without raw exception details', async () => {
  const secret = 'sqlite-loader-secret-sentinel';
  const missing = await probeSqlite(async () => { throw new Error(secret); });
  assert.equal(missing.available, false);
  assert.equal(missing.verified, false);
  assert.equal(missing.code, 'SQLITE_MODULE_UNAVAILABLE');
  assert.equal(JSON.stringify(missing).includes(secret), false);
  const unavailable = await probeSqlite(async () => ({ DatabaseSync: null }));
  assert.equal(unavailable.code, 'SQLITE_API_UNAVAILABLE');
  assert.equal(unavailable.available, false);
});

test('SQLite probes only a memory database and closes it after a verified query', async () => {
  let opened = '';
  let closed = 0;
  class Database {
    constructor(location: string) { opened = location; }
    prepare(sql: string) {
      assert.match(sql, /sqlite_version\(\)/);
      return { get: () => ({ result: 42, version: '3.53.4' }) };
    }
    close() { closed++; }
  }
  const result = await probeSqlite(async () => ({ DatabaseSync: Database }));
  assert.equal(opened, ':memory:');
  assert.equal(closed, 1);
  assert.equal(result.available, true);
  assert.equal(result.verified, true);
  assert.equal(result.version, '3.53.4');
});

test('SQLite constructor, query, unknown version and close failures have distinct reports', async () => {
  class ConstructorFailure { constructor() { throw new Error('private constructor detail'); } }
  assert.equal((await probeSqlite(async () => ({ DatabaseSync: ConstructorFailure }))).code, 'SQLITE_PROBE_FAILED');
  let closed = 0;
  class QueryFailure {
    prepare() { throw new Error('private query detail'); }
    close() { closed++; }
  }
  const failed = await probeSqlite(async () => ({ DatabaseSync: QueryFailure }));
  assert.equal(failed.available, true);
  assert.equal(failed.verified, false);
  assert.equal(closed, 1);
  class UnknownVersion {
    prepare() { return { get: () => ({ result: 42, version: 'private unknown version' }) }; }
    close() { closed++; }
  }
  const unknown = await probeSqlite(async () => ({ DatabaseSync: UnknownVersion }));
  assert.equal(unknown.verified, true);
  assert.equal(unknown.versionRecognized, false);
  assert.equal(unknown.version, null);
  assert.equal(unknown.code, 'SQLITE_VERSION_UNRECOGNIZED');
  assert.equal(JSON.stringify(unknown).includes('private'), false);
  class CloseFailure extends UnknownVersion { override close() { throw new Error('private close detail'); } }
  const closeFailure = await probeSqlite(async () => ({ DatabaseSync: CloseFailure }));
  assert.equal(closeFailure.verified, false);
  assert.equal(closeFailure.code, 'SQLITE_CLOSE_FAILED');
});

test('default diagnostics observes the actual runtime and verifies built-in SQLite', async () => {
  const report = await getDiagnostics();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runtime.node.actualVersion, process.version);
  assert.equal(report.runtime.platform, process.platform);
  assert.equal(report.runtime.architecture, process.arch);
  assert.equal(report.runtime.electron.detected, typeof process.versions.electron === 'string');
  assert.equal(report.runtime.electron.actualVersion, process.versions.electron ?? null);
  assert.equal(report.sqlite.available, true);
  assert.equal(report.sqlite.verified, true);
  assert.equal(report.sqlite.probe, 'memory_database');
  assert.equal(report.workspace, undefined);
  assert.equal(report.artifacts, undefined);
  assert.deepEqual(report.credentials.checks, []);
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= DIAGNOSTICS_LIMITS.defaultReportBytes);
});

test('missing Git does not claim a version or inspect workspace status', async t => {
  const root = await temporary(t);
  const report = await getDiagnostics({ gitExecutable: path.join(root, 'missing-git'), workspacePath: root });
  assert.equal(report.git.available, false);
  assert.equal(report.git.status, 'missing');
  assert.equal(report.git.version, null);
  assert.equal(report.git.code, 'GIT_NOT_FOUND');
  assert.equal(report.workspace?.status, 'not_checked');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(report.ok, false);
});

test('timeout terminates the actual Git fixture process', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const marker = path.join(markerRoot, 'pid');
  const { executable } = await fakeGit(t, `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const report = await getDiagnostics({ gitExecutable: executable, timeoutMs: 500 });
  assert.equal(report.git.status, 'timeout');
  assert.equal(report.git.code, 'GIT_TIMEOUT');
  assert.equal(report.git.available, false);
  await assertProcessGone(Number(await waitForFile(marker)));
});

test('pre-abort does not launch Git and in-flight abort terminates it', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const marker = path.join(markerRoot, 'pid');
  const { executable } = await fakeGit(t, `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  await assert.rejects(getDiagnostics({ gitExecutable: executable, signal: AbortSignal.abort() }), hasCode('ABORTED'));
  await assert.rejects(stat(marker), hasCode('ENOENT'));
  const controller = new AbortController();
  const running = getDiagnostics({ gitExecutable: executable, timeoutMs: 5_000, signal: controller.signal });
  const pid = Number(await waitForFile(marker));
  controller.abort();
  await assert.rejects(running, hasCode('ABORTED'));
  await assertProcessGone(pid);
  const subsequent = await fakeGit(t, workingGit);
  assert.equal((await getDiagnostics({ gitExecutable: subsequent.executable })).git.available, true);
});

test('Git version output budget combines stdout and stderr', posixOnly, async t => {
  const { executable } = await fakeGit(t, "process.stdout.write(Buffer.alloc(600, 97)); process.stderr.write(Buffer.alloc(600, 98));");
  const report = await getDiagnostics({ gitExecutable: executable });
  assert.equal(report.git.available, false);
  assert.equal(report.git.code, 'GIT_OUTPUT_LIMIT');
  assert.equal(report.git.version, null);
});

test('unknown Git versions remain available and never echo raw stdout or stderr', posixOnly, async t => {
  const sentinel = 'unrecognized-version-secret-sentinel';
  const { executable } = await fakeGit(t, `process.stdout.write(${JSON.stringify(sentinel)}); process.stderr.write(${JSON.stringify(sentinel)});`);
  const report = await getDiagnostics({ gitExecutable: executable });
  assert.equal(report.git.available, true);
  assert.equal(report.git.status, 'unknown_version');
  assert.equal(report.git.versionRecognized, false);
  assert.equal(report.git.version, null);
  assert.ok(report.warnings.some(warning => warning.code === 'GIT_VERSION_UNRECOGNIZED'));
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test('credential checks report own-key presence including empty values, deduplicate and omit values', posixOnly, async t => {
  const { executable } = await fakeGit(t, workingGit);
  const present = 'MOODCODE_DIAGNOSTICS_PRESENT_TEST';
  const empty = 'MOODCODE_DIAGNOSTICS_EMPTY_TEST';
  const missing = 'MOODCODE_DIAGNOSTICS_MISSING_TEST';
  const secret = 'credential-value-secret-sentinel';
  environment(t, { [present]: secret, [empty]: '', [missing]: undefined });
  const report = await getDiagnostics({ gitExecutable: executable, credentialEnvNames: [present, empty, missing, present] });
  assert.equal(report.credentials.assessment, 'environment_key_presence_only');
  assert.deepEqual(report.credentials.checks, [{ name: present, configured: true }, { name: empty, configured: true }, { name: missing, configured: false }]);
  assert.equal(report.credentials.omitted, 0);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('invalid options are rejected before probes and do not echo supplied credential values', async () => {
  const invalid: unknown[] = [null, [], { unknown: true }, { timeoutMs: 0 }, { timeoutMs: 10_001 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { maxReportBytes: 2_047 }, { maxReportBytes: 65_537 }, { workspacePath: '' }, { artifactParent: 'bad\0path' }, { gitExecutable: 12 }, { signal: {} }, { credentialEnvNames: ['TOKEN=private-value'] }, { credentialEnvNames: ['x'.repeat(129)] }, { credentialEnvNames: Array.from({ length: 33 }, (_, i) => `NAME_${i}`) }, { workspacePath: '한'.repeat(1_400) }];
  for (const value of invalid) await assert.rejects(getDiagnostics(value as DiagnosticsOptions), hasCode('INVALID_DIAGNOSTICS_OPTIONS'));
  await assert.rejects(getDiagnostics({ credentialEnvNames: ['TOKEN=private-value'] }), error => hasCode('INVALID_DIAGNOSTICS_OPTIONS')(error) && !String(error).includes('private-value'));
});

test('workspace diagnostics resolve a nested Git root, preserve the index and count dirty status', async t => {
  const root = await repository(t);
  const nested = path.join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  const clean = await getDiagnostics({ workspacePath: nested });
  assert.equal(clean.workspace?.status, 'available');
  assert.equal(clean.workspace?.root, root);
  assert.equal(clean.workspace?.branch, 'main');
  assert.equal(clean.workspace?.dirty, false);
  assert.equal(clean.workspace?.statusEntries, 0);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  await writeFile(path.join(root, process.platform === 'win32' ? 'untracked space.txt' : 'untracked\nname.txt'), 'untracked\n');
  const indexPath = path.join(root, '.git', 'index');
  const before = await readFile(indexPath);
  const beforeStat = await stat(indexPath);
  const report = await getDiagnostics({ workspacePath: nested });
  assert.equal(report.workspace?.dirty, true);
  assert.equal(report.workspace?.statusEntries, 2);
  assert.equal(report.workspace?.untrackedEntries, 1);
  assert.equal(report.workspace?.conflictedEntries, 0);
  assert.deepEqual(await readFile(indexPath), before);
  assert.equal((await stat(indexPath)).mtimeMs, beforeStat.mtimeMs);
});

test('unborn and detached repositories have factual branch and clean status', async t => {
  const unborn = await temporary(t);
  await git(unborn, 'init', '--initial-branch=main');
  const unbornReport = await getDiagnostics({ workspacePath: unborn });
  assert.equal(unbornReport.workspace?.status, 'available');
  assert.equal(unbornReport.workspace?.branch, 'main');
  assert.equal(unbornReport.workspace?.dirty, false);
  const root = await repository(t);
  await git(root, 'checkout', '--detach');
  const detached = await getDiagnostics({ workspacePath: root });
  assert.equal(detached.workspace?.branch, null);
  assert.equal(detached.workspace?.dirty, false);
});

test('invalid local Git config reports discovery failure without guessing not-a-repository', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, '.git', 'config'), '[invalid private-config-sentinel\n');
  const report = await getDiagnostics({ workspacePath: root });
  assert.equal(report.git.available, true);
  assert.equal(report.workspace?.status, 'failed');
  assert.equal(report.workspace?.code, 'GIT_WORKSPACE_DISCOVERY_FAILED');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('private-config-sentinel'), false);
});

test('missing and file workspace paths report filesystem facts', async t => {
  const root = await temporary(t);
  const missing = await getDiagnostics({ workspacePath: path.join(root, 'missing') });
  assert.equal(missing.workspace?.code, 'WORKSPACE_PATH_UNAVAILABLE');
  const file = path.join(root, 'file');
  await writeFile(file, 'fixture');
  const wrongType = await getDiagnostics({ workspacePath: file });
  assert.equal(wrongType.workspace?.code, 'WORKSPACE_NOT_DIRECTORY');
  assert.equal(wrongType.workspace?.dirty, null);
});

test('Git discovery failure and raw stderr never expose private details', posixOnly, async t => {
  const secret = 'git-private-stderr-sentinel';
  const { directory, executable } = await fakeGit(t, `
    if (args.includes('--version')) process.stdout.write('git version 2.55.0\\n');
    else { process.stderr.write(${JSON.stringify(secret)}); process.exitCode = 128; }
  `);
  const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
  assert.equal(report.workspace?.code, 'GIT_WORKSPACE_DISCOVERY_FAILED');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('porcelain summaries handle rename pairs, conflicts and filenames containing newlines', posixOnly, async t => {
  const status = 'R  renamed name\0old\nname\0?? untracked\nname\0UU conflict.txt\0';
  const { directory, executable } = await fakeGit(t, `${workingGit.replace("else if (!args.includes('status')) process.exitCode = 99;", `else if (args.includes('status')) process.stdout.write(${JSON.stringify(status)}); else process.exitCode = 99;`)}`);
  const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
  assert.equal(report.workspace?.status, 'available');
  assert.equal(report.workspace?.dirty, true);
  assert.equal(report.workspace?.statusEntries, 3);
  assert.equal(report.workspace?.untrackedEntries, 1);
  assert.equal(report.workspace?.conflictedEntries, 1);
});

test('malformed status and relative Git roots never produce a clean workspace claim', posixOnly, async t => {
  for (const status of ['?? missing-terminator', 'R  missing-original\0', 'ZZ invalid-status\0']) {
    const body = workingGit.replace("else if (!args.includes('status')) process.exitCode = 99;", `else if (args.includes('status')) process.stdout.write(${JSON.stringify(status)}); else process.exitCode = 99;`);
    const { directory, executable } = await fakeGit(t, body);
    const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
    assert.equal(report.workspace?.status, 'failed');
    assert.equal(report.workspace?.code, 'GIT_STATUS_INVALID');
    assert.equal(report.workspace?.dirty, null);
  }
  const { directory, executable } = await fakeGit(t, workingGit.replace("process.stdout.write(process.cwd() + '\\n')", "process.stdout.write('.\\n')"));
  const relative = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
  assert.equal(relative.workspace?.code, 'GIT_WORKSPACE_ROOT_INVALID');
  assert.equal(relative.workspace?.dirty, null);
});

test('Git child receives no credential values, Node hooks or inherited Git selectors', posixOnly, async t => {
  const root = await temporary(t);
  const observed = path.join(root, 'environment.json');
  const names = ['MOODCODE_DIAGNOSTICS_SECRET_TEST', 'MOODCODE_DIAGNOSTICS_API_KEY_FIXTURE', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT'];
  environment(t, Object.fromEntries(names.map(name => [name, name === 'NODE_OPTIONS' ? '--title=moodcode-diagnostics-parent' : 'private-env-sentinel'])));
  const { executable } = await fakeGit(t, `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, Object.hasOwn(process.env, name)])))); ${workingGit}`);
  const report = await getDiagnostics({ gitExecutable: executable, credentialEnvNames: ['MOODCODE_DIAGNOSTICS_SECRET_TEST'] });
  const received = JSON.parse(await readFile(observed, 'utf8')) as Record<string, boolean>;
  assert.deepEqual(received, Object.fromEntries(names.map(name => [name, false])));
  assert.equal(report.credentials.checks[0]?.configured, true);
  assert.equal(JSON.stringify(report).includes('private-env-sentinel'), false);
});

test('artifact parent observation never creates missing directories or opens existing databases', async t => {
  const root = await temporary(t);
  const database = path.join(root, 'engine.sqlite');
  const owner = path.join(root, 'engine.sqlite.owner.sqlite');
  await writeFile(database, 'existing database sentinel');
  await writeFile(owner, 'existing owner-lock sentinel');
  const requested = path.join(root, 'missing', 'nested');
  const beforeDatabase = await readFile(database);
  const beforeOwner = await readFile(owner);
  const result = await probeArtifactParent(requested);
  assert.equal(result.status, 'observed');
  assert.equal(result.existingAncestor, root);
  assert.equal(result.missingDirectories, 2);
  assert.equal(result.assessment, 'access_checks_only');
  assert.equal(result.readable, true);
  assert.equal(result.writable, true);
  assert.match(result.mode ?? '', /^[0-7]{4}$/);
  assert.equal(result.createPossible, process.platform === 'win32' ? null : true);
  await assert.rejects(stat(path.join(root, 'missing')), hasCode('ENOENT'));
  assert.deepEqual(await readFile(database), beforeDatabase);
  assert.deepEqual(await readFile(owner), beforeOwner);
  const report = await getDiagnostics({ artifactParent: requested });
  assert.equal(report.artifacts?.missingDirectories, 2);
  assert.ok(report.warnings.some(warning => warning.code === 'ARTIFACT_CREATION_INFERRED'));
  await assert.rejects(stat(requested), hasCode('ENOENT'));
});

test('artifact file ancestors and dangling links fail without a positive creation inference', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'file');
  await writeFile(file, 'fixture');
  for (const requested of [file, path.join(file, 'nested')]) {
    const result = await probeArtifactParent(requested);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARTIFACT_ANCESTOR_NOT_DIRECTORY');
    assert.equal(result.createPossible, false);
  }
  const dangling = path.join(root, 'dangling');
  await symlink(path.join(root, 'absent'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
  for (const requested of [dangling, path.join(dangling, 'nested')]) {
    const result = await probeArtifactParent(requested);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARTIFACT_ANCESTOR_LINK_UNAVAILABLE');
    assert.equal(result.createPossible, null);
  }
  await assert.rejects(probeArtifactParent(root, AbortSignal.abort()), hasCode('ABORTED'));
});

test('minimum report budget bounds serialized JSON and accounts for omitted credential checks', posixOnly, async t => {
  const { executable } = await fakeGit(t, workingGit);
  const names = Array.from({ length: DIAGNOSTICS_LIMITS.maxCredentialNames }, (_, i) => `KEY_${i}_${'x'.repeat(115)}`);
  const report = await getDiagnostics({ gitExecutable: executable, credentialEnvNames: names, maxReportBytes: DIAGNOSTICS_LIMITS.minReportBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= DIAGNOSTICS_LIMITS.minReportBytes);
  assert.equal(report.truncated, true);
  assert.ok(report.omittedDetails.includes('credentials.checks'));
  assert.ok(report.credentials.omitted > 0);
  assert.equal(report.credentials.checks.length + report.credentials.omitted, names.length);
  for (const check of report.credentials.checks) assert.equal(typeof check.configured, 'boolean');
});

test('cancellation waits for both parallel branch and config preflight processes to be removed', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const branchMarker = path.join(markerRoot, 'branch-pid');
  const configMarker = path.join(markerRoot, 'config-pid');
  const { directory, executable } = await fakeGit(t, String.raw`
    if (args.includes('--version')) process.stdout.write('git version 2.55.0\n');
    else if (args.includes('rev-parse')) process.stdout.write(process.cwd() + '\n');
    else if (args.includes('ls-files')) process.stdout.write('100644\n');
    else {
      const marker = args.includes('symbolic-ref') ? ${JSON.stringify(branchMarker)} : ${JSON.stringify(configMarker)};
      fs.writeFileSync(marker, String(process.pid));
      setInterval(() => {}, 1000);
    }
  `);
  const controller = new AbortController();
  const running = getDiagnostics({ gitExecutable: executable, workspacePath: directory, timeoutMs: 5_000, signal: controller.signal });
  const [branchPid, configPid] = await Promise.all([waitForFile(branchMarker), waitForFile(configMarker)]);
  controller.abort();
  await assert.rejects(running, hasCode('ABORTED'));
  // The rejected API call must wait for both children, not just the first rejection.
  assert.throws(() => process.kill(Number(branchPid), 0), hasCode('ESRCH'));
  assert.throws(() => process.kill(Number(configPid), 0), hasCode('ESRCH'));
});

test('timeout kills the original POSIX process group including an inherited-pipe descendant', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const marker = path.join(markerRoot, 'processes.json');
  const { executable } = await fakeGit(t, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr] });
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `);
  // Startup competes with the complete engine suite. Verify the actual tree is
  // alive before awaiting the timeout; keep the process-removal assertions.
  const running = getDiagnostics({ gitExecutable: executable, timeoutMs: 5_000 });
  const pids = JSON.parse(await waitForFile(marker)) as { parent: number; child: number };
  assert.doesNotThrow(() => process.kill(pids.parent, 0));
  assert.doesNotThrow(() => process.kill(pids.child, 0));
  const report = await running;
  assert.equal(report.git.code, 'GIT_TIMEOUT');
  await Promise.all([assertProcessGone(pids.parent), assertProcessGone(pids.child)]);
});

test('bounded Git status failure retains unknown dirty state rather than claiming clean', posixOnly, async t => {
  const body = workingGit.replace("else if (!args.includes('status')) process.exitCode = 99;", "else if (args.includes('status')) { process.stdout.write(Buffer.alloc(40_000, 97)); process.stderr.write(Buffer.alloc(40_000, 98)); } else process.exitCode = 99;");
  const { directory, executable } = await fakeGit(t, body);
  const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
  assert.equal(report.workspace?.status, 'failed');
  assert.equal(report.workspace?.code, 'GIT_OUTPUT_LIMIT');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(report.workspace?.statusEntries, undefined);
});

test('submodule workspaces preserve the discovered root and leave dirty status unverified', async t => {
  const submoduleSource = await repository(t);
  const root = await repository(t);
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'nested-module');
  await git(root, 'commit', '-am', 'Add local fixture submodule');
  await writeFile(path.join(root, 'nested-module', 'tracked.txt'), 'submodule edit\n');
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const submoduleBefore = await readFile(path.join(root, 'nested-module', 'tracked.txt'));
  const report = await getDiagnostics({ workspacePath: root });
  assert.equal(report.workspace?.status, 'not_checked');
  assert.equal(report.workspace?.code, 'GIT_SUBMODULE_STATUS_NOT_CHECKED');
  assert.equal(report.workspace?.root, root);
  assert.equal(report.workspace?.branch, 'main');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(report.workspace?.statusEntries, undefined);
  assert.equal(report.ok, false);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
  assert.deepEqual(await readFile(path.join(root, 'nested-module', 'tracked.txt')), submoduleBefore);
});

test('configured clean and process filter keys leave status unknown without executing a filter', async t => {
  const root = await repository(t);
  // No attributes are configured and no helper is created or executed by this fixture.
  for (const kind of ['clean', 'process']) {
    await git(root, 'config', `filter.diagnostics-fixture.${kind}`, 'moodcode-filter-must-not-run-private-sentinel');
    const configBefore = await readFile(path.join(root, '.git', 'config'));
    const indexBefore = await readFile(path.join(root, '.git', 'index'));
    const trackedBefore = await readFile(path.join(root, 'tracked.txt'));
    const report = await getDiagnostics({ workspacePath: root });
    assert.equal(report.workspace?.status, 'not_checked');
    assert.equal(report.workspace?.code, 'GIT_EXTERNAL_FILTERS_NOT_CHECKED');
    assert.equal(report.workspace?.dirty, null);
    assert.equal(report.workspace?.root, root);
    assert.equal(report.workspace?.branch, 'main');
    assert.equal(report.workspace?.statusEntries, undefined);
    assert.equal(JSON.stringify(report).includes('moodcode-filter-must-not-run-private-sentinel'), false);
    assert.deepEqual(await readFile(path.join(root, '.git', 'config')), configBefore);
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
    assert.deepEqual(await readFile(path.join(root, 'tracked.txt')), trackedBefore);
    await git(root, 'config', '--unset', `filter.diagnostics-fixture.${kind}`);
  }
});

test('partial clone settings skip status and Git processes receive the no-lazy-fetch policy', async t => {
  const root = await repository(t);
  await git(root, 'config', 'remote.diagnostics-fixture.promisor', 'true');
  const configBefore = await readFile(path.join(root, '.git', 'config'));
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const report = await getDiagnostics({ workspacePath: root });
  assert.equal(report.workspace?.status, 'not_checked');
  assert.equal(report.workspace?.code, 'GIT_PARTIAL_CLONE_STATUS_NOT_CHECKED');
  assert.equal(report.workspace?.dirty, null);
  assert.equal(report.workspace?.root, root);
  assert.equal(report.workspace?.branch, 'main');
  assert.equal(report.git.automaticFetch, 'disabled');
  assert.deepEqual(await readFile(path.join(root, '.git', 'config')), configBefore);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
  if (process.platform !== 'win32') {
    const marker = path.join(root, 'lazy-fetch-setting');
    const { executable } = await fakeGit(t, `fs.writeFileSync(${JSON.stringify(marker)}, process.env.GIT_NO_LAZY_FETCH ?? 'absent'); ${workingGit}`);
    await getDiagnostics({ gitExecutable: executable });
    assert.equal(await readFile(marker, 'utf8'), '1');
  }
});

test('preflight failure, output limit and malformed index modes skip Git status entirely', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const statusMarker = path.join(markerRoot, 'unexpected-status');
  const variants = [
    { old: "else if (args.includes('config')) process.exitCode = 1;", replacement: "else if (args.includes('config')) process.exitCode = 128;", code: 'GIT_STATUS_CONFIG_NOT_VERIFIED' },
    { old: "else if (args.includes('config')) process.exitCode = 1;", replacement: "else if (args.includes('config')) process.stdout.write(Buffer.alloc(70_000, 97));", code: 'GIT_STATUS_CONFIG_NOT_VERIFIED' },
    { old: "else if (args.includes('ls-files')) process.stdout.write('100644\\n');", replacement: "else if (args.includes('ls-files')) process.exitCode = 128;", code: 'GIT_STATUS_INDEX_NOT_VERIFIED' },
    { old: "else if (args.includes('ls-files')) process.stdout.write('100644\\n');", replacement: "else if (args.includes('ls-files')) process.stdout.write('unknown mode\\n');", code: 'GIT_STATUS_INDEX_NOT_VERIFIED' },
  ];
  for (const variant of variants) {
    const body = workingGit.replace(variant.old, variant.replacement).replace("else if (!args.includes('status')) process.exitCode = 99;", `else if (args.includes('status')) fs.writeFileSync(${JSON.stringify(statusMarker)}, 'unexpected'); else process.exitCode = 99;`);
    const { directory, executable } = await fakeGit(t, body);
    const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
    assert.equal(report.workspace?.status, 'not_checked');
    assert.equal(report.workspace?.code, variant.code);
    assert.equal(report.workspace?.root, directory);
    assert.equal(report.workspace?.branch, 'main');
    assert.equal(report.workspace?.dirty, null);
    await assert.rejects(stat(statusMarker), hasCode('ENOENT'));
  }
});

test('unknown Git version skips status while preserving discovered workspace metadata', posixOnly, async t => {
  const markerRoot = await temporary(t);
  const statusMarker = path.join(markerRoot, 'unexpected-status');
  const body = workingGit.replace('git version 2.55.0\\n', 'unrecognized Git fixture\\n').replace("else if (!args.includes('status')) process.exitCode = 99;", `else if (args.includes('status')) fs.writeFileSync(${JSON.stringify(statusMarker)}, 'unexpected'); else process.exitCode = 99;`);
  const { directory, executable } = await fakeGit(t, body);
  const report = await getDiagnostics({ gitExecutable: executable, workspacePath: directory });
  assert.equal(report.git.available, true);
  assert.equal(report.git.version, null);
  assert.equal(report.workspace?.status, 'not_checked');
  assert.equal(report.workspace?.code, 'GIT_VERSION_UNRECOGNIZED');
  assert.equal(report.workspace?.root, directory);
  assert.equal(report.workspace?.branch, 'main');
  assert.equal(report.workspace?.dirty, null);
  await assert.rejects(stat(statusMarker), hasCode('ENOENT'));
});

test('JSON budget counts escaped path bytes and omits long paths without creating them', posixOnly, async t => {
  const { directory, executable } = await fakeGit(t, workingGit);
  // Keep the lexical path below macOS PATH_MAX while JSON escaping doubles its bytes.
  const segment = '"\\\n'.repeat(25);
  const requested = path.join(directory, ...Array.from({ length: 10 }, () => segment));
  const report = await getDiagnostics({ gitExecutable: executable, artifactParent: requested, maxReportBytes: DIAGNOSTICS_LIMITS.minReportBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= DIAGNOSTICS_LIMITS.minReportBytes);
  assert.equal(report.truncated, true);
  assert.ok(report.omittedDetails.includes('artifacts.paths'));
  assert.equal(report.artifacts?.requestedParent, undefined);
  assert.equal(report.artifacts?.existingAncestor, undefined);
  assert.equal(report.artifacts?.missingDirectories, 10);
  await assert.rejects(stat(path.join(directory, segment)), hasCode('ENOENT'));
});
