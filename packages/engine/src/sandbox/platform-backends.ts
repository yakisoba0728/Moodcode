import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join, isAbsolute, relative, dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { knowledgeHash } from "../knowledge/validation.js";
import { GIT_SAFE_ARGS, gitEnvironment } from "../workspace/git.js";
import {
  sandboxError,
  sandboxSign,
  type SandboxPhysicalPin,
  type SandboxCapability,
} from "./types.js";
export function physicalPin(path: string): SandboxPhysicalPin {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    sandboxError("SANDBOX_SOURCE_STALE");
  const s = lstatSync(path, { bigint: true });
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
    sandboxError("SANDBOX_SOURCE_STALE");
  let hash: string | null = null;
  if (s.isFile()) {
    if (s.size > 536870912n) sandboxError("SANDBOX_LIMIT");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      const digest = createHash("sha256");
      const b = Buffer.alloc(65536);
      let n;
      while ((n = readSync(fd, b, 0, b.length, null)) > 0)
        digest.update(b.subarray(0, n));
      const after = fstatSync(fd, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        s.ino !== before.ino
      )
        sandboxError("SANDBOX_SOURCE_STALE");
      hash = digest.digest("hex");
    } finally {
      closeSync(fd);
    }
  }
  return {
    path,
    kind: s.isDirectory() ? "directory" : "file",
    device: s.dev.toString(),
    inode: s.ino.toString(),
    mode: s.mode.toString(),
    size: s.isFile() ? s.size.toString() : "0",
    mtimeNs: s.isFile() ? s.mtimeNs.toString() : "0",
    sha256: hash,
  };
}
export function assertPin(pin: SandboxPhysicalPin): void {
  if (knowledgeHash(physicalPin(pin.path)) !== knowledgeHash(pin))
    sandboxError("SANDBOX_SOURCE_STALE");
}
export function canonicalWorkspacePath(root: string, value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !isAbsolute(value)
  )
    sandboxError("SANDBOX_PATH");
  const p = realpathSync(value),
    r = relative(root, p);
  if (r === ".." || r.startsWith("../") || isAbsolute(r))
    sandboxError("SANDBOX_PATH");
  let d = p;
  while (d !== root) {
    if (realpathSync(d) !== d || lstatSync(d).isSymbolicLink())
      sandboxError("SANDBOX_PATH");
    d = dirname(d);
  }
  return p;
}
const q = (v: string) => JSON.stringify(v);
/** Read-only Git with the workspace hardening; a spawn failure, timeout or output overflow fails closed. */
function readGit(cwd: string, args: readonly string[]) {
  try {
    return {
      status: 0,
      out: execFileSync("git", [...GIT_SAFE_ARGS, "-C", cwd, ...args], {
        env: gitEnvironment(),
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status !== "number") sandboxError("SANDBOX_SOURCE_STALE");
    return { status, out: "" };
  }
}
/** Include targets declared in all config or one `--file`, resolved like Git against the including file. */
function includeTargets(cwd: string, scope: readonly string[]): string[] {
  const r = readGit(cwd, [
    "config",
    ...scope,
    "--show-origin",
    "-z",
    "--type=path",
    "--get-regexp",
    "^include(if\\..+)?\\.path$",
  ]);
  if (r.status === 1) return [];
  if (r.status !== 0) sandboxError("SANDBOX_SOURCE_STALE");
  const fields = r.out.split("\0"),
    targets: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const origin = fields[i]!,
      entry = fields[i + 1]!,
      value = entry.slice(entry.indexOf("\n") + 1);
    if (origin.startsWith("file:") && entry.includes("\n") && value)
      targets.push(resolve(cwd, dirname(origin.slice(5)), value));
  }
  return targets;
}
/** Physical path the kernel reaches through `path`; `entries` receives every directory entry visited, symlinks included. */
function physicalWalk(path: string, entries: string[]): string {
  let hops = 0;
  const walk = (p: string): string => {
    let dir = "/";
    for (const name of p.split("/")) {
      if (name === "" || name === ".") continue;
      if (name === "..") {
        dir = dirname(dir);
        continue;
      }
      const entry = join(dir, name);
      entries.push(entry);
      let link: string | undefined;
      try {
        link = readlinkSync(entry);
      } catch {}
      if (link === undefined) dir = entry;
      else if (++hops > 32) sandboxError("SANDBOX_PATH");
      else dir = walk(isAbsolute(link) ? link : `${dir}/${link}`);
    }
    return dir;
  };
  return walk(path);
}
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
export interface GitControlPaths {
  literal: readonly string[];
  subpath: readonly string[];
}
/**
 * Writes that let unsandboxed Git later run planted hooks or config commands or
 * switch to a planted gitdir: `<root>/.git` control entries, plus the effective
 * hooks directory and every config include target inside a write grant, with each
 * directory entry on their way there so they cannot be renamed or re-pointed.
 * Reads and other `.git` writes stay allowed.
 */
export function gitControlPaths(
  root: string,
  writePaths: readonly string[],
): GitControlPaths {
  const git = join(root, ".git"),
    literal = new Set([git, join(git, "config.worktree")]),
    subpath = new Set(
      [
        "config",
        "commondir",
        "hooks",
        "info",
        "modules",
        "rebase-merge",
        "worktrees",
      ].map((p) => join(git, p)),
    );
  if (writePaths.length) {
    const rev = readGit(root, [
      "rev-parse",
      "--show-toplevel",
      "--git-path",
      "hooks",
    ]);
    if (rev.status !== 0 && existsSync(git))
      sandboxError("SANDBOX_SOURCE_STALE");
    const [top, hooks] = rev.status === 0 ? rev.out.split("\n") : [],
      targets = includeTargets(top || root, []),
      seen = new Set<string>();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (seen.has(t)) continue;
      seen.add(t);
      if (seen.size > 64) sandboxError("SANDBOX_LIMIT");
      if (isFile(t)) targets.push(...includeTargets(root, ["--file", t]));
    }
    const inside = (p: string) =>
      writePaths.some((w) => p === w || p.startsWith(w + "/"));
    for (const c of hooks ? [resolve(root, hooks), ...seen] : seen) {
      const entries: string[] = [],
        target = physicalWalk(c, entries);
      for (const e of entries)
        if (e !== root && e !== target && inside(e)) literal.add(e);
      if (inside(target)) subpath.add(target);
    }
  }
  return { literal: [...literal], subpath: [...subpath] };
}
const gitWrites = (git: GitControlPaths) =>
  `(deny file-write* ${[...git.literal.map((p) => `(literal ${q(p)})`), ...git.subpath.map((p) => `(subpath ${q(p)})`)].join(" ")})`;
/** No network, Mach service discovery, user-home mount, inherited credential environment or external application execution. */
export function seatbeltProfile(
  readonlyPaths: readonly string[],
  writePaths: readonly string[],
  excluded: readonly string[],
  executables: readonly string[],
  git: GitControlPaths | null,
): string {
  const read = [
    '(literal "/")',
    '(subpath "/System/Library")',
    '(subpath "/usr/lib")',
    '(subpath "/bin")',
    '(subpath "/usr/bin")',
    '(literal "/dev/null")',
    '(literal "/dev/urandom")',
    '(literal "/dev/random")',
    ...executables.map((p) => `(literal ${q(p)})`),
    ...readonlyPaths.map((p) => `(subpath ${q(p)})`),
  ].join(" ");
  return `(version 1)(deny default)(allow process-exec process-fork)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)(allow file-read* file-map-executable ${read})(allow file-write* (literal "/dev/null") ${writePaths.map((p) => `(subpath ${q(p)})`).join(" ")})(deny file-read* file-write* ${excluded.map((p) => `(subpath ${q(p)})`).join(" ")})${git === null ? "" : gitWrites(git)}`;
}
export async function probeSeatbelt(): Promise<SandboxCapability> {
  const base = {
    version: 1 as const,
    backend: "darwin-seatbelt-v1" as const,
    platform: process.platform,
    osRelease: release(),
  };
  if (process.platform !== "darwin")
    return sandboxSign({
      ...base,
      supportTier: "unsupported" as const,
      available: false,
      fileIsolation: false,
      networkIsolation: false,
      descendantIsolation: false,
      executable: null,
      evidenceSha256: null,
      code: "SANDBOX_OS_UNSUPPORTED",
    });
  const executable = physicalPin("/usr/bin/sandbox-exec"),
    root = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-sandbox-probe-"))),
    a = join(root, "allowed"),
    o = join(root, "outside");
  mkdirSync(a);
  mkdirSync(o);
  writeFileSync(join(a, "data"), "allowed");
  writeFileSync(join(o, "data"), "denied");
  const server = createServer();
  let connections = 0;
  server.on("connection", (s) => {
    connections++;
    s.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const profile = seatbeltProfile([a], [a], [o], [process.execPath], null),
    evidence: object[] = [];
  const probe = (name: string, args: string[]) => {
    try {
      const stdout = execFileSync(executable.path, ["-p", profile, ...args], {
        cwd: a,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      });
      evidence.push({ name, status: 0, stdout });
      return 0;
    } catch (e) {
      const x = e as { status: number | null; stderr: Buffer; stdout: Buffer };
      evidence.push({
        name,
        status: x.status,
        stdout: x.stdout?.toString() ?? "",
        stderr: x.stderr?.toString() ?? "",
      });
      return x.status ?? -1;
    }
  };
  try {
    const allowed = probe("allowed", [
      "/bin/sh",
      "-c",
      "cat data; printf yes > written",
    ]);
    const denied = probe("outside-read", ["/bin/cat", join(o, "data")]);
    const write = probe("outside-write", [
      "/bin/sh",
      "-c",
      'printf denied > "$1"',
      "probe",
      join(o, "written"),
    ]);
    const descendant = probe("descendant-read", [
      process.execPath,
      "-e",
      `require('child_process').execFileSync('/bin/cat',[${q(join(o, "data"))}],{stdio:'inherit'})`,
    ]);
    const network = probe("loopback-denied", [
      "/usr/bin/curl",
      "--silent",
      "--max-time",
      "1",
      `http://127.0.0.1:${port}/`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const available =
      allowed === 0 &&
      denied !== 0 &&
      write !== 0 &&
      descendant !== 0 &&
      network !== 0 &&
      !existsSync(join(o, "written")) &&
      connections === 0;
    return sandboxSign({
      ...base,
      supportTier: available
        ? ("experimental-deprecated-cli" as const)
        : ("unsupported" as const),
      available,
      fileIsolation: available,
      networkIsolation: available,
      descendantIsolation: available,
      executable,
      evidenceSha256: knowledgeHash({
        evidence,
        connections,
        outsideWritten: existsSync(join(o, "written")),
      }),
      code: available ? null : "SANDBOX_ENFORCEMENT_UNAVAILABLE",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
