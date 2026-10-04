import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DiagnosticsReport } from './types.js';

const doctorPath = fileURLToPath(new URL('../../../../scripts/doctor.mjs', import.meta.url));

function runDoctor(args: string[], settings: { flags?: string[]; env?: NodeJS.ProcessEnv; scriptPath?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
      if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
    }
    const child = spawn(process.execPath, [...(settings.flags ?? []), settings.scriptPath ?? doctorPath, ...args], { env: { ...env, ...settings.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
}

test('doctor runs the compiled diagnostics and returns a compact JSON report', async () => {
  const result = await runDoctor(['--json']);
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runtime.node.actualVersion, process.version);
  assert.equal(report.runtime.electron.detected, false);
  assert.equal(report.sqlite.verified, true);
  assert.equal(report.git.available, true);
  assert.equal(result.code, process.platform === 'win32' ? 1 : 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 16_384);
});

test('doctor reports actual SQLite module unavailability without importing the engine facade', async () => {
  const result = await runDoctor(['--json'], { flags: ['--no-experimental-sqlite'] });
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.equal(result.code, 1);
  assert.equal(report.sqlite.available, false);
  assert.equal(report.sqlite.verified, false);
  assert.equal(report.sqlite.code, 'SQLITE_MODULE_UNAVAILABLE');
  assert.equal(report.git.available, true);
});

test('doctor reports missing Git and leaves the SQLite probe independent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-doctor-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runDoctor(['--json', '--git', join(directory, 'not-a-git-executable')]);
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.equal(result.code, 1);
  assert.equal(report.git.status, 'missing');
  assert.equal(report.sqlite.verified, true);
});

test('doctor credential flags only expose deduplicated environment key presence', async () => {
  const result = await runDoctor(['--json', '--credential-env', 'MOODCODE_CLI_SECRET', '--credential-env', 'MOODCODE_CLI_EMPTY', '--credential-env', 'MOODCODE_CLI_ABSENT', '--credential-env', 'MOODCODE_CLI_SECRET'], { env: { MOODCODE_CLI_SECRET: 'fixture-credential-do-not-print', MOODCODE_CLI_EMPTY: '' } });
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.deepEqual(report.credentials.checks, [
    { name: 'MOODCODE_CLI_SECRET', configured: true },
    { name: 'MOODCODE_CLI_EMPTY', configured: true },
    { name: 'MOODCODE_CLI_ABSENT', configured: false },
  ]);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-credential-do-not-print'));
});

test('doctor stdout remains valid JSON within the minimum budget including framing', async () => {
  const args = ['--json', '--max-report-bytes', '2048'];
  for (let index = 0; index < 32; index++) args.push('--credential-env', `MOODCODE_LONG_NAME_${index}_${'A'.repeat(100)}`);
  const result = await runDoctor(args);
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.equal(result.code, process.platform === 'win32' ? 1 : 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 2048);
  assert.equal(report.truncated, true);
  assert.ok(report.credentials.omitted > 0);
});

test('doctor rejects unknown, duplicate, missing and invalid flags with bounded generic errors', async () => {
  const cases = [
    ['--json', '--unknown', 'fixture-do-not-print'], ['--json', '--workspace'],
    ['--json', '--json'], ['--json', '--git', 'git', '--git', 'git'],
    ['--json', '--timeout-ms', '1.5'], ['--json', '--timeout-ms', '0'],
    ['--json', '--max-report-bytes', '2047'], ['--json', '--credential-env', 'INVALID-NAME'],
  ];
  for (const args of cases) {
    const result = await runDoctor(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr) as { error: { code: string } };
    assert.ok(['INVALID_DOCTOR_FLAGS', 'INVALID_DIAGNOSTICS_OPTIONS'].includes(error.error.code));
    assert.ok(Buffer.byteLength(result.stderr) <= 512);
    assert.ok(!result.stderr.includes('fixture-do-not-print'));
  }
});

test('doctor supports bounded human output and help without extra output files', async () => {
  const result = await runDoctor(['--max-report-bytes', '2048']);
  assert.match(result.stdout, /Moodcode engine doctor:/);
  assert.match(result.stdout, /SQLite:/);
  assert.ok(Buffer.byteLength(result.stdout) <= 2048);
  const help = await runDoctor(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--artifact-parent/);
  assert.equal(help.stderr, '');
});

test('doctor timeout is a report finding and does not print fake Git stderr', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-doctor-hang-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'git-fixture');
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write('fixture-secret-in-git-stderr');setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const result = await runDoctor(['--json', '--git', executable, '--timeout-ms', '1000']);
  const report = JSON.parse(result.stdout) as DiagnosticsReport;
  assert.equal(result.code, 1);
  assert.equal(report.git.status, 'timeout');
  assert.equal(report.git.code, 'GIT_TIMEOUT');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-secret-in-git-stderr'));
});

test('doctor reports a missing build from an isolated copy without changing compiled files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-doctor-unbuilt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, 'scripts');
  await mkdir(scripts);
  const scriptPath = join(scripts, 'doctor.mjs');
  await writeFile(scriptPath, await readFile(doctorPath));
  const result = await runDoctor(['--json'], { scriptPath });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'DOCTOR_BUILD_REQUIRED');
});

test('doctor SIGINT and SIGTERM wait for Git cleanup and return explicit cancellation exit codes', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'moodcode-doctor-signal-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const marker = join(directory, 'git.pid');
    const executable = join(directory, 'git-fixture');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const child = spawn(process.execPath, [doctorPath, '--json', '--git', executable, '--timeout-ms', '10000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stdout.resume();
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    let gitPid: number | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { gitPid = Number(await readFile(marker, 'utf8')); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(gitPid !== undefined && Number.isSafeInteger(gitPid));
      child.kill(signal);
      assert.equal(await closed, exitCode);
      assert.equal(JSON.parse(Buffer.concat(stderr).toString('utf8')).error.code, 'ABORTED');
      assert.throws(() => process.kill(gitPid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    } finally {
      child.kill('SIGKILL');
      if (gitPid !== undefined) { try { process.kill(-gitPid, 'SIGKILL'); } catch {} }
      await closed;
    }
  }
});
