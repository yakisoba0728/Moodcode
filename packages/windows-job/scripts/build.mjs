import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The Windows Job Object binary must be built on Windows.');
const require = createRequire(import.meta.url);
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--(runtime|target|arch)=([^\s]+)$/.exec(argument);
  if (!match || options.has(match[1])) throw new Error(`Invalid build option: ${argument}`);
  options.set(match[1], match[2]);
}
const runtime = options.get('runtime') ?? 'node';
if (!['node', 'electron'].includes(runtime)) throw new Error('Build runtime must be node or electron.');
if (runtime === 'electron' && !options.has('target')) throw new Error('An Electron build requires its exact --target version.');
const arch = options.get('arch') ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Build arch must be x64 or arm64.');
const args = [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`];
if (options.has('target')) args.push(`--target=${options.get('target')}`);
if (runtime === 'electron') args.push('--dist-url=https://electronjs.org/headers');
const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`node-gyp failed (${result.status ?? result.signal}).`);
