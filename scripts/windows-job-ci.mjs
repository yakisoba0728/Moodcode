import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const results = resolve(process.env.MOODCODE_WINDOWS_RESULTS_DIR ?? join(root, 'artifacts', 'engine-native-windows'));
export async function record(name, value) {
  await mkdir(results, { recursive: true });
  await writeFile(join(results, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}
export async function runLogged(name, executable, args) {
  await mkdir(results, { recursive: true });
  const startedAt = new Date().toISOString(), log = createWriteStream(join(results, `${name}.log`));
  const child = spawn(executable, args, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
  child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
  let failure;
  child.once('error', error => { failure = error; });
  const outcome = await new Promise(yes => child.once('close', (code, signal) => yes({ code, signal })));
  await new Promise((yes, no) => { log.once('error', no); log.end(yes); });
  await record(name, { startedAt, endedAt: new Date().toISOString(), executable, args, ...outcome,
    ...(failure ? { error: failure.message } : {}) });
  if (failure) throw failure;
  if (outcome.code !== 0) throw new Error(`${name} failed with exit ${outcome.code ?? outcome.signal}; original output is in ${name}.log`);
  return await readFile(join(results, `${name}.log`), 'utf8');
}
export function requireWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This native verification requires actual win32 x64; portable execution cannot satisfy it');
  if (![24, 26].includes(Number(process.versions.node.split('.')[0]))) throw new Error('The supported native CI matrix requires Node 24 or 26');
}
export async function metadata() {
  await record('environment', {
    platform: process.platform, arch: process.arch, node: process.versions.node, napi: process.versions.napi,
    sourceSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, runnerOS: process.env.RUNNER_OS ?? null,
    runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
    scope: 'Actual Windows Job Object addon, native process tree/cleanup/crash and real Engine approval/restart; portable regression is recorded separately',
  });
}
export async function summary() {
  await mkdir(results, { recursive: true });
  const entries = [];
  async function collect(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (name === 'summary.json') continue;
      if (entry.isDirectory()) await collect(join(directory, entry.name), name + '/');
      else {
        const bytes = await readFile(join(directory, entry.name));
        entries.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await collect(results);
  await record('summary', { sourceSha: process.env.GITHUB_SHA ?? null, jobStatus: process.env.MOODCODE_WINDOWS_JOB_STATUS ?? null,
    entries, observedAt: new Date().toISOString() });
}
async function main(mode) {
  if (mode === 'metadata') return metadata();
  if (mode === 'summary') return summary();
  throw new Error(`Unknown native CI operation: ${mode}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
