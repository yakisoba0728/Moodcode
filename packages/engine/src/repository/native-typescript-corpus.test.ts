import assert from 'node:assert/strict';
import test from 'node:test';
import { LSP_NAVIGATION_LIMITS } from '../lsp/navigation.js';
import { REPOSITORY_CONTEXT_LIMITS } from './index.js';
import { nativeAvailable, runAuthoredNativeSemanticCorpus, runMoodcodeNativeSemanticProbes } from './fixtures/native-semantic-benchmark.js';

test('actual native TS7 resolves independent labels in a 512-module semantic corpus and measures bounded omissions/freshness/worktrees', { timeout: 120_000 }, async t => {
  if (!await nativeAvailable()) { t.skip('Pinned native TS7 executable is not installed on this platform'); return; }
  const observed = await runAuthoredNativeSemanticCorpus();
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.modules, 512); assert.ok(observed.disk.files >= 512); assert.equal(observed.disk.logicalFileBytes, observed.disk.sourceTextBytes);
  for (const probe of observed.probes) {
    assert.equal(probe.score.precision, 1, probe.id); assert.equal(probe.score.recall, 1, probe.id); assert.equal(probe.snapshot.complete, true, probe.id);
    assert.ok(probe.resultBytes <= REPOSITORY_CONTEXT_LIMITS.resultBytes); assert.ok(probe.elapsedMs >= 0); assert.ok(probe.hostRssBytesAfter > 0);
  }
  const bounded = observed.boundedReferences;
  assert.equal(bounded.score.expected, 81); assert.equal(bounded.score.precision, 1); assert.ok(bounded.score.recall > 0 && bounded.score.recall < 1);
  assert.ok(bounded.score.returned <= LSP_NAVIGATION_LIMITS.items); assert.equal(bounded.snapshot.complete, false);
  assert.ok(bounded.snapshot.observations[0]!.omitted.limits > 0); assert.ok(bounded.resultBytes <= REPOSITORY_CONTEXT_LIMITS.resultBytes);
  assert.equal(observed.outside.score.returned, 0); assert.ok(observed.outside.snapshot.observations[0]!.omitted.outsideWorkspace > 0); assert.equal(observed.outside.snapshot.complete, false);
  assert.equal(observed.ignored.score.returned, 0); assert.ok(observed.ignored.snapshot.observations[0]!.omitted.ignored > 0); assert.equal(observed.ignored.snapshot.complete, false);
  assert.equal(observed.ignoredSourceCode, 'REPOSITORY_PATH_IGNORED');
  assert.ok(observed.partial.snapshot.observations[0]!.items.some(item => item.name === 'survives'));
  assert.notEqual(observed.partialBuild.exitCode, 0); assert.equal(observed.partialBuild.missingAuthoredDependency, true);
  assert.deepEqual(observed.unsupported.snapshot.unsupportedPaths, ['unsupported.txt']); assert.equal(observed.unsupported.snapshot.complete, false);
  assert.equal(observed.edit.staleCode, 'REPOSITORY_SOURCE_STALE'); assert.equal(observed.edit.inputHashUnchanged, true); assert.equal(observed.edit.generationChanged, true);
  assert.equal(observed.edit.updated.score.precision, 1); assert.equal(observed.edit.updated.score.recall, 1);
  assert.ok(observed.edit.projectBefore); assert.ok(observed.edit.projectAfter); assert.notDeepEqual(observed.edit.projectBefore, observed.edit.projectAfter);
  assert.equal(observed.separation.rootDifferent, true); assert.equal(observed.separation.workspaceDifferent, true); assert.equal(observed.separation.branchDifferent, true);
  assert.equal(observed.separation.original.score.recall, 1); assert.equal(observed.separation.branch.score.recall, 1);
  assert.ok(['CANCELLED', 'ABORTED'].includes(observed.cancellation.code)); assert.equal(observed.cancellation.nativeStartDelta, 0);
  assert.equal(observed.cancellation.interruptedNativeRequestClaim, false);
  assert.ok(observed.cleanup.children.length >= 2); assert.ok(observed.cleanup.children.every(child => child.gone));
});

test('actual Moodcode authored callsites resolve to exact source declarations through the installed native TS7 server', { timeout: 120_000 }, async t => {
  if (!await nativeAvailable()) { t.skip('Pinned native TS7 executable is not installed on this platform'); return; }
  const observed = await runMoodcodeNativeSemanticProbes(); t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.probes.length, 2);
  for (const probe of observed.probes) { assert.equal(probe.score.precision, 1, probe.id); assert.equal(probe.score.recall, 1, probe.id); assert.equal(probe.snapshot.complete, true); }
  assert.ok(observed.cleanup.children.length >= 1); assert.ok(observed.cleanup.children.every(child => child.gone));
});
