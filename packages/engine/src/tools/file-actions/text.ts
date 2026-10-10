import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { assertWorkspaceWriteParent, workspaceWritePath } from '../../workspace/index.js';
export const TEXT_FILE_LIMIT = 1024 * 1024;
export const textHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
export function exactPath(value: unknown): string {
  workspaceWritePath(value, 'INVALID_FILE_ACTION_PATH', 'Use an exact bounded workspace-relative path outside Git metadata and dependencies');
  return value as string;
}
export async function readExactText(workspace: Workspace, relative: string, signal: AbortSignal): Promise<{ content: string; hash: string; mode: number }> {
  exactPath(relative);
  if (signal.aborted) throw new EngineError('CANCELLED', 'File observation cancelled');
  const root = await lstat(workspace.root); if (!root.isDirectory() || root.isSymbolicLink() || await realpath(workspace.root) !== workspace.root) throw new EngineError('UNSAFE_FILE_ACTION_PATH', 'Workspace root must remain canonical');
  let current = workspace.root; const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) { current = join(current, part); const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new EngineError('UNSAFE_FILE_ACTION_PATH', 'File parents must be ordinary directories'); }
  await assertWorkspaceWriteParent(workspace.root, current, 'UNSAFE_FILE_ACTION_PATH', 'File parents must resolve inside the workspace and outside Git metadata and dependencies');
  const absolute = join(current, parts.at(-1)!); const candidate = await lstat(absolute, { bigint: true });
  if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1n) throw new EngineError('UNSUPPORTED_FILE_ACTION', 'Only singly linked regular UTF-8 text files are supported');
  if (candidate.size > BigInt(TEXT_FILE_LIMIT)) throw new EngineError('FILE_ACTION_LIMIT', 'File exceeds text action byte limit');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== candidate.dev || before.ino !== candidate.ino || before.size > BigInt(TEXT_FILE_LIMIT)) throw new EngineError('FILE_ACTION_STALE', 'File identity changed while opening');
    const bytes = Buffer.alloc(Number(before.size) + 1); let position = 0;
    while (position < bytes.length) { if (signal.aborted) throw new EngineError('CANCELLED', 'File observation cancelled'); const read = await handle.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) break; position += read.bytesRead; }
    const after = await handle.stat({ bigint: true }); const named = await lstat(absolute, { bigint: true });
    if (position !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.dev !== named.dev || before.ino !== named.ino || named.nlink !== 1n || named.isSymbolicLink()) throw new EngineError('FILE_ACTION_STALE', 'File changed during observation');
    const raw = bytes.subarray(0, position); const content = raw.toString('utf8');
    if (raw.includes(0) || !Buffer.from(content).equals(raw)) throw new EngineError('UNSUPPORTED_FILE_ACTION', 'Binary or non-UTF-8 files are unsupported');
    return { content, hash: textHash(content), mode: Number(before.mode & 0o7777n) };
  } finally { await handle.close(); }
}
