import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DESKTOP_EVIDENCE_LIMITS } from './desktop-test-evidence.mjs';

const directory = resolve('artifacts/desktop-advanced/failures');
const before = new Set(await readdir(directory).catch(() => []));
const environment = { ...process.env, MOODCODE_DESKTOP_ADVANCED_TEST_FAILURE: 'terminal-running' };
for (const key of ['OPENAI_API_KEY', 'MOODCODE_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];
const result = spawnSync(process.execPath, ['scripts/test-desktop-advanced.mjs'], {
  env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
if (result.error) throw result.error;
await writeFile(resolve('artifacts/desktop-advanced/controlled-failure.log'), `${result.stdout}\n${result.stderr}`);
assert.equal(result.status, 1, 'The intentional failure must remain a failed GUI invocation.');
assert.equal(result.signal, null, 'The invocation must settle without forced termination.');
assert.match(result.stderr, /CONTROLLED_DESKTOP_ADVANCED_FAILURE/u);
const added = (await readdir(directory)).filter(name => !before.has(name));
assert.equal(added.length, 1, 'The exact failing invocation must retain one evidence bundle.');
const bundle = join(directory, added[0]);
const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
assert.equal(manifest.outcome, 'failed');
assert.equal(manifest.originalSourceRetained, true);
assert.equal(manifest.cleanup.nativeConfirmed, null);
assert.equal(manifest.cleanup.utilityAcknowledged, null);
assert.equal(manifest.qualification.physicalAbsenceEstablishesCleanup, false);
assert.equal(manifest.qualification.coherentRecoveryBackup, false);
assert.ok(manifest.nativeBeforeClose.live.records.terminals.some(terminal => terminal.state === 'running' && terminal.cleanupConfirmed === null),
  'The fault must follow the original native running PTY observation.');
assert.equal(manifest.nativeAfterClose.close.applicationClose.exitObserved, true);
assert.equal(manifest.nativeAfterClose.close.applicationClose.exitCode, 0);
assert.equal(manifest.truncated, false, 'This finite fixture must fit the evidence limits.');
assert.ok(manifest.files.length <= DESKTOP_EVIDENCE_LIMITS.files);
assert.ok(manifest.totalBytes <= DESKTOP_EVIDENCE_LIMITS.bytes);
assert.match(manifest.sourceFixture, /^moodcode-desktop-test-advanced-[A-Za-z0-9]+$/u);
const source = join(await realpath(tmpdir()), manifest.sourceFixture);
assert.ok((await stat(source)).isDirectory(), 'Application exit must retain the original failing fixture.');
const sqlite = manifest.files.find(file => file.file === 'userData/engine.sqlite' && file.copied);
assert.ok(sqlite, 'The bounded bundle must retain the original native database bytes.');
const original = await readFile(join(source, sqlite.file));
const copied = await readFile(join(bundle, 'native', sqlite.file));
assert.equal(createHash('sha256').update(original).digest('hex'), sqlite.sha256);
assert.deepEqual(copied, original);
assert.equal(manifest.files.some(file => /(?:settings|accounts|Cookies|Local Storage|\.git)/u.test(file.file)), false);
console.log(JSON.stringify({ ok: true, expectedFailureExitCode: result.status, actualRunningPtyObserved: true,
  originalFixtureRetained: true, applicationExitDoesNotConfirmUtilityCleanup: true, bundle, copiedFiles: manifest.files.length,
  bytes: manifest.totalBytes }));
