import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), yaml = require('js-yaml');
const directory = resolve('release'), entries = await readdir(directory);
const metadataName = { darwin: 'latest-mac.yml', linux: 'latest-linux.yml', win32: 'latest.yml' }[process.platform];
if (!metadataName) throw new Error('Unsupported release OS.');
const metadata = yaml.load(await readFile(join(directory, metadataName), 'utf8'));
if (!metadata || typeof metadata.version !== 'string' || !Array.isArray(metadata.files) || metadata.files.length < 1 || metadata.files.length > 8) throw new Error('Invalid release metadata.');
const digests = [];
for (const file of metadata.files) {
  if (typeof file.url !== 'string' || basename(file.url) !== file.url || file.url.includes('\\') || typeof file.sha512 !== 'string') throw new Error('Release metadata must reference local artifact basenames.');
  const path = join(directory, file.url);
  if (!(await stat(path)).isFile()) throw new Error('Release artifact is unavailable.');
  const bytes = await readFile(path), digest = createHash('sha512').update(bytes).digest('base64');
  if (digest !== file.sha512 || (file.size !== undefined && file.size !== bytes.length)) throw new Error('Release artifact checksum does not match its metadata.');
  digests.push({ artifact: file.url, bytes: bytes.length, sha512: digest });
}
function check(command, args, environment = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: environment });
  if (result.error || result.status !== 0) throw new Error(`${command} release verification failed.`);
}
let signature;
if (process.platform === 'darwin') {
  const folder = entries.find(name => /^mac(?:-|$)/u.test(name));
  if (!folder) throw new Error('The macOS release bundle is missing.');
  const bundle = join(directory, folder, 'Moodcode.app');
  check('codesign', ['--verify', '--deep', '--strict', bundle]);
  check('spctl', ['--assess', '--type', 'execute', bundle]);
  check('xcrun', ['stapler', 'validate', bundle]);
  signature = { platform: 'macOS', codesign: 'verified', gatekeeper: 'accepted', notarizationStaple: 'verified' };
} else if (process.platform === 'win32') {
  const installer = metadata.files.find(file => file.url.endsWith('.exe'));
  if (!installer || !process.env.MOODCODE_WINDOWS_PUBLISHER_NAME) throw new Error('A Windows installer and its expected publisher are required.');
  check('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:MOODCODE_VERIFY_RELEASE_ARTIFACT; if ($s.Status -ne 'Valid') {exit 3}; $subject=$s.SignerCertificate.Subject; $expected=$env:MOODCODE_WINDOWS_PUBLISHER_NAME; if ($expected.StartsWith('CN=')) {if ($subject -ne $expected) {exit 4}} else {if ($subject -notmatch '^CN=([^,]+)' -or $Matches[1] -ne $expected) {exit 5}}"],
    { ...process.env, MOODCODE_VERIFY_RELEASE_ARTIFACT: join(directory, installer.url) });
  signature = { platform: 'Windows', authenticode: 'verified', publisher: 'matched' };
} else {
  signature = { platform: 'Linux', codeSignature: 'not-provided-by-electron-builder-v26', integrity: 'SHA512', transport: 'configured-GitHub-HTTPS' };
}
const evidence = { schemaVersion: 1, ok: true, version: metadata.version, channel: 'stable', digests, signature, published: false,
  installedUserApplication: false };
await mkdir('artifacts/desktop-release', { recursive: true });
await writeFile('artifacts/desktop-release/verification.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
