import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalKnowledge, immutableKnowledgeJson, knowledgeHash, sha256 } from '../knowledge/validation.js';
import { canonicalJson, canonicalSha256, jsonTextSha256, reseal, sameCanonical, sealRecord, sha256Hex, verifySealed } from './canonical.js';

const nested = { z: 1, a: [true, null, { y: 'é "\\', b: -0 }], m: { c: 0.1, b: 1e21, a: 'x' } };
const binding = { workspaceId: 'workspace', root: '/tmp/root', rootDevice: '16777232', rootInode: '123456', storageBindingSha256: 'a'.repeat(64) };

test('canonical and JSON-text digests keep the bytes persisted before the shared module', () => {
  assert.equal(canonicalJson(nested), '{"a":[true,null,{"b":0,"y":"é \\"\\\\"}],"m":{"a":"x","b":1e+21,"c":0.1},"z":1}');
  assert.equal(canonicalSha256(nested), '267f985cd1169c6dea2befa07a5beb570ea7f9da67be406f0c6b8ad09f36f859');
  assert.equal(canonicalSha256(binding), 'c9a245363f37bd5919f63437243e055d2e5ad7be1d0557871c3f24e8c4fc0b73');
  assert.equal(canonicalJson({ b: undefined, a: 1 }), '{"a":1,"b":undefined}');
  assert.equal(canonicalSha256({ b: undefined, a: 1 }), '420b9e400f5632d0d1dabe16b70130f95a1cc325ee108b2c121c9e96dbd772a5');
  assert.equal(canonicalJson([1, undefined, 'two']), '[1,,"two"]');
  assert.equal(canonicalSha256('plain text'), '86696ae0a7dd4789bb5a8256f0a58a13243fe65bafb37c44f3c73e2228fd78b7');
  assert.equal(sha256Hex('Host-authored trusted instructions.\n'), 'c71c6483db197694206cdf336cb2500b78bbc1ba38ff402a1b37bfb4f8d7f117');
  assert.equal(sha256Hex(Buffer.from('plain text')), sha256Hex('plain text'));
  assert.equal(jsonTextSha256(nested), '7c7e9bc73e4d1199b5e761cf6f56f6cd749388dc7ed61e5c7a7603bbce856af4');
  assert.equal(jsonTextSha256(binding), '80a529295c42ef4fd5108de4082ecd406275f8b36c7a9e757a40587acfd77039');
  assert.equal(canonicalKnowledge, canonicalJson); assert.equal(knowledgeHash, canonicalSha256); assert.equal(sha256, sha256Hex);
});

test('an onUndefined callback rejects non-JSON values at any depth without changing other bytes', () => {
  const rejected = () => { throw new Error('not json'); };
  assert.equal(canonicalJson(nested, rejected), canonicalJson(nested));
  assert.equal(canonicalJson([[1, 'two'], { b: [null] }], rejected), '[[1,"two"],{"b":[null]}]');
  for (const value of [undefined, [1, undefined], { a: { b: undefined } }, [{ c: () => 1 }], Symbol('s')]) assert.throws(() => canonicalJson(value, rejected), /not json/u);
});

test('sealing replaces a stale digest and verification rejects any other body', () => {
  const first = sealRecord({ id: 'record', revision: 1 }), next = sealRecord({ ...first, revision: 2 }, sealed => Object.freeze(sealed));
  assert.equal(first.sha256, canonicalSha256({ id: 'record', revision: 1 }));
  assert.equal(next.sha256, canonicalSha256({ id: 'record', revision: 2 }));
  assert.deepEqual(Object.keys(next), ['id', 'revision', 'sha256']); assert.ok(Object.isFrozen(next));
  assert.equal(verifySealed(next, () => assert.fail('a freshly sealed record must verify')), next);
  const mismatch = () => { throw new Error('mismatch'); };
  assert.throws(() => verifySealed({ ...next, revision: 3 }, mismatch), /mismatch/);
  assert.throws(() => verifySealed({ id: 'record', revision: 2 }, mismatch), /mismatch/);
  assert.ok(sameCanonical({ a: 1, b: [2] }, { b: [2], a: 1 })); assert.ok(!sameCanonical({ a: 1 }, { a: '1' }));
});

test('reseal writes the same bytes as the hand-written patch-and-rehash it replaces', () => {
  const record = sealRecord({ id: 'generation', state: 'running', revision: 1, nested: { b: 2, a: 1 } });
  const { sha256: _old, ...body } = record, patch = { state: 'completed', revision: 2, completedAt: '2026-10-11T00:00:00.000Z' };
  const legacy = immutableKnowledgeJson({ ...body, ...patch, sha256: knowledgeHash({ ...body, ...patch }) });
  const next = reseal(record, patch, immutableKnowledgeJson);
  assert.equal(JSON.stringify(next), JSON.stringify(legacy));
  assert.equal(JSON.stringify(next), '{"id":"generation","state":"completed","revision":2,"nested":{"b":2,"a":1},"completedAt":"2026-10-11T00:00:00.000Z","sha256":"9bc5ae7f7cc9e1a5e690b9c3c1001837ba1566504e24c40279046256bbaea008"}');
  assert.equal(verifySealed(next, () => assert.fail('a resealed record must verify')), next);
  assert.equal(record.state, 'running');
});
