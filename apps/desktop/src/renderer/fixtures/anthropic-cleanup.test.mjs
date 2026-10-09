import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDesktopTestDirectory } from '../../../../../scripts/desktop-test-evidence.mjs';
import { finishAnthropicFixture } from './anthropic-cleanup.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await createDesktopTestDirectory('anthropic-cleanup-fault');
  const original = join(directory, 'original-retained.bin');
  await writeFile(original, 'Retain this Original across a diagnostic rejection.\n', { mode: 0o600 });
  const before = sha(await readFile(original));
  let heldResponse;
  const server = createServer((_request, response) => { heldResponse = response; response.writeHead(200); response.write('held stream'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const incoming = await new Promise(resolve => get(`http://127.0.0.1:${server.address().port}`, resolve));
  incoming.on('error', () => {});
  const physicallyClosed = new Promise(resolve => incoming.on('close', resolve));
  return { directory, original, before, server, heldResponse, physicallyClosed };
}

for (const phase of ['main-utility-close', 'native-capture', 'evidence-preserve']) test(`${phase} rejection closes actual HTTP stream/server and preserves Original plus first GUI failure`, { timeout: 5_000 }, async t => {
  const f = await fixture(); const report = { status: 'failed', failure: 'first-gui-error', originalPreserved: true }; const output = join(f.directory, 'nested', 'report.json');
  let preserveAttempted = false;
  const result = await finishAnthropicFixture({ report, server: f.server, heldResponse: f.heldResponse, output, closeApplication: async () => {},
    diagnostics: ['main-utility-close', 'native-capture', 'evidence-preserve'].map(current => ({ phase: current, collect: async () => {
      if (current === 'evidence-preserve') preserveAttempted = true;
      if (current === phase) throw new Error('private diagnostic body must not enter report');
      if (current === 'native-capture') report.cleanup = { state: 'confirmed', nativeConfirmed: true, utilityAcknowledged: true, utilityExitObserved: true };
    } })),
  });
  await f.physicallyClosed;
  assert.equal(f.server.address(), null); assert.equal(result.reportWritten, true); assert.equal(preserveAttempted, true);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(saved.status, 'failed'); assert.equal(saved.failure, 'first-gui-error'); assert.equal(saved.cleanup.state, 'unknown'); assert.equal(saved.cleanup.nativeConfirmed, null);
  assert.deepEqual(saved.diagnosticFailures, [{ phase, code: 'FIXTURE_FINALIZATION_FAILED' }]);
  assert.equal(JSON.stringify(saved).includes('private diagnostic body'), false); assert.equal(sha(await readFile(f.original)), f.before);
  t.diagnostic(JSON.stringify({ phase, original: f.original, sha256: f.before, report: output, physicalServerClosed: true, originalRetained: true }));
});

test('report write refusal still closes actual owned HTTP server and retains Original', { timeout: 5_000 }, async t => {
  const f = await fixture(); const report = { status: 'failed', failure: 'first-gui-error' };
  const result = await finishAnthropicFixture({ report, server: f.server, heldResponse: f.heldResponse, output: join(f.original, 'report.json'), closeApplication: async () => {}, diagnostics: [] });
  await f.physicallyClosed;
  assert.equal(f.server.address(), null); assert.equal(result.reportWritten, false); assert.equal(report.failure, 'first-gui-error');
  assert.deepEqual(report.diagnosticFailures, [{ phase: 'report-write', code: 'FIXTURE_FINALIZATION_FAILED' }]);
  assert.equal(report.cleanup.state, 'unknown'); assert.equal(sha(await readFile(f.original)), f.before);
  t.diagnostic(JSON.stringify({ phase: 'report-write', original: f.original, sha256: f.before, physicalServerClosed: true, reportWritten: false, originalRetained: true }));
});
