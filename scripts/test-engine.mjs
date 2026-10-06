import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projects = ['packages/contracts', 'packages/engine', 'apps/engine-harness'];
const build = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', ...projects], {
  cwd: root, stdio: 'inherit',
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}
const files = (await Promise.all(projects.map(project => collect(join(root, project, 'dist'))))).flat().sort();
if (!files.length) throw new Error('No engine tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
