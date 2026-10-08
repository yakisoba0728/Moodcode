import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'moodcode-real-updater-'));
try {
  const result = spawnSync(require('electron'), [resolve('scripts/desktop-update-fixture.cjs'), root], {
    stdio: 'inherit', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(root, { recursive: true, force: true }); }
