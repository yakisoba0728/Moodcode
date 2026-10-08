import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory) throw new Error('Windows process fixture requires a mode and directory');
const pidFile = (role: string) => join(directory, `${role}.pid`);
const publish = (path: string, contents: string) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
};
const hold = () => setInterval(() => {}, 100);
const script = fileURLToPath(import.meta.url);

if (mode === 'output' || mode === 'output-small' || mode === 'overflow') {
  const repetitions = mode === 'output-small' ? 2048 : mode === 'output' ? 8192 : 100000;
  const stdout = Buffer.from('한글🙂'.repeat(repetitions));
  const stderr = Buffer.from('stderr🙂'.repeat(repetitions));
  await Promise.all([
    new Promise<void>(yes => process.stdout.write(stdout, () => yes())),
    new Promise<void>(yes => process.stderr.write(stderr, () => yes())),
  ]);
} else if (mode === 'leaf') {
  publish(pidFile('leaf'), String(process.pid));
  process.stderr.write('LEAF_STDERR 🙂\n');
  hold();
} else if (mode === 'branch') {
  publish(pidFile('branch'), String(process.pid));
  const leaf = spawn(process.execPath, [script, 'leaf', directory], {
    detached: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
  leaf.unref();
  hold();
} else if (mode === 'tree-hold' || mode === 'tree-exit') {
  appendFileSync(join(directory, 'effects.log'), `${process.pid}\n`);
  publish(pidFile('root'), String(process.pid));
  const branch = spawn(process.execPath, [script, 'branch', directory], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  branch.unref();
  const deadline = Date.now() + 8000;
  while (!existsSync(pidFile('leaf'))) {
    if (Date.now() > deadline) throw new Error('Actual descendant did not start');
    await new Promise(yes => setTimeout(yes, 10));
  }
  const pids = ['root', 'branch', 'leaf'].map(role => Number(readFileSync(pidFile(role), 'utf8')));
  publish(join(directory, 'ready.json'), JSON.stringify({ pids }));
  await new Promise<void>(yes => process.stdout.write('ROOT_STDOUT 한글🙂\n', () => yes()));
  if (mode === 'tree-exit') process.exit(0);
  hold();
} else throw new Error(`Unknown Windows process fixture mode: ${mode}`);
