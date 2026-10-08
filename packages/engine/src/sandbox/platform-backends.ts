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
  rmSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join, isAbsolute, relative, dirname } from "node:path";
import { createServer } from "node:net";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  sandboxError,
  sandboxSign,
  sandboxSha,
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
/** No network, Mach service discovery, user-home mount, inherited credential environment or external application execution. */
export function seatbeltProfile(
  readonlyPaths: readonly string[],
  writePaths: readonly string[],
  excluded: readonly string[],
  executables: readonly string[],
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
  return `(version 1)(deny default)(allow process-exec process-fork)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)(allow file-read* file-map-executable ${read})(allow file-write* (literal "/dev/null") ${writePaths.map((p) => `(subpath ${q(p)})`).join(" ")})(deny file-read* file-write* ${excluded.map((p) => `(subpath ${q(p)})`).join(" ")})`;
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
  const profile = seatbeltProfile([a], [a], [o], [process.execPath]),
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
