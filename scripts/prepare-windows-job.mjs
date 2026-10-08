import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { metadata, record, requireWindows, results, root, runLogged } from './windows-job-ci.mjs';

try {
  requireWindows();
  await metadata();
  await runLogged('native-build', process.execPath, [join(root, 'packages/windows-job/scripts/build.mjs')]);
  const native = createRequire(import.meta.url)('@moodcode/windows-job');
  const info = native.nativeInfo();
  assert.equal(info.platform, 'win32');
  assert.equal(info.arch, 'x64');
  assert.ok(info.napiVersion >= 8);
  assert.equal(info.atomicJobAssignment, true);
  const job = native.createJob();
  try { assert.equal(job.activeProcessCount(), 0); } finally { job.close(); }
  const binary = join(root, 'packages/windows-job/build/Release/windows_job.node'), bytes = await readFile(binary);
  await copyFile(binary, join(results, 'windows_job.node'));
  await record('native-addon', { available: true, info, relativePath: 'packages/windows-job/build/Release/windows_job.node',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  process.stdout.write(`Required native Windows addon is loaded (${info.arch}, Node-API ${info.napiVersion}).\n`);
} catch (error) {
  await record('native-preparation-failure', { available: false, error: error.message });
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
