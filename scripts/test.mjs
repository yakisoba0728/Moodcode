import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
async function collect(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await collect(path));
    else if (entry.name.endsWith('.test.js')) result.push(path);
  }
  return result;
}
const files = (await Promise.all(['packages/contracts/dist','packages/engine/dist','apps/engine-harness/dist','apps/desktop/dist/types'].map(collect))).flat().sort();
if (!files.length) throw new Error('No compiled tests found');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
