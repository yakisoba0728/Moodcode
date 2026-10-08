import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { releaseRequirements, rollbackReleasePlan } from './desktop-release-policy.mjs';

const args = process.argv.slice(2), allowed = ['--release', '--no-build', '--dir', '--arch', '--version', '--rollback-from', '--replaces'];
for (let index = 0; index < args.length; index += 1) {
  if (!allowed.includes(args[index])) throw new Error('Unsupported desktop packaging argument.');
  if (['--arch', '--version', '--rollback-from', '--replaces'].includes(args[index])) { if (!args[index + 1]) throw new Error('A packaging argument value is missing.'); index += 1; }
}
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const release = args.includes('--release'), arch = value('--arch') ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Desktop packaging supports arm64 or x64.');
const missing = release ? releaseRequirements(process.platform, process.env) : [];
if (missing.length) {
  console.error(JSON.stringify({ ok: false, phase: 'release-preflight', externalConditions: missing }));
  process.exit(1);
}
const environment = { ...process.env, MOODCODE_DESKTOP_RELEASE: release ? '1' : '0', ...(release ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }) };
function run(command, params) {
  const result = spawnSync(command, params, { stdio: 'inherit', env: environment, shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status ?? 1);
}
const goodRef = value('--rollback-from'), releaseVersion = value('--version');
if (releaseVersion && !/^\d+\.\d+\.\d+$/u.test(releaseVersion)) throw new Error('The release version is invalid.');
if (goodRef) {
  if (!/^[a-f0-9]{40}$/u.test(goodRef)) throw new Error('Rollback source must be an immutable 40-character commit SHA.');
  if (!release || !releaseVersion || !value('--replaces')) throw new Error('Rollback builds require --release, --version, --replaces and --rollback-from.');
  const ref = spawnSync('git', ['rev-parse', '--verify', `${goodRef}^{commit}`], { encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (ref.status !== 0 || head.status !== 0) throw new Error('The rollback source is unavailable.');
  const plan = rollbackReleasePlan({ installedVersion: value('--replaces'), rollbackVersion: releaseVersion, goodCommit: ref.stdout.trim() });
  if (head.stdout.trim() !== plan.sourceCommit) throw new Error('Build the known good commit in an isolated worktree before preparing its rollback release.');
  await mkdir('artifacts/desktop-release', { recursive: true });
  await writeFile('artifacts/desktop-release/rollback-plan.json', `${JSON.stringify(plan, null, 2)}\n`);
}
if (!args.includes('--no-build')) run('npm', ['run', 'build:desktop']);
const policy = JSON.parse(await readFile('apps/desktop/dist/main/release-policy.json', 'utf8'));
if ((policy.profile === 'release') !== release) throw new Error('Build output and packaging profile differ. Rebuild with the intended profile.');
const flag = { darwin: '--mac', linux: '--linux', win32: '--win' }[process.platform];
if (!flag) throw new Error('Desktop packaging is unavailable on this operating system.');
run(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--config', 'apps/desktop/electron-builder.config.cjs', flag, `--${arch}`,
  ...(!release || args.includes('--dir') ? ['--dir'] : []), '--publish', 'never', ...(releaseVersion ? [`--config.extraMetadata.version=${releaseVersion}`] : [])]);
