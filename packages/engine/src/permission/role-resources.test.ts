import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleResourcePolicy, ROLE_RESOURCE_LIMITS, type RoleResourceInput, type RoleResourceRule } from './role-resources.js';

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-role-resource-'))), root = join(base, 'workspace');
  await mkdir(root); await mkdir(join(root, 'src')); await mkdir(join(root, 'private')); await writeFile(join(root, 'src', 'a.ts'), 'a'); await writeFile(join(root, 'private', 'key'), 'private');
  t.after(() => rm(base, { recursive: true, force: true }));
  const input: RoleResourceInput = { workspaceId: 'workspace', workspaceRoot: root, sessionId: 'session', roleId: 'editor', roleRevision: 'profile-1', toolName: 'read_file', effect: 'read', mode: 'build', preparedFingerprint: 'producer-fingerprint', requiresApproval: false, baseDecision: { decision: 'allow', version: 1, reason: 'read effect' }, resources: [{ kind: 'file', path: 'src/a.ts' }] };
  return { base, root, input };
}
function rule(id: string, decision: 'allow' | 'ask' | 'deny', path = '.', descendants = true): RoleResourceRule { return { id, roleId: 'editor', resource: { kind: 'file', path, descendants }, decision }; }
function policy(rules: readonly RoleResourceRule[] = [rule('read-source', 'allow', 'src')]) { return new RoleResourcePolicy({ revision: 1, rules }); }

test('role receipt pins scope and physical path; only all covered resources are allowed', async t => {
  const { input } = await fixture(t); const roles = policy(); const receipt = await roles.evaluate(input);
  assert.equal(receipt.decision, 'allow'); assert.equal(receipt.reason, 'role_allowed'); assert.equal(receipt.resources[0]!.kind, 'file');
  assert.equal((receipt.resources[0] as { canonicalPath: string }).canonicalPath, 'src/a.ts'); assert.deepEqual(receipt.matchedRules, [{ id: 'read-source', resourceIndex: 0, decision: 'allow' }]);
  await roles.assertCurrent(receipt, structuredClone(input));
  assert.equal((await roles.evaluate({ ...input, resources: [...input.resources, { kind: 'file', path: 'private/key' }] })).decision, 'ask');
  assert.equal((await roles.evaluate({ ...input, resources: [] })).decision, 'ask');
  const all = policy([{ id: 'all-internal', roleId: 'editor', effect: 'state', resource: { kind: 'all' }, decision: 'allow' }]);
  assert.equal((await all.evaluate({ ...input, effect: 'state', resources: [] })).decision, 'allow');
});

test('deny dominates conflicting rules, legacy policy, prepared requirements and plan effects', async t => {
  const { input } = await fixture(t); const roles = policy([rule('all', 'allow'), rule('private', 'deny', 'src'), rule('review', 'ask', 'src')]);
  assert.equal((await roles.evaluate(input)).decision, 'deny');
  const allowed = policy([rule('all', 'allow')]);
  const baseDenied = await allowed.evaluate({ ...input, baseDecision: { decision: 'deny', version: 1, reason: 'configured denial' } });
  assert.equal(baseDenied.reason, 'base_denied'); assert.equal(baseDenied.decision, 'deny');
  const baseAsk = await allowed.evaluate({ ...input, baseDecision: { decision: 'ask', version: 1, reason: 'prepared requirement' } });
  assert.equal(baseAsk.decision, 'ask'); assert.equal(baseAsk.reason, 'base_approval_required');
  const preparedAsk = await allowed.evaluate({ ...input, requiresApproval: true }); assert.equal(preparedAsk.decision, 'ask'); assert.equal(preparedAsk.reason, 'prepared_approval_required');
  assert.equal((await allowed.evaluate({ ...input, effect: 'write', mode: 'plan' })).decision, 'deny');
  assert.equal((await allowed.evaluate({ ...input, effect: 'state', mode: 'plan' })).decision, 'allow');
  assert.equal((await allowed.evaluate({ ...input, effect: 'unknown' })).reason, 'unknown_effect');
});

test('unknown resources, unmatched role/tool/effect and explicit ask cannot become allowance', async t => {
  const { input } = await fixture(t); const roles = policy([{ ...rule('source', 'allow', 'src'), toolName: 'read_file', effect: 'read' }]);
  for (const changed of [{ roleId: 'reviewer' }, { toolName: 'another_tool' }, { effect: 'write' as const }]) assert.equal((await roles.evaluate({ ...input, ...changed })).decision, 'ask');
  assert.equal((await policy([rule('all', 'allow')]).evaluate({ ...input, resources: [{ kind: 'unknown', label: 'opaque remote command effects' }] })).reason, 'unknown_resource');
  assert.equal((await policy([rule('allow', 'allow'), rule('ask', 'ask')]).evaluate(input)).reason, 'role_approval_required');
});

test('MCP authority is exact server, connection, catalogue revision and URI', async t => {
  const { input } = await fixture(t); const mcp = { kind: 'mcp' as const, serverId: 'server', connectionId: 'connection', catalogueRevision: 3, uri: 'custom://record?id=one' };
  const roles = policy([{ id: 'read-mcp', roleId: 'editor', resource: mcp, decision: 'allow' }]); const exact = { ...input, resources: [mcp] };
  const receipt = await roles.evaluate(exact); assert.equal(receipt.decision, 'allow'); await roles.assertCurrent(receipt, exact);
  for (const changed of [{ serverId: 'other' }, { connectionId: 'next' }, { catalogueRevision: 4 }, { uri: 'custom://record?id=two' }]) {
    const current = { ...input, resources: [{ ...mcp, ...changed }] };
    assert.equal((await roles.evaluate(current)).decision, 'ask'); await assert.rejects(roles.assertCurrent(receipt, current), { code: 'ROLE_RESOURCE_STALE' });
  }
});

test('physical symlink target is required for allow; alias and physical deny both dominate', async t => {
  const { root, input } = await fixture(t); await symlink('../private', join(root, 'src', 'alias'));
  const alias = { ...input, resources: [{ kind: 'file' as const, path: 'src/alias/key' }] };
  const sourceOnly = await policy().evaluate(alias); assert.equal(sourceOnly.decision, 'ask'); assert.equal((sourceOnly.resources[0] as { canonicalPath: string }).canonicalPath, 'private/key');
  assert.equal((await policy([rule('all', 'allow'), rule('private', 'deny', 'private')]).evaluate(alias)).decision, 'deny');
  assert.equal((await policy([rule('all', 'allow'), rule('alias', 'deny', 'src/alias')]).evaluate(alias)).decision, 'deny');
  assert.equal((await policy([rule('private', 'allow', 'private')]).evaluate(alias)).decision, 'allow');
});

test('outside, dangling and noncanonical file paths fail before a decision', async t => {
  const { base, root, input } = await fixture(t); await mkdir(join(base, 'outside')); await writeFile(join(base, 'outside', 'data'), 'outside');
  await symlink(join(base, 'outside'), join(root, 'escape')); await symlink(join(base, 'missing'), join(root, 'dangling'));
  await assert.rejects(policy().evaluate({ ...input, resources: [{ kind: 'file', path: 'escape/data' }] }), { code: 'ROLE_PATH_OUTSIDE_WORKSPACE' });
  await assert.rejects(policy().evaluate({ ...input, resources: [{ kind: 'file', path: 'dangling/new' }] }), { code: 'ENOENT' });
  for (const path of ['../outside', '/outside', 'src/../private/key', './src/a.ts', 'src//a.ts', 'src\\a.ts', 'C:/outside', 'src/a.ts:stream', Array.from({ length: 129 }, () => 'a').join('/')]) await assert.rejects(policy().evaluate({ ...input, resources: [{ kind: 'file', path }] }), { code: 'INVALID_ROLE_RESOURCE_PATH' });
});

test('new path pins nearest physical parent and becomes stale when that parent changes', async t => {
  const { root, input } = await fixture(t); const roles = policy(); const current = { ...input, resources: [{ kind: 'file' as const, path: 'src/new/sub/file.ts' }] };
  const receipt = await roles.evaluate(current); assert.equal(receipt.decision, 'allow'); await roles.assertCurrent(receipt, current);
  await mkdir(join(root, 'src', 'new')); await assert.rejects(roles.assertCurrent(receipt, current), { code: 'ROLE_RESOURCE_STALE' });
});

test('workspace movement, replaced target and changed request scope invalidate receipts', async t => {
  const { base, root, input } = await fixture(t); const roles = policy(); const receipt = await roles.evaluate(input);
  for (const change of [{ workspaceId: 'other' }, { sessionId: 'other' }, { roleRevision: 'profile-2' }, { preparedFingerprint: 'other' }, { baseDecision: { ...input.baseDecision, version: 2 } }]) await assert.rejects(roles.assertCurrent(receipt, { ...input, ...change }), { code: 'ROLE_RESOURCE_STALE' });
  await assert.rejects(policy().assertCurrent(receipt, input), { code: 'ROLE_RESOURCE_STALE' });
  await assert.rejects(roles.assertCurrent(structuredClone(receipt), input), { code: 'ROLE_RESOURCE_STALE' });
  await rename(join(root, 'src', 'a.ts'), join(root, 'src', 'old.ts')); await writeFile(join(root, 'src', 'a.ts'), 'new');
  await assert.rejects(roles.assertCurrent(receipt, input), { code: 'ROLE_RESOURCE_STALE' });
  const fresh = await roles.evaluate(input); await rename(root, join(base, 'moved')); await mkdir(root); await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.ts'), 'a');
  await assert.rejects(roles.assertCurrent(fresh, input), { code: 'ROLE_RESOURCE_STALE' });
});

test('policy/input/receipt snapshots are immutable and input changes cannot race evaluation', async t => {
  const { input } = await fixture(t); const rules = [rule('source', 'allow', 'src')]; const roles = policy(rules); rules[0]!.decision = 'deny';
  const pending = roles.evaluate(input); input.roleId = 'other'; const receipt = await pending;
  assert.equal(receipt.roleId, 'editor'); assert.equal(receipt.decision, 'allow'); assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.resources)); assert.ok(Object.isFrozen(roles.rules[0]));
  assert.throws(() => { (receipt.resources as unknown[]).push({}); }, TypeError);
});

test('malformed rules/resources, duplicate IDs, limits and cancellation fail closed', async t => {
  const { input } = await fixture(t);
  assert.throws(() => new RoleResourcePolicy({ revision: 0, rules: [] }), { code: 'INVALID_ROLE_RESOURCE' });
  assert.throws(() => policy([rule('same', 'allow'), rule('same', 'deny')]), { code: 'INVALID_ROLE_RESOURCE' });
  assert.throws(() => policy(Array.from({ length: ROLE_RESOURCE_LIMITS.maxRules + 1 }, (_, index) => rule(`rule-${index}`, 'allow'))), { code: 'ROLE_RESOURCE_LIMIT' });
  await assert.rejects(policy().evaluate({ ...input, resources: Array.from({ length: ROLE_RESOURCE_LIMITS.maxResources + 1 }, () => ({ kind: 'file', path: '.' })) }), { code: 'ROLE_RESOURCE_LIMIT' });
  await assert.rejects(policy().evaluate({ ...input, resources: [{ kind: 'file', path: '.', authority: 'trusted' } as never] }), { code: 'INVALID_ROLE_RESOURCE' });
  const many = policy(Array.from({ length: 128 }, (_, index) => rule(`rule-${index}`, 'allow')));
  await assert.rejects(many.evaluate({ ...input, resources: Array.from({ length: 32 }, () => ({ kind: 'file', path: '.' })) }), { code: 'ROLE_RESOURCE_LIMIT' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(policy().evaluate(input, controller.signal), { code: 'CANCELLED' });
});

test('typed host records reject accessors, proxies, sparse arrays and hidden metadata without executing traps', async t => {
  const { input } = await fixture(t); let calls = 0;
  const getter = { kind: 'file' }; Object.defineProperty(getter, 'path', { enumerable: true, get() { calls++; return 'src/a.ts'; } });
  const proxy = new Proxy({}, { get() { calls++; return 'file'; }, getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
  const array = [{ kind: 'file', path: 'src/a.ts' }]; Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return getter; } });
  const hidden = { kind: 'file', path: 'src/a.ts' }; Object.defineProperty(hidden, 'hidden', { value: 'undeclared', enumerable: false });
  for (const resources of [[getter], [proxy], array, new Array(1), [hidden], new Proxy([], { get() { calls++; return 0; } })]) await assert.rejects(policy().evaluate({ ...input, resources: resources as never }), { code: 'INVALID_ROLE_RESOURCE' });
  const badInput = { ...input }; Object.defineProperty(badInput, 'roleId', { enumerable: true, get() { calls++; return 'editor'; } }); await assert.rejects(policy().evaluate(badInput), { code: 'INVALID_ROLE_RESOURCE' });
  const badRule = rule('source', 'allow'); Object.defineProperty(badRule, 'id', { enumerable: true, get() { calls++; return 'source'; } }); assert.throws(() => policy([badRule]), { code: 'INVALID_ROLE_RESOURCE' });
  assert.equal(calls, 0);
});
