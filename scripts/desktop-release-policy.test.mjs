import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseRequirements, rollbackReleasePlan } from './desktop-release-policy.mjs';
test('release preflight reports credential names only and enforces actual signing/notarization inputs', () => {
  assert.deepEqual(releaseRequirements('darwin', {}), ['CSC_LINK', 'CSC_KEY_PASSWORD', 'Apple notarization credentials']);
  assert.deepEqual(releaseRequirements('win32', {}), ['WIN_CSC_LINK or CSC_LINK', 'Windows certificate password', 'MOODCODE_WINDOWS_PUBLISHER_NAME']);
  assert.deepEqual(releaseRequirements('darwin', { CSC_LINK: 'private-certificate', CSC_KEY_PASSWORD: 'private-password', APPLE_API_KEY: 'private-key', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' }), []);
  assert.deepEqual(releaseRequirements('linux', {}), []);
});
test('rollback reuses a verified good source at a higher stable version and never enables publishing', () => {
  const source = 'a'.repeat(40);
  const plan = rollbackReleasePlan({ installedVersion: '1.2.3', rollbackVersion: '1.2.4', goodCommit: source });
  assert.equal(plan.sourceCommit, source); assert.equal(plan.version, '1.2.4'); assert.equal(plan.publishing, 'disabled');
  for (const value of ['1.2.3', '1.2.2', '0.9.9', '1.2.4-beta.1']) assert.throws(() => rollbackReleasePlan({ installedVersion: '1.2.3', rollbackVersion: value, goodCommit: source }));
  assert.throws(() => rollbackReleasePlan({ installedVersion: '1.2.3', rollbackVersion: '1.2.4', goodCommit: 'mutable-branch' }));
});
