import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, link, writeFile, truncate, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence, mayDeleteDesktopTestDirectory, DESKTOP_EVIDENCE_LIMITS } from './desktop-test-evidence.mjs';

async function fixture(t) {
  const sourceDirectory = await createDesktopTestDirectory('evidence-unit');
  const artifactDirectory = await mkdtemp(join(tmpdir(), 'moodcode-evidence-unit-output-'));
  const handles = [];
  t.after(async () => { for (const handle of handles) handle.close(); await rm(sourceDirectory, { recursive: true, force: true }); await rm(artifactDirectory, { recursive: true, force: true }); });
  return { sourceDirectory, artifactDirectory, handles };
}
async function hashes(directory) {
  const result = {};
  for (const name of await readdir(directory)) if (/\.sqlite(?:-(?:wal|shm))?$/u.test(name)) {
    const bytes = await readFile(join(directory, name)); result[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return result;
}

test('failed and uncertain fixtures retain original SQLite and exclude credentials/browser files; forged metadata cannot bypass projection', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.sourceDirectory, 'engine.sqlite'));
  db.exec('CREATE TABLE runs(data TEXT);');
  db.prepare('INSERT INTO runs VALUES(?)').run(JSON.stringify({ id: randomUUID(), state: 'failed', prompt: 'controlled fixture prompt' })); db.close();
  await writeFile(join(f.sourceDirectory, 'settings.json'), 'private-fixture-credential');
  await mkdir(join(f.sourceDirectory, 'accounts')); await writeFile(join(f.sourceDirectory, 'accounts', 'accounts.bin'), 'private-fixture-credential');
  await mkdir(join(f.sourceDirectory, 'Local Storage')); await writeFile(join(f.sourceDirectory, 'Local Storage', 'browser'), 'private-fixture-credential');
  const original = await readFile(join(f.sourceDirectory, 'engine.sqlite'));
  const after = await captureDesktopNativeEvidence({ sourceDirectory: f.sourceDirectory, phase: 'after-close', close: { exitObserved: true, exitCode: 0, forcedStop: true } });
  const forged = { schemaVersion: 1, phase: 'before-close', sqlite: [{ token: 'private-fixture-credential' }], qualification: { secret: 'private-fixture-credential' } };
  const saved = await preserveDesktopTestEvidence({ ...f, scenario: 'failure', outcome: 'failed', cleanup: { state: 'unconfirmed', nativeConfirmed: false, utilityExitObserved: true, forcedStop: true }, nativeBeforeClose: forged, nativeAfterClose: after });
  const text = await readFile(saved.manifestPath, 'utf8'), manifest = JSON.parse(text);
  assert.equal(manifest.cleanup.nativeConfirmed, false); assert.equal(manifest.cleanup.forcedStop, true);
  assert.equal(manifest.qualification.physicalAbsenceEstablishesCleanup, false);
  assert.equal(manifest.qualification.coherentRecoveryBackup, false);
  assert.equal(text.includes('private-fixture-credential'), false);
  assert.equal(manifest.files.length, 1); assert.equal(manifest.files[0].file, 'engine.sqlite');
  assert.deepEqual(await readFile(join(f.sourceDirectory, 'engine.sqlite')), original);
  assert.deepEqual(await readFile(join(saved.directory, 'native/engine.sqlite')), original);
  assert.equal(saved.originalSourceRetained, true);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'passed', cleanup: { state: 'confirmed', nativeConfirmed: false, utilityExitObserved: true } }), false);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'failed', cleanup: { state: 'confirmed', nativeConfirmed: true } }), false);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'passed', cleanup: { state: 'confirmed', nativeConfirmed: true, forcedStop: true } }), false);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'passed', cleanup: { state: 'confirmed', nativeConfirmed: true, utilityAcknowledged: null, utilityExitObserved: true } }), false);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'passed', cleanup: { state: 'confirmed', nativeConfirmed: true, utilityAcknowledged: true, utilityExitObserved: true, utilityScope: 'private-coding-utility' } }), false);
  assert.equal(mayDeleteDesktopTestDirectory({ outcome: 'passed', cleanup: { state: 'confirmed', nativeConfirmed: true, utilityAcknowledged: true, utilityExitObserved: true, utilityScope: 'all-fixture-utilities' } }), true);
});

test('bounded clone capture never opens/modifies original live SQLite/WAL/SHM and retains native cleanup/terminal qualification', async t => {
  const f = await fixture(t), location = join(f.sourceDirectory, 'engine.sqlite');
  const db = new DatabaseSync(location);
  f.handles.push(db);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE attempt_cleanup(data TEXT); CREATE TABLE mcp_executions(data TEXT); CREATE TABLE message_parts(data TEXT); CREATE TABLE terminals(payload TEXT); CREATE TABLE tools(data TEXT);');
  const id = randomUUID();
  db.prepare('INSERT INTO attempt_cleanup VALUES(?)').run(JSON.stringify({ attemptId: id, state: 'uncertain', cleanupConfirmed: false }));
  db.prepare('INSERT INTO mcp_executions VALUES(?)').run(JSON.stringify({ toolCallId: id, state: 'response-terminal', cleanupUncertain: true, effectsUncertain: true, transportCleanupConfirmed: true, executionBlocked: true, remoteResponseObserved: true }));
  db.prepare('INSERT INTO message_parts VALUES(?)').run(JSON.stringify({ id, state: 'interrupted' }));
  db.prepare('INSERT INTO terminals VALUES(?)').run(JSON.stringify({ record: { id: `terminal_${id}`, state: 'running', cleanupConfirmed: null, cwd: '/private/not-exported' } }));
  db.prepare('INSERT INTO tools VALUES(?)').run(JSON.stringify({ id, name: 'mcp_fixture_echo', state: 'completed', output: 'Command completed; exitCode=0; signal=null; cleanupConfirmed=true.' }));
  const before = await hashes(f.sourceDirectory);
  const capture = await captureDesktopNativeEvidence({ sourceDirectory: f.sourceDirectory, phase: 'before-close', liveSnapshot: {
    children: [{ id: `child_${id}`, state: 'running', apiKey: 'private-fixture-credential' }],
    executionObservations: [{ id, state: 'settled', sourceBefore: { completeness: 'unknown', sha256: 'a'.repeat(64), fileCount: 1, bytes: 10 } }],
  } });
  assert.deepEqual(await hashes(f.sourceDirectory), before);
  assert.equal(capture.qualification.originalSQLiteOpened, false);
  assert.equal(capture.sqlite[0].readSource, 'bounded-observed-file-clone');
  assert.equal(capture.sqlite[0].fileObservation.stableAcrossCapture, true);
  assert.equal(capture.sqlite[0].records.attemptCleanup[0].cleanupConfirmed, false);
  assert.equal(capture.sqlite[0].records.mcpExecutions[0].effectsUncertain, true);
  assert.equal(capture.sqlite[0].records.parts[0].state, 'interrupted');
  assert.equal(capture.sqlite[0].records.terminals[0].record.cleanupConfirmed, null);
  assert.equal(capture.sqlite[0].records.tools[0].cleanupConfirmed, undefined, 'MCP text must never become native command cleanup proof.');
  assert.equal(capture.live.records.children[0].id, `child_${id}`);
  assert.equal(capture.live.records.executionObservations[0].sourceBefore.completeness, 'unknown');
  assert.equal(JSON.stringify(capture).includes('private-fixture-credential'), false);
  assert.throws(() => { capture.sqlite[0].records.attemptCleanup[0].cleanupConfirmed = true; });
});

test('copy budgets retain the original fixture and mark omitted oversized/files explicitly, including native sidecars', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourceDirectory, 'engine.sqlite.owner.sqlite'), 'controlled owner marker');
  await mkdir(join(f.sourceDirectory, 'artifacts'));
  for (let index = 0; index < 70; index++) await writeFile(join(f.sourceDirectory, 'artifacts', `${index}.txt`), 'controlled native artifact');
  const large = join(f.sourceDirectory, 'artifacts', '0-large.bin'); await writeFile(large, ''); await truncate(large, DESKTOP_EVIDENCE_LIMITS.bytes + 1);
  const saved = await preserveDesktopTestEvidence({ ...f, scenario: 'limits', outcome: 'unknown', cleanup: { state: 'unknown' } });
  const manifest = JSON.parse(await readFile(saved.manifestPath, 'utf8'));
  assert.equal(saved.truncated, true); assert.ok(saved.totalBytes <= DESKTOP_EVIDENCE_LIMITS.bytes); assert.ok(manifest.files.length <= DESKTOP_EVIDENCE_LIMITS.files);
  assert.ok(manifest.files.some(file => file.file === 'engine.sqlite.owner.sqlite' && file.copied));
  assert.ok(manifest.files.some(file => file.omitted === 'BYTE_LIMIT'));
  assert.ok((await stat(large)).size > DESKTOP_EVIDENCE_LIMITS.bytes);
  assert.ok((await stat(saved.manifestPath)).size <= DESKTOP_EVIDENCE_LIMITS.manifestBytes);
});

test('unregistered sources and redirected/hardlinked native files cannot be copied', async t => {
  const f = await fixture(t), outsider = await mkdtemp(join(tmpdir(), 'moodcode-nonfixture-'));
  t.after(() => rm(outsider, { recursive: true, force: true }));
  await assert.rejects(captureDesktopNativeEvidence({ sourceDirectory: outsider, phase: 'before-close' }));
  await writeFile(join(outsider, 'outside.sqlite'), 'private-fixture-credential');
  await symlink(join(outsider, 'outside.sqlite'), join(f.sourceDirectory, 'engine.sqlite'));
  await link(join(outsider, 'outside.sqlite'), join(f.sourceDirectory, 'coding.sqlite'));
  const saved = await preserveDesktopTestEvidence({ ...f, scenario: 'links', outcome: 'failed', cleanup: { state: 'unknown' } });
  const text = await readFile(saved.manifestPath, 'utf8');
  assert.equal(saved.copiedFiles, 0); assert.equal(text.includes('private-fixture-credential'), false);
  assert.match(text, /SOURCE_LINK_REJECTED/u); assert.match(text, /SOURCE_IDENTITY_REJECTED/u);
});

test('original native close codes and local deadlines remain distinct; bundle failure leaves original native evidence untouched', async t => {
  const f = await fixture(t), location = join(f.sourceDirectory, 'engine.sqlite');
  const bytes = Buffer.from('controlled failed native fixture');
  await writeFile(location, bytes);
  const nativeBeforeClose = await captureDesktopNativeEvidence({ sourceDirectory: f.sourceDirectory, phase: 'before-close', close: {
    error: { code: 'NATIVE_CLEANUP_UNCERTAIN', source: 'actual-native-IPC', message: 'private-fixture-credential' },
    errors: [{ code: 'UTILITY_EXIT_DEADLINE', source: 'driver-deadline', token: 'private-fixture-credential' }],
    utility: { error: { code: 'CONTROLLED_CLOSE_FAILURE', source: 'driver-lifecycle' },
      cleanup: { state: 'unknown', nativeConfirmed: true, utilityAcknowledged: false, utilityExitObserved: true, forcedStop: true, utilityScope: 'private-coding-utility' } },
  } });
  assert.deepEqual(nativeBeforeClose.close.error, { code: 'NATIVE_CLEANUP_UNCERTAIN', source: 'actual-native-IPC' });
  assert.deepEqual(nativeBeforeClose.close.errors, [{ code: 'UTILITY_EXIT_DEADLINE', source: 'driver-deadline' }]);
  assert.deepEqual(nativeBeforeClose.close.utility, { error: { code: 'CONTROLLED_CLOSE_FAILURE', source: 'driver-lifecycle' },
    cleanup: { state: 'unknown', nativeConfirmed: true, utilityAcknowledged: false, utilityExitObserved: true, forcedStop: true, utilityScope: 'private-coding-utility' } });
  const destinationFile = join(f.artifactDirectory, 'not-a-directory');
  await writeFile(destinationFile, 'controlled destination collision');
  await assert.rejects(preserveDesktopTestEvidence({ ...f, artifactDirectory: destinationFile, scenario: 'bundle-failure',
    outcome: 'failed', cleanup: { state: 'unknown' }, nativeBeforeClose }));
  assert.deepEqual(await readFile(location), bytes);
  assert.equal(JSON.stringify(nativeBeforeClose).includes('private-fixture-credential'), false);
});
