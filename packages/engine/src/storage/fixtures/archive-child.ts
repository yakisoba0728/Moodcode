import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [mode, source, destination, phase] = process.argv.slice(2);
if (!source || !destination || !['export', 'import'].includes(mode!)) throw new Error('Invalid archive fixture arguments');
function stop(detail: { phase: string; path: string }): void {
  process.send?.(detail);
  // The parent controls this fixture process only; no engine/command process is signalled.
  process.kill(process.pid, 'SIGSTOP');
}
const originalMkdtemp = fs.mkdtempSync, originalRename = fs.renameSync;
fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
  const path = originalMkdtemp(...args);
  if (phase === 'staging' && typeof path === 'string' && path.includes('.moodcode-archive-')) stop({ phase: 'staging', path });
  return path;
}) as typeof fs.mkdtempSync;
fs.renameSync = ((from, to) => {
  if (phase === 'publish' && String(from).includes('.moodcode-import-')) stop({ phase: 'publish', path: String(to) });
  return originalRename(from, to);
}) as typeof fs.renameSync;
syncBuiltinESMExports();
const archive = await import('../archive.js');
if (mode === 'export') await archive.exportEngineArchive({ dbPath: join(source, 'engine.sqlite'), artifactDir: join(source, 'artifacts'), destination });
else await archive.importEngineArchive({ directory: source, destination });
