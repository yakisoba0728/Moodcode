import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { exactPath, readExactText } from "../tools/file-actions/text.js";
import { excludedDirectory, gitIgnoredPaths } from "../workspace/ignore.js";

export interface LspProjectSourceSnapshot {
  readonly schemaVersion: 1;
  readonly scope: "workspace-typescript-files";
  readonly sha256: string;
  readonly fileCount: number;
  readonly bytes: number;
}
export const TYPESCRIPT_PROJECT_SOURCE_LIMITS = Object.freeze({
  entries: 16_384,
  files: 4096,
  directories: 4096,
  sourceBytes: 64 * 1024 * 1024,
  concurrent: 16,
  timeoutMs: 15_000,
  readers: 8,
});
let active = 0;
const fail = (code: string, message: string): never => {
  throw new EngineError(code, message);
};
function check(signal: AbortSignal): void {
  if (signal.aborted)
    fail("CANCELLED", "TypeScript project source observation cancelled");
}
function identity(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
    info.nlink,
  ].join(":");
}
function eligible(path: string): boolean {
  return (
    /\.(?:[cm]?[jt]sx?|json)$/i.test(path) ||
    /(?:^|\/)\.(?:gitignore|ignore)$/.test(path)
  );
}
function isExactPath(path: string): boolean {
  try {
    exactPath(path);
    return true;
  } catch {
    return false;
  }
}
// Ignore lookup rejects backslashes and drive prefixes, and Git parses a leading colon as pathspec magic.
function gitLiteralPath(path: string): boolean {
  return !/^[A-Za-z]?:|\\/.test(path);
}
/** Bounded host read: content-addressed workspace sources, never native compiler cache or provider execution. */
export async function captureTypeScriptProjectSources(
  workspace: Workspace,
  signal: AbortSignal,
): Promise<LspProjectSourceSnapshot> {
  check(signal);
  if (active >= TYPESCRIPT_PROJECT_SOURCE_LIMITS.concurrent)
    fail("LSP_PROJECT_SOURCE_LIMIT", "Too many project source observations");
  active++;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    TYPESCRIPT_PROJECT_SOURCE_LIMITS.timeoutMs,
  );
  const observedSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const root = await lstat(workspace.root, { bigint: true });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (await realpath(workspace.root)) !== workspace.root
    )
      fail(
        "UNSAFE_LSP_WORKSPACE",
        "Project sources require the canonical ordinary workspace root",
      );
    const directories = new Map<string, string>();
    const paths: string[] = [];
    let entries = 0;
    async function walk(relative: string): Promise<void> {
      check(observedSignal);
      const absolute = relative
        ? join(workspace.root, relative)
        : workspace.root;
      const before = await lstat(absolute, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink())
        fail(
          "LSP_PROJECT_SOURCE_STALE",
          "Project directory changed during observation",
        );
      directories.set(relative, identity(before));
      if (directories.size > TYPESCRIPT_PROJECT_SOURCE_LIMITS.directories)
        fail("LSP_PROJECT_SOURCE_LIMIT", "Project directory limit exceeded");
      const children: {
        path: string;
        directory: boolean;
        ordinary?: boolean;
      }[] = [];
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        check(observedSignal);
        if (++entries > TYPESCRIPT_PROJECT_SOURCE_LIMITS.entries)
          fail(
            "LSP_PROJECT_SOURCE_LIMIT",
            "Project traversal entry limit exceeded",
          );
        if (excludedDirectory(entry.name)) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const isDirectory = entry.isDirectory();
        if (!isDirectory && !eligible(path)) continue;
        children.push({
          path,
          directory: isDirectory,
          ordinary: entry.isFile() && !entry.isSymbolicLink(),
        });
      }
      children.sort((a, b) => a.path.localeCompare(b.path, "en"));
      const ignored = await gitIgnoredPaths(
        workspace,
        children.map((item) => item.path).filter(gitLiteralPath),
        observedSignal,
      );
      for (const child of children) {
        if (ignored.has(child.path)) continue;
        // The native server can still read a name the snapshot cannot pin.
        if (!isExactPath(child.path))
          fail(
            "UNSAFE_LSP_WORKSPACE",
            "Project sources require exact workspace-relative names",
          );
        if (child.directory) await walk(child.path);
        else {
          // Native semantic evidence cannot silently follow selected source/config aliases.
          if (!child.ordinary)
            fail(
              "UNSAFE_LSP_WORKSPACE",
              "Project sources must be ordinary files",
            );
          paths.push(child.path);
          if (paths.length > TYPESCRIPT_PROJECT_SOURCE_LIMITS.files)
            fail(
              "LSP_PROJECT_SOURCE_LIMIT",
              "Project source file limit exceeded",
            );
        }
      }
    }
    await walk("");
    paths.sort();
    let cursor = 0,
      bytes = 0;
    const files = new Array<{ path: string; hash: string }>(paths.length);
    const fileIdentities = new Map<string, string>();
    const reads = await Promise.allSettled(
      Array.from(
        {
          length: Math.min(
            TYPESCRIPT_PROJECT_SOURCE_LIMITS.readers,
            paths.length,
          ),
        },
        async () => {
          while (cursor < paths.length) {
            const index = cursor++,
              path = paths[index]!;
            check(observedSignal);
            const before = await lstat(join(workspace.root, path), {
              bigint: true,
            });
            const file = await readExactText(workspace, path, observedSignal);
            const after = await lstat(join(workspace.root, path), {
              bigint: true,
            });
            if (identity(before) !== identity(after))
              fail(
                "LSP_PROJECT_SOURCE_STALE",
                "Project file changed during capture",
              );
            bytes += Buffer.byteLength(file.content);
            if (bytes > TYPESCRIPT_PROJECT_SOURCE_LIMITS.sourceBytes)
              fail(
                "LSP_PROJECT_SOURCE_LIMIT",
                "Project source byte limit exceeded",
              );
            fileIdentities.set(path, identity(after));
            files[index] = { path, hash: file.hash };
          }
        },
      ),
    );
    const failedRead = reads.find((result) => result.status === "rejected");
    if (failedRead?.status === "rejected") throw failedRead.reason;
    for (const [path, captured] of fileIdentities) {
      check(observedSignal);
      if (
        identity(await lstat(join(workspace.root, path), { bigint: true })) !==
        captured
      )
        fail(
          "LSP_PROJECT_SOURCE_STALE",
          "Project file changed before snapshot completion",
        );
    }
    for (const [path, captured] of directories) {
      check(observedSignal);
      if (
        identity(
          await lstat(path ? join(workspace.root, path) : workspace.root, {
            bigint: true,
          }),
        ) !== captured
      )
        fail(
          "LSP_PROJECT_SOURCE_STALE",
          "Project membership changed before snapshot completion",
        );
    }
    check(observedSignal);
    const sha256 = createHash("sha256")
      .update(
        JSON.stringify({
          root: workspace.root,
          physicalRoot: { dev: root.dev.toString(), ino: root.ino.toString() },
          scope: "workspace-typescript-files",
          files,
        }),
      )
      .digest("hex");
    return Object.freeze({
      schemaVersion: 1,
      scope: "workspace-typescript-files",
      sha256,
      fileCount: files.length,
      bytes,
    });
  } catch (error) {
    if (deadline.signal.aborted && !signal.aborted)
      fail(
        "LSP_PROJECT_SOURCE_TIMEOUT",
        "Project source observation exceeded its deadline",
      );
    if (
      !(error instanceof EngineError) &&
      error &&
      typeof error === "object" &&
      "code" in error
    ) {
      const code = String(error.code);
      fail(
        code === "ENOENT" || code === "ENOTDIR"
          ? "LSP_PROJECT_SOURCE_STALE"
          : "LSP_PROJECT_SOURCE_UNAVAILABLE",
        "Project source filesystem observation could not be completed",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    active--;
  }
}
