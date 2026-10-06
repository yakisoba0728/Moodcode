import { createRequire } from 'node:module';
import { chmod, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// node-pty 1.1.0 ships macOS prebuilt spawn helpers without the execute bit.
// Keep this install repair explicit, limited to the selected optional package.
const require = createRequire(import.meta.url);
let packageDirectory;
try { packageDirectory = dirname(require.resolve('node-pty/package.json')); }
catch { process.stdout.write('Optional node-pty is unavailable; PTY capability remains disabled.\n'); process.exit(0); }
if (process.platform === 'darwin') {
  const helper = join(packageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  const info = await lstat(helper).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Optional PTY helper must be a regular file.');
    await chmod(helper, info.mode | 0o111);
  }
}
process.stdout.write('Optional PTY helper preparation completed.\n');
