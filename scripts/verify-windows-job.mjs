import assert from 'node:assert/strict';
import { join } from 'node:path';
import { record, requireWindows, root, runLogged } from './windows-job-ci.mjs';

try {
  requireWindows();
  const output = await runLogged('native-tests', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1',
    join(root, 'packages/engine/dist/tools/command/windows-native.integration.test.js'),
    join(root, 'packages/engine/dist/tools/command/windows-job-host.test.js')]);
  const value = name => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    assert.equal(matches.length, 1, `Actual TAP output must include one ${name} summary`);
    return Number(matches[0][1]);
  };
  const counts = { tests: value('tests'), pass: value('pass'), fail: value('fail'), cancelled: value('cancelled'), skipped: value('skipped') };
  assert.ok(counts.tests >= 12, 'Native gate must execute the actual lifecycle and Engine cases');
  assert.equal(counts.pass, counts.tests);
  assert.equal(counts.fail, 0);
  assert.equal(counts.cancelled, 0);
  assert.equal(counts.skipped, 0, 'A skipped native case cannot satisfy actual Windows verification');
  await record('native-verification', { actualWindows: true, nativeRequired: true, counts, passed: true });
} catch (error) {
  await record('native-verification-failure', { passed: false, error: error.message });
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
