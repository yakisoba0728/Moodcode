import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const windowsNative = { skip: process.platform !== 'win32', timeout: 30_000 };
export const processScript = fileURLToPath(new URL('./windows-native-process.fixture.js', import.meta.url));
export function windowsCommand(mode: string, directory: string): string {
  return [process.execPath, processScript, mode, directory].map(value => {
    assert.ok(!/["\r\n%]/u.test(value), 'Fixture command arguments must be unambiguous cmd.exe tokens');
    return `"${value}"`;
  }).join(' ');
}
export async function until(check: () => boolean | Promise<boolean>, detail: string, milliseconds = 8000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise(yes => setTimeout(yes, 20));
  }
}
export function treePids(directory: string): number[] {
  if (!existsSync(join(directory, 'ready.json'))) return [];
  const value = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as { pids: number[] };
  assert.equal(value.pids.length, 3);
  assert.equal(new Set(value.pids).size, 3);
  assert.ok(value.pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  return value.pids;
}
// tasklist independently observes actual PIDs without sending a signal.
export function activePids(pids: readonly number[]): number[] {
  const listing = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const observed = new Set(listing.split(/\r?\n/u).flatMap(line => {
    const match = /^"(?:[^"]|"")*","(\d+)"/u.exec(line);
    return match ? [Number(match[1])] : [];
  }));
  assert.ok(observed.has(process.pid), 'The OS process listing must contain its actual test owner before absence can confirm cleanup');
  return pids.filter(pid => observed.has(pid));
}
export async function assertGone(pids: readonly number[]): Promise<void> {
  assert.ok(pids.length > 0, 'Cleanup verification requires actual process identities');
  await until(() => activePids(pids).length === 0, `Owned Windows PIDs remained alive: ${pids.join(', ')}`);
}
export function directoryFixture(t: TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-windows-native-')));
  t.after(() => {
    const pids = ['root', 'branch', 'leaf'].flatMap(role => {
      const path = join(directory, `${role}.pid`);
      return existsSync(path) ? [Number(readFileSync(path, 'utf8'))] : [];
    });
    for (const pid of activePids(pids)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Preserve the original assertion failure. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
export function treeDirectory(root: string): string {
  const directory = join(root, 'native-tree');
  mkdirSync(directory);
  return directory;
}
