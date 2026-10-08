import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const options = new Set(process.argv.slice(2));
for (const option of options) if (!['--whole', '--gui', '--package', '--no-build'].includes(option)) throw new Error(`Unknown option: ${option}`);
const directory = resolve(root, 'artifacts/desktop-next');
await mkdir(directory, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
async function files(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await files(path));
    else paths.push(path);
  }
  return paths.sort();
}
async function source() {
  const roots = ['apps/desktop', 'scripts', '.github/workflows', 'package.json', 'package-lock.json'];
  if (options.has('--whole')) roots.push('packages/contracts', 'packages/engine', 'apps/engine-harness');
  const tracked = git(['ls-files', ...roots]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', ...roots]);
  const paths = [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))].sort();
  const sourceFiles = [];
  for (const path of paths) sourceFiles.push({ path, sha256: hash(await readFile(join(root, path))) });
  return { commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), sha256: hash(JSON.stringify(sourceFiles)), files: sourceFiles };
}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  node: process.version, source: await source(), results: [], status: 'running' };
const reportPath = join(directory, 'verification.json');
async function persist() { await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
async function run(name, executable, args) {
  const path = join(directory, `${name}.log`);
  const output = createWriteStream(path, { flags: 'w' });
  const startedAt = Date.now();
  // Desktop GUI entrypoints create their own userData/workspace fixtures. Remote
  // provider credentials are unnecessary for this local verification lane.
  const environment = { ...process.env, NODE_DISABLE_COLORS: '1' };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MOODCODE_API_KEY']) delete environment[key];
  const child = spawn(executable, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const outcome = await new Promise(resolveOutcome => {
    child.once('error', error => resolveOutcome({ exitCode: null, launchFailure: error.code ?? 'SPAWN_FAILED' }));
    child.once('close', (exitCode, signal) => resolveOutcome({ exitCode, ...(signal ? { signal } : {}) }));
  });
  await new Promise(resolveOutput => output.end(resolveOutput));
  const bytes = await readFile(path);
  const log = bytes.toString('utf8');
  const totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
    const match = log.match(new RegExp(`(?:#|ℹ) ${key} (\\d+)(?:\\r?\\n|$)`));
    if (match) totals[key] = Number(match[1]);
  }
  const result = { name, command: [executable, ...args], ...outcome, durationMs: Date.now() - startedAt,
    log: path, logSha256: hash(bytes), ...(Object.keys(totals).length ? { totals } : {}) };
  report.results.push(result);
  await persist();
  console.log(JSON.stringify({ name, exitCode: outcome.exitCode, totals, durationMs: result.durationMs }));
  if (outcome.exitCode !== 0) throw new Error(`${name} failed; inspect ${path}`);
}
try {
  await persist();
  if (!options.has('--no-build')) await run('build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:desktop']);
  const projects = options.has('--whole')
    ? ['packages/contracts/dist', 'packages/engine/dist', 'apps/engine-harness/dist', 'apps/desktop/dist/types']
    : ['apps/desktop/dist/types'];
  const tests = (await Promise.all(projects.map(project => files(join(root, project))))).flat().filter(path => path.endsWith('.test.js')).sort();
  if (!tests.length) throw new Error('No compiled tests found');
  await run(options.has('--whole') ? 'whole' : 'desktop-unit', process.execPath, ['--test', '--test-concurrency=4', ...tests]);
  await run('release-policy', process.execPath, ['--test', 'scripts/desktop-release-policy.test.mjs', 'scripts/desktop-native-package.test.mjs']);
  if (options.has('--gui')) {
    for (const name of ['desktop', 'desktop-settings', 'desktop-conversation', 'desktop-history-recovery', 'desktop-advanced', 'desktop-accounts', 'desktop-update']) {
      await run(name, process.execPath, [`scripts/test-${name}.mjs`]);
    }
  }
  if (options.has('--package')) await run('desktop-package', process.execPath, ['scripts/test-desktop-package.mjs']);
  report.finishedAt = new Date().toISOString();
  report.finalSource = await source();
  if (report.source.sha256 !== report.finalSource.sha256) throw new Error('Source changed during verification; verify the final source before acceptance');
  report.status = 'passed';
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = 'failed';
  report.failure = error.message;
  process.exitCode = 1;
} finally { await persist(); }
