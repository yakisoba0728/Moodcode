import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

async function directory(root: string) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error('Private configuration directory is unsafe.');
  return stat;
}
export async function readPrivateBytes(root: string, name: string, maximum: number): Promise<Buffer | undefined> {
  const owner = await directory(root);
  let file;
  let initial;
  try {
    initial = await lstat(join(root, name));
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > maximum) throw new Error('Private configuration file is unsafe or too large.');
    file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new Error('Private configuration file is unsafe or changed before open.');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maximum + 1));
    let offset = 0;
    while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    const after = await file.stat(), target = await lstat(join(root, name)), rootAfter = await directory(root);
    if (owner.ino !== rootAfter.ino || owner.dev !== rootAfter.dev || offset > maximum || stat.ino !== target.ino || stat.dev !== target.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Private configuration changed during its read.');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
export async function readPrivateJson(root: string, name: string, maximum: number): Promise<unknown | undefined> {
  const bytes = await readPrivateBytes(root, name, maximum);
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export async function writePrivateJson(root: string, name: string, value: unknown, maximum: number, beforeCommit?: () => Promise<void>): Promise<void> {
  return writePrivateBytes(root, name, Buffer.from(JSON.stringify(value)), maximum, beforeCommit);
}
export async function writePrivateBytes(root: string, name: string, bytes: Buffer, maximum: number, beforeCommit?: () => Promise<void>): Promise<void> {
  const owner = await directory(root);
  if (bytes.length > maximum) throw new Error('Private configuration exceeds its limit.');
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    const rootAfter = await directory(root);
    if (owner.ino !== rootAfter.ino || owner.dev !== rootAfter.dev) throw new Error('Private configuration directory changed.');
    await beforeCommit?.();
    await rename(temporary, join(root, name));
  }
  finally { await unlink(temporary).catch(() => {}); }
}
