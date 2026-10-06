import { PosixPtyBackend } from '../backend.js';
let handle: Awaited<ReturnType<PosixPtyBackend['spawn']>> | undefined;
process.on('message', async (value: unknown) => {
  if (!value || typeof value !== 'object' || handle) return;
  const packet = value as { cwd: string };
  const backend = new PosixPtyBackend();
  handle = await backend.spawn({ file: '/bin/sh', args: ['-c', 'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait'], cwd: packet.cwd, cols: 80, rows: 24, maxDurationMs: 20_000 }, data => process.send?.({ type: 'output', data }));
  process.send?.({ type: 'started', pid: handle.pid });
});
