import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoleResourceInput, RoleResourcePolicySnapshot } from './role-resources.js';
import { RoleResourcePolicyRegistry } from './role-policy-registry.js';

const allowed: RoleResourcePolicySnapshot = { revision: 7, rules: [{ id: 'internal', roleId: 'editor', effect: 'state', resource: { kind: 'all' }, decision: 'allow' }] };
test('registry uses an independent CAS generation and immutable policy copies', () => {
  const snapshot = structuredClone(allowed), registry = new RoleResourcePolicyRegistry(snapshot), first = registry.capture();
  assert.equal(registry.revision, 1); assert.equal(first.policyRevision, 7); assert.strictEqual(registry.capture(), first); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.policy.rules));
  snapshot.rules[0]!.decision = 'deny'; assert.equal(first.policy.rules[0]!.decision, 'allow');
  const second = registry.replace(1, allowed); assert.equal(second.registryRevision, 2); assert.equal(second.policyRevision, 7); assert.equal(second.policySha256, first.policySha256); assert.equal(second.registryId, first.registryId); assert.notStrictEqual(second.policy, first.policy);
  assert.throws(() => registry.assertCurrent(first), { code: 'ROLE_POLICY_REGISTRY_STALE' }); registry.assertCurrent(second);
  assert.throws(() => registry.replace(1, { revision: 100, rules: [] }), { code: 'ROLE_POLICY_REGISTRY_CONFLICT' }); assert.strictEqual(registry.capture(), second);
});

test('captures cannot be cloned, forged, borrowed from another registry or inspected through proxies', () => {
  const registry = new RoleResourcePolicyRegistry(allowed), other = new RoleResourcePolicyRegistry(allowed), capture = registry.capture();
  assert.throws(() => structuredClone(capture), { name: 'DataCloneError' });
  for (const foreign of [{ ...capture }, JSON.parse(JSON.stringify(capture)), other.capture()]) assert.throws(() => registry.assertCurrent(foreign), { code: 'ROLE_POLICY_REGISTRY_STALE' });
  let traps = 0; const proxy = new Proxy(capture, { get() { traps++; throw new Error('must not inspect'); }, getPrototypeOf() { traps++; throw new Error('must not inspect'); } });
  assert.throws(() => registry.assertCurrent(proxy), { code: 'ROLE_POLICY_REGISTRY_STALE' }); assert.equal(traps, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.throws(() => registry.assertCurrent(revoked.proxy as typeof capture), { code: 'ROLE_POLICY_REGISTRY_STALE' });
});

test('malformed replacement and stale CAS leave the active policy and generation unchanged', () => {
  const registry = new RoleResourcePolicyRegistry(allowed), capture = registry.capture(); let reads = 0;
  const accessor = { rules: [] }; Object.defineProperty(accessor, 'revision', { enumerable: true, get() { reads++; return 8; } });
  assert.throws(() => registry.replace(1, accessor as unknown as RoleResourcePolicySnapshot), { code: 'INVALID_ROLE_RESOURCE' }); assert.equal(reads, 0);
  assert.throws(() => registry.replace(1, { revision: 8, rules: Array.from({ length: 129 }, (_, index) => ({ ...allowed.rules[0]!, id: String(index) })) }), { code: 'ROLE_RESOURCE_LIMIT' });
  for (const revision of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => registry.replace(revision, allowed), { code: 'INVALID_ROLE_POLICY_REVISION' });
  registry.assertCurrent(capture); assert.strictEqual(registry.capture(), capture);
});

test('an explicitly configured empty registry asks, and fresh policy owns new physical receipts', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-role-registry-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RoleResourcePolicyRegistry(), input: RoleResourceInput = { workspaceId: 'workspace', workspaceRoot: root, sessionId: 'session', roleId: 'editor', roleRevision: 'profile', toolName: 'internal', effect: 'state', mode: 'build', preparedFingerprint: 'producer', requiresApproval: false, baseDecision: { decision: 'allow', version: 7, reason: 'state effect' }, resources: [] };
  const initial = registry.capture(), receipt = await initial.policy.evaluate(input); assert.equal(receipt.decision, 'ask'); assert.equal(receipt.reason, 'no_role_allowance');
  const fresh = registry.replace(1, allowed); await assert.rejects(fresh.policy.assertCurrent(receipt, input), { code: 'ROLE_RESOURCE_STALE' });
  const allowedReceipt = await fresh.policy.evaluate(input); assert.equal(allowedReceipt.decision, 'allow'); await fresh.policy.assertCurrent(allowedReceipt, input);
  await assert.rejects(fresh.policy.assertCurrent(structuredClone(allowedReceipt), input), { code: 'ROLE_RESOURCE_STALE' });
  assert.throws(() => registry.assertCurrent(initial), { code: 'ROLE_POLICY_REGISTRY_STALE' });
});
