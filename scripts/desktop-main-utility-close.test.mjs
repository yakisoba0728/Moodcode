import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { aggregateFixtureCleanup, projectMainUtilityClose, qualifyDesktopNativeCleanup, qualifyMainUtilityClose } from './desktop-main-utility-close.mjs';
import { captureDesktopNativeEvidence, createDesktopTestDirectory } from './desktop-test-evidence.mjs';

function receipt() {
  return { schemaVersion: 1, utilityScope: 'main-utilities', complete: true, evictedCount: 0, utilityAcknowledged: true, utilityExitObserved: true,
    cleanupConfirmed: true, forcedStop: false, connections: [{ connectionId: randomUUID(), scope: 'engine', generation: 1, source: 'original-electron-utility',
      utilityExitObservable: true, engineCloseAcknowledged: true, utilityExitObserved: true, exitCode: 0, cleanupConfirmed: true, forcedStop: false, reason: null }] };
}
function native(records = {}) {
  return { truncated: false, errors: [], sqlite: [{ file: 'engine.sqlite', userVersion: 23, available: true, errors: [], records,
    fileObservation: { stableAcrossCapture: true } }] };
}
test('every original utility needs its own observable exit and ACK; app exit or a clean sibling cannot cover an old connection', () => {
  const value = receipt();
  assert.equal(qualifyMainUtilityClose(value).state, 'confirmed');
  for (const change of [{ engineCloseAcknowledged: false }, { utilityExitObserved: false }, { utilityExitObservable: false },
    { exitCode: 1 }, { source: 'utility-transport' }, { cleanupConfirmed: false }, { forcedStop: true }, { reason: 'exit-timeout' }]) {
    const missing = { ...value, connections: [{ ...value.connections[0], ...change }, { ...value.connections[0], connectionId: randomUUID() }], applicationClose: { exitObserved: true, exitCode: 0 } };
    assert.equal(qualifyMainUtilityClose(missing).state, 'unknown');
  }
  assert.equal(qualifyMainUtilityClose({ ...value, complete: false }).state, 'unknown');
  assert.equal(qualifyMainUtilityClose({ ...value, evictedCount: 1 }).state, 'unknown');
  assert.equal(qualifyMainUtilityClose({ ...value, connections: [] }).state, 'unknown');
  assert.equal(qualifyMainUtilityClose({ ...value, connections: [value.connections[0], value.connections[0]] }).state, 'unknown');
  assert.equal(JSON.stringify(projectMainUtilityClose({ ...value, token: 'private', connections: [{ ...value.connections[0], path: '/private', message: 'private' }] })).includes('private'), false);
});
test('native cleanup requires complete stable clones and no blocked, unresolved or omitted native records', () => {
  assert.equal(qualifyDesktopNativeCleanup(native()), null, 'A bounded projection cannot cover every native store or document.');
  for (const record of [{ cleanupConfirmed: false }, { effectsUncertain: true }, { transportCleanupConfirmed: false }, { executionBlocked: true }]) {
    assert.equal(qualifyDesktopNativeCleanup(native({ mcpExecutions: [{ state: 'response-terminal', ...record }] })), false);
  }
  for (const record of [{ cleanupConfirmed: null }, { state: 'running' }, { state: 'dispatch-intent' }, { code: 'ROW_PROJECTION_UNAVAILABLE' }]) {
    assert.equal(qualifyDesktopNativeCleanup(native({ terminals: [{ record }] })), null);
  }
  assert.equal(qualifyDesktopNativeCleanup(native({ tools: [{ name: 'run_command', state: 'completed' }] })), null);
  assert.equal(qualifyDesktopNativeCleanup({ ...native(), truncated: true }), null);
  assert.equal(qualifyDesktopNativeCleanup({ ...native({ attemptCleanup: [{ cleanupConfirmed: false }] }), truncated: true }), false,
    'Omitted sibling coverage cannot erase an observed original negative receipt.');
  assert.equal(qualifyDesktopNativeCleanup(native({ runs: [{ state: 'failed', error: { code: 'CLEANUP_UNCERTAIN' } }] })), false);
  assert.equal(qualifyDesktopNativeCleanup({ ...native(), sqlite: [{ ...native().sqlite[0], userVersion: 22 }] }), null);
  const mainReceipt = receipt();
  const privateUtility = { state: 'confirmed', nativeConfirmed: true, utilityAcknowledged: true, utilityExitObserved: true, utilityScope: 'private-coding-utility', forcedStop: false };
  assert.equal(aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: true }).utilityScope, 'all-fixture-utilities');
  assert.equal(aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: true, privateUtilitiesExpected: 1 }).state, 'unknown');
  assert.equal(aggregateFixtureCleanup({ mainReceipt: null, nativeConfirmed: true, privateUtilitiesExpected: 1, privateUtilities: [privateUtility] }).state, 'unknown');
  assert.equal(aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: false }).state, 'unconfirmed');
  assert.equal(aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: true, privateUtilitiesExpected: 1, privateUtilities: [privateUtility] }).state, 'confirmed');
  const unknownNative = aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: null, privateUtilitiesExpected: 1,
    privateUtilities: [{ ...privateUtility, state: 'unknown', nativeConfirmed: null, utilityExitCode: 0 }] });
  assert.equal(unknownNative.utilityAcknowledged, true);
  assert.equal(unknownNative.utilityExitObserved, true);
  assert.equal(unknownNative.nativeConfirmed, null);
  assert.equal(unknownNative.state, 'unknown');
  assert.equal(aggregateFixtureCleanup({ mainReceipt, nativeConfirmed: null, privateUtilitiesExpected: 1,
    privateUtilities: [{ ...privateUtility, utilityAcknowledged: false }] }).utilityAcknowledged, false);
});
test('an uncertain 33rd SQLite row marks actual clone capture truncated and cannot qualify native cleanup', async t => {
  const directory = await createDesktopTestDirectory('close-row-limit');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'engine.sqlite'));
  db.exec('PRAGMA user_version=23; CREATE TABLE attempt_cleanup(data TEXT);');
  for (let i = 0; i < 33; i++) db.prepare('INSERT INTO attempt_cleanup VALUES(?)').run(JSON.stringify({ state: i === 32 ? 'uncertain' : 'settled', cleanupConfirmed: i !== 32 }));
  db.close();
  const capture = await captureDesktopNativeEvidence({ sourceDirectory: directory, phase: 'after-close' });
  assert.equal(capture.sqlite[0].records.attemptCleanup.length, 32);
  assert.equal(capture.truncated, true);
  assert.equal(qualifyDesktopNativeCleanup(capture), null);
});
test('the original active native execution marker remains uncertainty despite clean utility exit and terminal rows', async t => {
  const directory = await createDesktopTestDirectory('close-native-marker');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'engine.sqlite'));
  db.exec('PRAGMA user_version=23; CREATE TABLE runs(data TEXT);'); db.close();
  const marker = new DatabaseSync(join(directory, 'engine.sqlite.effects.sqlite'));
  marker.exec('CREATE TABLE command_execution(id INTEGER PRIMARY KEY, owner_pid INTEGER, group_pid INTEGER, active INTEGER, updated_at TEXT); INSERT INTO command_execution VALUES(1,1,NULL,1,\'controlled\');');
  marker.close();
  const capture = await captureDesktopNativeEvidence({ sourceDirectory: directory, phase: 'after-close' });
  assert.deepEqual(capture.sqlite.find(item => item.nativeCoverage === 'execution-lock').records.executionLock, { available: true, active: true });
  assert.equal(qualifyDesktopNativeCleanup(capture), false);
  assert.equal(aggregateFixtureCleanup({ mainReceipt: receipt(), nativeConfirmed: qualifyDesktopNativeCleanup(capture) }).state, 'unconfirmed');
  assert.equal(JSON.stringify(capture).includes('owner_pid'), false);
});
