import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, dirname, relative, sep } from "node:path";
import { runGit } from "../workspace/git.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  commitJson,
  commitPath,
  gitCommitError,
  gitSha,
  gitOid,
  GIT_COMMIT_LIMITS,
  type GitCommitEntry,
  type GitRepositoryPin,
  type PreviewGitCommitInput,
} from "./types.js";
export async function gitRead(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  const r = await runGit(root, args, { signal, timeoutMs: 5000 });
  if (r.code !== 0)
    gitCommitError(
      "GIT_COMMIT_REPOSITORY",
      r.stderr.toString("utf8").slice(0, 1024),
    );
  return r.stdout;
}
const text = async (root: string, args: string[], signal?: AbortSignal) =>
  (await gitRead(root, args, signal)).toString("utf8").trim();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Splits `-z` output; a non-UTF-8 path would hash lossily, so it fails closed. */
function gitRecords(output: Buffer): string[] {
  try {
    return utf8.decode(output).split("\0").filter(Boolean);
  } catch {
    gitCommitError("GIT_COMMIT_PATH", "Git paths must be valid UTF-8");
  }
}
const recordPath = (record: string) => record.slice(record.indexOf("\t") + 1);
async function identity(path: string): Promise<string> {
  const st = await lstat(path, { bigint: true });
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    (await realpath(path)) !== path
  )
    gitCommitError("GIT_COMMIT_REPOSITORY");
  return `${st.dev}:${st.ino}`;
}
export async function fileBytes(
  root: string,
  path: string,
): Promise<Buffer | null> {
  const full = resolve(root, path);
  const relativePath = relative(root, full);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    gitCommitError("GIT_COMMIT_PATH");
  let st;
  try {
    st = await lstat(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.size > GIT_COMMIT_LIMITS.fileBytes ||
    (await realpath(dirname(full))) !== dirname(full)
  )
    gitCommitError("GIT_COMMIT_FILE_UNSUPPORTED");
  const bytes = await readFile(full);
  const after = await lstat(full);
  if (
    st.dev !== after.dev ||
    st.ino !== after.ino ||
    st.size !== after.size ||
    st.mtimeMs !== after.mtimeMs ||
    bytes.length !== st.size
  )
    gitCommitError("GIT_COMMIT_SOURCE_STALE");
  return bytes;
}
async function optionalFile(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 8388608)
      gitCommitError("GIT_COMMIT_REPOSITORY");
    return gitSha(await readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
/** Hooks the worker's read-tree, update-index and commit could run; scripts they source are not pinned. */
const PINNED_HOOKS = Object.freeze([
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-index-change",
  "reference-transaction",
  "pre-auto-gc",
]);
export async function repositoryPin(
  root: string,
  signal?: AbortSignal,
): Promise<GitRepositoryPin> {
  if (
    (await text(root, ["rev-parse", "--show-toplevel"], signal)) !== root ||
    (await text(root, ["rev-parse", "--is-bare-repository"], signal)) !==
      "false"
  )
    gitCommitError("GIT_COMMIT_REPOSITORY");
  const gitDir = await text(root, ["rev-parse", "--absolute-git-dir"], signal),
    commonDir = resolve(
      root,
      await text(root, ["rev-parse", "--git-common-dir"], signal),
    ),
    indexPath = resolve(
      root,
      await text(root, ["rev-parse", "--git-path", "index"], signal),
    );
  const head = gitOid(
      await text(root, ["rev-parse", "--verify", "HEAD"], signal),
    ),
    symbolic = await runGit(root, ["symbolic-ref", "-q", "HEAD"], { signal }),
    symbolicHead =
      symbolic.code === 0 ? symbolic.stdout.toString("utf8").trim() : "";
  const objectFormat = await text(
    root,
    ["rev-parse", "--show-object-format"],
    signal,
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    gitCommitError("GIT_COMMIT_REPOSITORY");
  const config = await gitRead(
    root,
    ["config", "--null", "--list", "--show-origin"],
    signal,
  );
  if (config.length > 65536) gitCommitError("GIT_COMMIT_LIMIT");
  const hookConfig = await runGit(
      root,
      ["config", "--path", "--get", "core.hooksPath"],
      { signal },
    ),
    hooksPath = resolve(
      root,
      hookConfig.code === 0
        ? hookConfig.stdout.toString("utf8").trim()
        : await text(root, ["rev-parse", "--git-path", "hooks"], signal),
    ),
    hooks: unknown[] = [];
  for (const name of PINNED_HOOKS) {
    const path = resolve(hooksPath, name),
      hash = await optionalFile(path);
    const st = hash === null ? null : await lstat(path, { bigint: true });
    hooks.push([
      name,
      hash,
      st
        ? {
            device: String(st.dev),
            inode: String(st.ino),
            mode: String(st.mode),
          }
        : null,
    ]);
  }
  const pin = {
    root,
    gitDir,
    commonDir,
    gitDirIdentity: await identity(gitDir),
    commonDirIdentity: await identity(commonDir),
    head,
    symbolicHead,
    indexPath,
    indexSha256: await optionalFile(indexPath),
    objectFormat,
    hooksSha256: knowledgeHash({ hooksPath, hooks }),
    configurationSha256: gitSha(config),
    author: await text(root, ["var", "GIT_AUTHOR_IDENT"], signal),
    committer: await text(root, ["var", "GIT_COMMITTER_IDENT"], signal),
  };
  // Dates are execution timestamps, while exact identity names/emails remain pinned.
  pin.author = pin.author.replace(/ \d+ [+-]\d{4}$/, "");
  pin.committer = pin.committer.replace(/ \d+ [+-]\d{4}$/, "");
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
  ])
    if ((await optionalFile(resolve(gitDir, name))) !== null)
      gitCommitError("GIT_COMMIT_OPERATION_ACTIVE");
  return commitJson(pin) as GitRepositoryPin;
}
export async function entriesFor(
  root: string,
  input: PreviewGitCommitInput,
  format: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<GitCommitEntry[]> {
  const paths = input.paths.map(commitPath);
  if (
    !paths.length ||
    paths.length > GIT_COMMIT_LIMITS.paths ||
    new Set(paths).size !== paths.length
  )
    gitCommitError("GIT_COMMIT_SELECTION");
  const records = gitRecords(
      await gitRead(
        root,
        ["ls-files", "--stage", "-z", "--", ...paths],
        signal,
      ),
    ),
    indexed = new Map<string, { mode: string; oid: string }>();
  for (const record of records) {
    const m = /^(\d{6}) ([a-f0-9]+) (\d)\t(.+)$/.exec(record);
    if (!m || m[3] !== "0" || !["100644", "100755"].includes(m[1]!))
      gitCommitError("GIT_COMMIT_INDEX_CONFLICT");
    indexed.set(m[4]!, { mode: m[1]!, oid: m[2]! });
  }
  const base = await treeEntries(root, signal),
    entries: GitCommitEntry[] = [];
  for (const path of paths) {
    const bytes = await fileBytes(root, path),
      fileSha256 = bytes === null ? null : gitSha(bytes),
      stage = indexed.get(path);
    if (input.selection === "staged") {
      if (!stage && !base.has(path)) gitCommitError("GIT_COMMIT_SELECTION");
      entries.push({
        path,
        mode: stage?.mode ?? "100644",
        oid: stage?.oid ?? null,
        fileSha256,
      });
    } else {
      const head = base.get(path);
      if (stage && (stage.oid !== head?.oid || stage.mode !== head?.mode))
        gitCommitError("GIT_COMMIT_STAGED_SELECTION_CONFLICT");
      if (!bytes && !head) gitCommitError("GIT_COMMIT_SELECTION");
      const st = bytes === null ? null : await lstat(resolve(root, path));
      entries.push({
        path,
        mode: st && st.mode & 0o111 ? "100755" : "100644",
        oid: bytes === null ? null : objectOid("blob", bytes, format),
        fileSha256,
      });
    }
  }
  if (
    entries.every(
      (e) =>
        e.oid === base.get(e.path)?.oid ||
        (e.oid === null && !base.has(e.path)),
    )
  )
    gitCommitError("GIT_COMMIT_EMPTY");
  return entries;
}
export function objectOid(
  type: string,
  data: Buffer,
  format: "sha1" | "sha256",
): string {
  return createHash(format)
    .update(Buffer.from(`${type} ${data.length}\0`))
    .update(data)
    .digest("hex");
}
export async function treeEntries(
  root: string,
  signal?: AbortSignal,
  revision = "HEAD",
): Promise<Map<string, { mode: string; oid: string }>> {
  const output = await gitRead(root, ["ls-tree", "-r", "-z", revision], signal),
    map = new Map<string, { mode: string; oid: string }>();
  for (const record of gitRecords(output)) {
    const m = /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!m || map.size >= GIT_COMMIT_LIMITS.treeEntries)
      gitCommitError("GIT_COMMIT_LIMIT");
    map.set(m[3]!, { mode: m[1]!, oid: m[2]! });
  }
  return map;
}
export async function expectedTree(
  root: string,
  entries: readonly GitCommitEntry[],
  format: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<string> {
  const all = await treeEntries(root, signal);
  for (const e of entries) {
    if (e.oid === null) all.delete(e.path);
    else all.set(e.path, { mode: e.mode, oid: e.oid });
  }
  type Tree = Map<string, Tree | { mode: string; oid: string }>;
  const tree: Tree = new Map();
  for (const [path, data] of all) {
    const parts = path.split("/");
    let t = tree;
    for (const part of parts.slice(0, -1)) {
      let next = t.get(part);
      if (next && !(next instanceof Map))
        gitCommitError("GIT_COMMIT_SELECTION");
      if (!next) {
        next = new Map();
        t.set(part, next);
      }
      t = next as Tree;
    }
    t.set(parts.at(-1)!, data);
  }
  function hash(t: Tree): string {
    const list = [...t].sort(([a, av], [b, bv]) =>
      Buffer.compare(
        Buffer.from(a + (av instanceof Map ? "/" : "")),
        Buffer.from(b + (bv instanceof Map ? "/" : "")),
      ),
    );
    return objectOid(
      "tree",
      Buffer.concat(
        list.map(([name, value]) => {
          const dir = value instanceof Map,
            mode = dir ? "40000" : value.mode,
            oid = dir ? hash(value) : value.oid;
          return Buffer.concat([
            Buffer.from(`${mode} ${name}\0`),
            Buffer.from(oid, "hex"),
          ]);
        }),
      ),
      format,
    );
  }
  return hash(tree);
}
export async function inspectCommit(
  root: string,
  signal?: AbortSignal,
): Promise<{
  head: string;
  parent: string | null;
  tree: string;
  message: string;
}> {
  const head = gitOid(await text(root, ["rev-parse", "HEAD"], signal)),
    data = (await gitRead(root, ["cat-file", "commit", head], signal)).toString(
      "utf8",
    ),
    split = data.indexOf("\n\n"),
    header = data.slice(0, split),
    parents = header.split("\n").filter((v) => v.startsWith("parent "));
  return {
    head,
    parent: parents.length === 1 ? parents[0]!.slice(7) : null,
    tree: header
      .split("\n")
      .find((v) => v.startsWith("tree "))!
      .slice(5),
    message: data.slice(split + 2),
  };
}

/** Stage/OID/path projection ignores stat-cache refreshes but preserves every unrelated staged entry. */
export async function indexProjection(
  root: string,
  entries: readonly GitCommitEntry[] = [],
  signal?: AbortSignal,
): Promise<string> {
  return projection(await indexRecords(root, signal), entries);
}
/**
 * The real index before the worker's working-tree update: every unrelated row is
 * unchanged and each selected row still equals its row in `head` or is absent.
 */
export async function indexBeforeUpdate(
  root: string,
  head: string,
  entries: readonly GitCommitEntry[],
  expectedProjectionSha256: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const records = await indexRecords(root, signal),
    base = await treeEntries(root, signal, head),
    selected = new Set(entries.map((e) => e.path));
  return (
    projection(records, entries) === expectedProjectionSha256 &&
    records.every((record) => {
      const path = recordPath(record),
        row = base.get(path);
      return (
        !selected.has(path) ||
        (row !== undefined && record === `${row.mode} ${row.oid} 0\t${path}`)
      );
    })
  );
}
async function indexRecords(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const records = gitRecords(
    await gitRead(root, ["ls-files", "--stage", "-z"], signal),
  );
  if (records.length > GIT_COMMIT_LIMITS.treeEntries)
    gitCommitError("GIT_COMMIT_LIMIT");
  return records;
}
function projection(
  records: readonly string[],
  entries: readonly GitCommitEntry[],
): string {
  const replaced = new Set(entries.map((e) => e.path)),
    remaining = records.filter((record) => !replaced.has(recordPath(record)));
  for (const entry of entries)
    if (entry.oid)
      remaining.push(`${entry.mode} ${entry.oid} 0\t${entry.path}`);
  return knowledgeHash(remaining.sort());
}
