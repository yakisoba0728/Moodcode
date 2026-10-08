import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "node:path";
import { promisify } from "node:util";

export const FOLLOWUP_EVIDENCE_LIMITS = Object.freeze({
  bytes: 67_108_864,
  files: 2048,
  entries: 4096,
  depth: 32,
  ageMs: 86_400_000,
});
const MODES = {
  "persistent-soak": {
    prefix: "moodcode-resilience-",
    kind: "engine-persistent-soak",
  },
  "pty-repeatability": {
    prefix: "moodcode-pty-repeatability-",
    kind: "native-pty-repeatability",
  },
};
const execute = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const contentDigest = (files) =>
  sha(
    JSON.stringify(
      files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    ),
  );
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function data(object, key) {
  if (!object || typeof object !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (property && !Object.hasOwn(property, "value"))
    fail("EVIDENCE_REPORT_ACCESSOR");
  return property?.value;
}
function safePath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length > 4096 ||
    path !== normalize(path) ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    fail("EVIDENCE_PATH_INVALID");
  return path;
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => {
      if (typeof value !== "bigint") fail("EVIDENCE_NATIVE_UNSUPPORTED");
      return String(value);
    })
    .join(":");
}
async function descriptorPath(handle) {
  if (process.platform === "linux")
    return readlink(`/proc/self/fd/${handle.fd}`);
  if (process.platform !== "darwin") fail("EVIDENCE_NATIVE_UNSUPPORTED");
  const { stdout } = await execute(
    "/usr/sbin/lsof",
    ["-a", "-p", String(process.pid), "-d", String(handle.fd), "-Fn"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  const names = stdout.split("\n").filter((line) => line.startsWith("n"));
  if (names.length !== 1) fail("EVIDENCE_NATIVE_UNSUPPORTED");
  return names[0].slice(1);
}
async function boundHandle(handle, path, expected) {
  const stat = await handle.stat({ bigint: true });
  if (
    identity(stat) !== identity(expected) ||
    (await descriptorPath(handle)) !== path
  )
    fail("EVIDENCE_SOURCE_CHANGED");
}
async function writeManifest(path, manifest) {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if ((await descriptorPath(handle)) !== path)
      fail("EVIDENCE_DESTINATION_CHANGED");
    await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n");
  } finally {
    await handle.close();
  }
}
async function checkedDirectory(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("EVIDENCE_UNSAFE_ENTRY");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    await boundHandle(handle, path, stat);
    return { path, stat, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function checkDirectories(ancestors) {
  for (const directory of ancestors) {
    const current = await lstat(directory.path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      identity(current) !== identity(directory.stat)
    )
      fail("EVIDENCE_SOURCE_CHANGED");
    if (
      identity(await directory.handle.stat({ bigint: true })) !==
      identity(directory.stat)
    )
      fail("EVIDENCE_SOURCE_CHANGED");
  }
}
async function readBoundFile(path, stat, ancestors, destination) {
  await checkDirectories(ancestors);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    fail("EVIDENCE_UNSAFE_ENTRY");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    await boundHandle(handle, path, stat);
    await checkDirectories(ancestors);
    if (destination) {
      output = await open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      if ((await descriptorPath(output)) !== destination)
        fail("EVIDENCE_DESTINATION_CHANGED");
    }
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const count = Math.min(buffer.length, Number(stat.size) - bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, count, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > Number(stat.size) || bytes > FOLLOWUP_EVIDENCE_LIMITS.bytes)
        fail("EVIDENCE_SOURCE_CHANGED");
      digest.update(buffer.subarray(0, bytesRead));
      if (output) {
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            buffer,
            written,
            bytesRead - written,
            bytes - bytesRead + written,
          );
          if (!result.bytesWritten) fail("EVIDENCE_COPY_WRITE_FAILED");
          written += result.bytesWritten;
        }
      }
    }
    if (bytes !== Number(stat.size)) fail("EVIDENCE_SOURCE_CHANGED");
    await boundHandle(handle, path, stat);
    await checkDirectories(ancestors);
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await output?.close();
    await handle.close();
  }
}
async function snapshot(root, destination, metadataOnly = false) {
  const files = [],
    directories = [];
  let bytes = 0,
    entries = 0;
  async function walk(path, ancestors, depth) {
    if (depth > FOLLOWUP_EVIDENCE_LIMITS.depth) fail("EVIDENCE_DEPTH_LIMIT");
    const directory = await checkedDirectory(path),
      chain = [...ancestors, directory];
    try {
      const names = [],
        stream = await opendir(path);
      for await (const entry of stream) {
        if (++entries > FOLLOWUP_EVIDENCE_LIMITS.entries)
          fail("EVIDENCE_ENTRY_LIMIT");
        if (
          !entry.name ||
          entry.name === "." ||
          entry.name === ".." ||
          /[\\/\u0000-\u001f\u007f]/u.test(entry.name)
        )
          fail("EVIDENCE_UNSAFE_ENTRY");
        names.push(entry.name);
      }
      await checkDirectories(chain);
      directories.push({
        path: relative(root, path),
        identity: identity(directory.stat),
      });
      for (const name of names.sort()) {
        await checkDirectories(chain);
        const child = join(path, name),
          stat = await lstat(child, { bigint: true });
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          fail("EVIDENCE_UNSAFE_ENTRY");
        const target = destination
          ? join(destination, relative(root, child))
          : undefined;
        if (stat.isDirectory()) {
          if (target) await mkdir(target, { mode: 0o700 });
          await walk(child, chain, depth + 1);
        } else {
          if (
            files.length >= FOLLOWUP_EVIDENCE_LIMITS.files ||
            stat.size > BigInt(FOLLOWUP_EVIDENCE_LIMITS.bytes - bytes)
          )
            fail("EVIDENCE_SIZE_LIMIT");
          const value = metadataOnly
            ? { bytes: Number(stat.size), sha256: null }
            : await readBoundFile(child, stat, chain, target);
          bytes += value.bytes;
          files.push({
            path: relative(root, child),
            ...value,
            identity: identity(stat),
            sourceMode: Number(stat.mode & 0o777n),
          });
        }
      }
      await checkDirectories(chain);
    } finally {
      await directory.handle.close();
    }
  }
  await walk(root, [], 0);
  const result = { files, directories, bytes };
  return { ...result, sha256: sha(JSON.stringify(result)) };
}
function reportOutcome(mode, report) {
  return mode === "persistent-soak"
    ? data(report, "passed") === true
      ? "passed"
      : "failed"
    : (data(report, "status") ?? "failed");
}

/** Preserves bytes for upload; it grants no cleanup, native execution or recovery authority. */
export async function preserveFollowupEvidence(mode, report, resultsDir) {
  if (typeof mode !== "string" || !Object.hasOwn(MODES, mode))
    fail("EVIDENCE_MODE_INVALID");
  const policy = MODES[mode];
  const requested =
    mode === "persistent-soak"
      ? data(data(report, "cleanup"), "retainedEvidencePath")
      : data(report, "evidenceDirectory");
  const manifest = {
    schemaVersion: 1,
    kind: "followup-fixture-evidence",
    mode,
    reportOutcome: reportOutcome(mode, report),
    status: "unavailable",
    sourceQualified: false,
    exactSourceCopy: false,
    sourcePath: null,
    evidenceDirectory: null,
    fixtureDirectory: null,
    manifestPath: null,
    limits: FOLLOWUP_EVIDENCE_LIMITS,
    sourceDigest: null,
    copySourceDigest: null,
    finalSourceDigest: null,
    copiedDigest: null,
    files: [],
    bytes: 0,
    failure: null,
  };
  if (requested === undefined || requested === null) return manifest;
  if (
    data(report, "schemaVersion") !== 1 ||
    data(report, "kind") !== policy.kind ||
    data(report, "noLive") !== true
  )
    fail("EVIDENCE_REPORT_INVALID");
  if (
    data(report, "supported") === false ||
    data(report, "status") === "unsupported" ||
    !["linux", "darwin"].includes(process.platform) ||
    !Number.isInteger(constants.O_NOFOLLOW) ||
    !Number.isInteger(constants.O_DIRECTORY)
  )
    fail("EVIDENCE_NATIVE_UNSUPPORTED");
  const supplied = safePath(requested),
    temporary = await realpath(tmpdir());
  const suppliedStat = await lstat(supplied, { bigint: true });
  if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink())
    fail("EVIDENCE_UNSAFE_ENTRY");
  const source = await realpath(supplied);
  if (
    dirname(source) !== temporary ||
    !new RegExp(`^${policy.prefix}[A-Za-z0-9]{6}$`).test(basename(source))
  )
    fail("EVIDENCE_SOURCE_SCOPE");
  if (
    typeof process.getuid !== "function" ||
    suppliedStat.uid !== BigInt(process.getuid()) ||
    Number(suppliedStat.birthtimeMs) <= 0 ||
    Date.now() - Number(suppliedStat.birthtimeMs) >
      FOLLOWUP_EVIDENCE_LIMITS.ageMs ||
    Number(suppliedStat.birthtimeMs) > Date.now() + 60000
  )
    fail("EVIDENCE_SOURCE_NOT_FRESH");
  const results = safePath(resultsDir);
  await mkdir(results, { recursive: true });
  const canonicalResults = await realpath(results);
  if (canonicalResults !== results || (await lstat(results)).isSymbolicLink())
    fail("EVIDENCE_DESTINATION_SCOPE");
  if (canonicalResults === source || canonicalResults.startsWith(source + "/"))
    fail("EVIDENCE_DESTINATION_SCOPE");
  const destination = join(canonicalResults, `${mode}-evidence`);
  await mkdir(destination, { mode: 0o700 });
  Object.assign(manifest, {
    sourcePath: source,
    evidenceDirectory: destination,
    fixtureDirectory: join(destination, "fixture"),
    manifestPath: join(destination, "manifest.json"),
    status: "failed",
  });
  await mkdir(manifest.fixtureDirectory, { mode: 0o700 });
  try {
    await snapshot(source, undefined, true);
    const before = await snapshot(source);
    manifest.sourceDigest = before.sha256;
    const copied = await snapshot(source, manifest.fixtureDirectory);
    Object.assign(manifest, {
      copySourceDigest: copied.sha256,
      copiedDigest: contentDigest(copied.files),
      bytes: copied.bytes,
      files: copied.files.map(({ identity: ignored, ...file }) => file),
    });
    if (copied.sha256 !== before.sha256) fail("EVIDENCE_SOURCE_CHANGED");
    const after = await snapshot(source);
    manifest.finalSourceDigest = after.sha256;
    if (after.sha256 !== before.sha256) fail("EVIDENCE_SOURCE_CHANGED");
    const physical = await snapshot(manifest.fixtureDirectory);
    const exact = (files) =>
      files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    if (
      JSON.stringify(exact(physical.files)) !==
      JSON.stringify(exact(before.files))
    )
      fail("EVIDENCE_COPY_CHANGED");
    manifest.copiedDigest = contentDigest(physical.files);
    Object.assign(manifest, {
      status: "preserved",
      sourceQualified: true,
      exactSourceCopy: true,
    });
    await writeManifest(manifest.manifestPath, manifest);
    return manifest;
  } catch (error) {
    Object.assign(manifest, {
      status: "failed",
      sourceQualified: false,
      exactSourceCopy: false,
    });
    manifest.failure = {
      code: /^[A-Z_]{1,64}$/.test(error.code ?? "")
        ? error.code
        : "EVIDENCE_PRESERVATION_FAILED",
      message:
        "Fixture preservation did not qualify an exact stable source copy",
    };
    try {
      const partial = await snapshot(manifest.fixtureDirectory);
      manifest.files = partial.files.map(
        ({ identity: ignored, ...file }) => file,
      );
      manifest.bytes = partial.bytes;
      manifest.copiedDigest = contentDigest(partial.files);
    } catch {
      /* Existing copied failure bytes remain available even when no complete manifest can be qualified. */
    }
    await writeManifest(manifest.manifestPath, manifest).catch(() => {});
    error.evidence = manifest;
    throw error;
  }
}
