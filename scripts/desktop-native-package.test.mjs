import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { windowsNativeBuildPlan, verifyWindowsBinaryArchitecture, prepareWindowsNativePackage, readWindowsNativeBuildReceipt } from './desktop-native-package.mjs';

test('Windows packaging targets the qualified Electron headers and requires the native production dependency', () => {
  const input = { arch: 'x64', electronVersion: '44.5.1', nativeManifest: { name: '@moodcode/windows-job', version: '0.1.0' },
    engineManifest: { dependencies: { '@moodcode/windows-job': '0.1.0' } } };
  assert.deepEqual(windowsNativeBuildPlan(input), ['packages/windows-job/scripts/build.mjs', '--runtime=electron', '--target=44.5.1', '--arch=x64']);
  assert.throws(() => windowsNativeBuildPlan({ ...input, engineManifest: { optionalDependencies: input.engineManifest.dependencies } }));
  assert.throws(() => windowsNativeBuildPlan({ ...input, electronVersion: '45.0.0' }));
  assert.throws(() => windowsNativeBuildPlan({ ...input, arch: 'ia32' }));
});

test('native binary architecture is checked against the package target before inclusion', () => {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68);
  verifyWindowsBinaryArchitecture(bytes, 'x64');
  assert.throws(() => verifyWindowsBinaryArchitecture(bytes, 'arm64'));
  bytes.writeUInt32LE(1024, 0x3c);
  assert.throws(() => verifyWindowsBinaryArchitecture(bytes, 'x64'));
});

test('absent Windows integration removes stale native receipts and never invokes a build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/desktop/dist/main'), { recursive: true });
  const receipt = join(root, 'apps/desktop/dist/main/windows-native-build.json');
  await writeFile(receipt, '{"actualWindowsUtilityVerified":true}');
  let builds = 0;
  await prepareWindowsNativePackage({ root, platform: 'win32', arch: 'x64', run() { builds++; } });
  assert.equal(builds, 0);
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
});

test('the native receipt is read from its exact nested path in a real ASAR on the current OS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-native-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), receiptPath = join(source, 'dist', 'main', 'windows-native-build.json');
  await mkdir(join(source, 'dist', 'main'), { recursive: true });
  const receipt = { schemaVersion: 1, runtime: 'electron', electronVersion: '44.5.1', arch: process.arch,
    bindingVersion: 1, nodeApi: 8, packageRelativeBinary: 'build/Release/windows_job.node', bytes: 128, sha256: 'a'.repeat(64) };
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(join(source, 'windows-native-build.json'), '{"wrongLocation":true}');
  const archive = join(root, 'valid.asar');
  await createPackage(source, archive);
  assert.deepEqual(readWindowsNativeBuildReceipt(archive), receipt);

  await rm(receiptPath);
  const missing = join(root, 'missing.asar');
  await createPackage(source, missing);
  assert.throws(() => readWindowsNativeBuildReceipt(missing), 'A receipt at another path must not satisfy the native gate.');

  await writeFile(receiptPath, '{invalid receipt');
  const invalid = join(root, 'invalid.asar');
  await createPackage(source, invalid);
  assert.throws(() => readWindowsNativeBuildReceipt(invalid), SyntaxError);
});
