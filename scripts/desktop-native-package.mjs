import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const WINDOWS_NATIVE_PACKAGE = '@moodcode/windows-job';
export const WINDOWS_NATIVE_BINARY = 'build/Release/windows_job.node';
export const DESKTOP_ELECTRON_VERSION = '44.5.1';

/** A missing integration permits a portable bundle; an incompatible integration fails packaging. */
export function windowsNativeBuildPlan({ arch, electronVersion, nativeManifest, engineManifest }) {
  assert.ok(['x64', 'arm64'].includes(arch), 'Unsupported Windows native package architecture.');
  assert.equal(electronVersion, DESKTOP_ELECTRON_VERSION, 'Requalify the Windows package contract before changing Electron.');
  assert.equal(nativeManifest.name, WINDOWS_NATIVE_PACKAGE, 'The native workspace package identity differs.');
  assert.equal(nativeManifest.version, '0.1.0', 'The native workspace package version differs.');
  assert.equal(engineManifest.dependencies?.[WINDOWS_NATIVE_PACKAGE], nativeManifest.version,
    'The engine must declare the integrated Windows workspace as a production dependency.');
  return ['packages/windows-job/scripts/build.mjs', '--runtime=electron', `--target=${electronVersion}`, `--arch=${arch}`];
}

export function verifyWindowsBinaryArchitecture(bytes, arch) {
  assert.ok(bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d, 'Windows native binary is not a PE file.');
  const pe = bytes.readUInt32LE(0x3c);
  assert.ok(pe <= bytes.length - 6 && bytes.readUInt32LE(pe) === 0x00004550, 'Windows native binary has an invalid PE header.');
  assert.equal(bytes.readUInt16LE(pe + 4), { x64: 0x8664, arm64: 0xaa64 }[arch], 'Windows native binary architecture differs from the package target.');
}

export async function prepareWindowsNativePackage({ arch, run, root = resolve('.'), platform = process.platform }) {
  if (platform !== 'win32') return;
  const receipt = join(root, 'apps/desktop/dist/main/windows-native-build.json');
  const workspace = join(root, 'packages/windows-job');
  if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) {
    await rm(receipt, { force: true });
    console.log(JSON.stringify({ phase: 'windows-native-package', status: 'external-integration-required',
      package: WINDOWS_NATIVE_PACKAGE, nativeAcceptance: false }));
    return;
  }
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const [nativeManifest, engineManifest, electronManifest] = await Promise.all([
    readFile(join(workspace, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'packages/engine/package.json'), 'utf8').then(JSON.parse),
    readFile(require.resolve('electron/package.json'), 'utf8').then(JSON.parse),
  ]);
  const args = windowsNativeBuildPlan({ arch, electronVersion: electronManifest.version, nativeManifest, engineManifest });
  assert.equal(await realpath(require.resolve(WINDOWS_NATIVE_PACKAGE)), await realpath(join(workspace, 'index.js')),
    'Install the integrated Windows workspace through the locked dependency graph before packaging.');
  run(process.execPath, args);
  const bytes = await readFile(join(workspace, WINDOWS_NATIVE_BINARY));
  verifyWindowsBinaryArchitecture(bytes, arch);
  await writeFile(receipt, `${JSON.stringify({ schemaVersion: 1, package: `${WINDOWS_NATIVE_PACKAGE}@${nativeManifest.version}`,
    runtime: 'electron', electronVersion: electronManifest.version, arch, bindingVersion: 1, nodeApi: 8,
    packageRelativeBinary: WINDOWS_NATIVE_BINARY, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    actualWindowsUtilityVerified: false }, null, 2)}\n`);
}
