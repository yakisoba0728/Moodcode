import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'moodcode-real-updater-'));
try {
  // This disposable SDK fixture has no renderer. Hosted Linux does not provide
  // a root-owned SUID helper; its explicit test launch uses the CLI switch.
  const fixtureArgs = [resolve('scripts/desktop-update-fixture.cjs'), root];
  if (process.platform === 'linux') fixtureArgs.push('--no-sandbox');
  const result = spawnSync(require('electron'), fixtureArgs, {
    stdio: 'inherit', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(root, { recursive: true, force: true }); }
