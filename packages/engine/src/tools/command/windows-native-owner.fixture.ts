import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WindowsJobCommandBackend } from './backends.js';
import { windowsCommand, treePids } from './windows-native-test-helpers.fixture.js';

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory) throw new Error('Native owner fixture requires mode and directory');
if (mode === 'suspended') {
  const native = createRequire(import.meta.url)('@moodcode/windows-job');
  const job = native.createJob();
  const child = job.spawnSuspended({ command: windowsCommand('tree-hold', directory), cwd: directory, environment: { ...process.env } });
  process.send?.({ type: 'suspended', pid: child.pid, count: job.activeProcessCount() });
  setInterval(() => {}, 100);
} else if (mode === 'running') {
  const running = new WindowsJobCommandBackend().execute(
    { command: windowsCommand('tree-hold', directory), cwd: directory, timeoutMs: 20_000 },
    new AbortController().signal, () => {}, () => {}, () => {},
  );
  const timer = setInterval(() => {
    if (existsSync(join(directory, 'ready.json'))) {
      clearInterval(timer);
      process.send?.({ type: 'running', pids: treePids(directory) });
    }
  }, 10);
  const outcome = await running;
  throw new Error(`Parent was not killed while its job was active: ${JSON.stringify(outcome)}`);
} else throw new Error('Unknown native owner fixture mode');
