import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const jsonDigest = (value: unknown) => digest(JSON.stringify(value));
export const rounded = (value: number) => Math.round(value * 1000) / 1000;
export const environment = () => ({
  node: process.version,
  os: platform(),
  release: release(),
  architecture: arch(),
  gcExposed: typeof (globalThis as { gc?: unknown }).gc === "function",
});
export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
export function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error("INVALID_BASELINE_ARGUMENT");
  return value;
}
export function seeded(seed: number): () => number {
  let state = integer(seed, 0, 0xffffffff) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
/** Nearest-rank empirical percentiles, including small sample sets. No SLA. */
export function distribution(samples: readonly number[]) {
  if (
    !samples.length ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("INVALID_BASELINE_SAMPLE");
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!);
  return {
    count: sorted.length,
    min: rounded(sorted[0]!),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: rounded(sorted.at(-1)!),
    mean: rounded(
      sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    ),
    method: "nearest-rank",
    unit: "milliseconds",
  };
}
export async function command<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
  native = false,
): Promise<T> {
  const request = {
    schemaVersion: native ? 2 : 1,
    commandId: randomUUID(),
    type,
    payload,
  };
  const result = await (native
    ? engine.dispatchSession(request)
    : engine.dispatch(request));
  if (!result.ok)
    throw new Error(result.error?.code ?? "BASELINE_COMMAND_FAILED");
  return result.result as unknown as T;
}
/** All Git effects are limited to the caller's fresh fixture repository. */
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4_194_304,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function failureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    code !== "ERR_ASSERTION" &&
    /^[A-Z][A-Z0-9_]{0,95}$/.test(code)
  )
    return code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.message))
    return error.message;
  return "BASELINE_ASSERTION_FAILED";
}
interface Pin {
  path: string;
  bytes: number;
  sha256: string;
}
/** Full engine/contracts implementation graph inventory, not a handful of convenient files. */
export async function sourceRuntimeIdentity() {
  const module = fileURLToPath(import.meta.url),
    runtime = module.endsWith(".ts") ? "source" : "compiled";
  const root = await realpath(join(dirname(module), "../../../.."));
  const pins: Pin[] = [];
  async function walk(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "fixtures" || entry.name === "evaluation") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (
        entry.isFile() &&
        /\.(ts|js|mjs|cjs|json)$/.test(entry.name) &&
        !/\.test\.|\.review-test\.|\.d\.ts$/.test(entry.name)
      ) {
        const info = await lstat(path);
        assert.ok(
          !info.isSymbolicLink() && info.size <= 16_777_216,
          "SOURCE_IDENTITY_INVALID",
        );
        const bytes = await readFile(path);
        pins.push({
          path: relative(root, path),
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      }
    }
  }
  for (const packageName of ["engine", "contracts"])
    await walk(join(root, "packages", packageName, "src"));
  if (runtime === "compiled")
    for (const packageName of ["engine", "contracts"])
      await walk(join(root, "packages", packageName, "dist"));
  else {
    // Source imports resolve workspace @moodcode/contracts through its package export.
    await walk(join(root, "packages/contracts/dist"));
  }
  for (const path of [
    "scripts/evaluate-engine.mjs",
    "scripts/benchmark-engine.mjs",
    "packages/engine/package.json",
    "packages/contracts/package.json",
  ]) {
    const bytes = await readFile(join(root, path));
    pins.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const path of [
    "packages/engine/src/storage/fixtures/summary-hotpath-benchmark.ts",
    ...(runtime === "compiled"
      ? ["packages/engine/dist/storage/fixtures/summary-hotpath-benchmark.js"]
      : []),
  ]) {
    const bytes = await readFile(join(root, path));
    pins.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const evaluationDirectory of new Set([
    join(root, "packages/engine/src/evaluation"),
    dirname(module),
  ]))
    for (const entry of (await readdir(evaluationDirectory)).sort())
      if (/\.(ts|js)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) {
        const path = join(evaluationDirectory, entry),
          bytes = await readFile(path);
        pins.push({
          path: relative(root, path),
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      }
  pins.sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(pins.length > 0 && pins.length <= 2500);
  let gitHead: string | null = null;
  try {
    gitHead = git(root, "rev-parse", "--verify", "HEAD");
  } catch {
    /* Distributed source archives need not have .git. */
  }
  return {
    runtime,
    gitHead,
    sourceSha256: jsonDigest(pins),
    files: pins,
    bytes: pins.reduce((sum, pin) => sum + pin.bytes, 0),
    scope:
      "engine/contracts production sources; effective engine/contracts runtime; runner modules and reused SQL measurement helper; no dependency/whole-repository claim",
  };
}
export function assertIdentityStable(
  before: Awaited<ReturnType<typeof sourceRuntimeIdentity>>,
  after: Awaited<ReturnType<typeof sourceRuntimeIdentity>>,
): void {
  if (
    before.sourceSha256 !== after.sourceSha256 ||
    before.gitHead !== after.gitHead ||
    before.runtime !== after.runtime
  )
    throw new Error("BASELINE_SOURCE_CHANGED");
}
export async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}
export async function cleanup(
  engine: MoodcodeEngine | undefined,
  directory: string,
) {
  let engineClosed = false;
  let nativeCleanupConfirmed: boolean | null = engine ? null : true;
  let runtimeCleanupConfirmed: boolean | null = engine ? null : true;
  let noActiveExecution: boolean | null = engine ? null : true;
  let failure: string | null = null;
  if (engine) {
    // close() joins its owners, but a resolved close is not a recovery acknowledgment.
    // Capture both native debt and runtime-only quarantine before close hides those facts.
    try {
      const workspaces = engine.store.listWorkspaces();
      assert.ok(workspaces.length <= 64, "BASELINE_CLEANUP_SCOPE_LIMIT");
      for (const workspace of workspaces) {
        if (engine.store.hasUncertainWorkspace(workspace.id)) {
          nativeCleanupConfirmed = false;
          throw new Error("BASELINE_NATIVE_CLEANUP_UNCERTAIN");
        }
      }
      nativeCleanupConfirmed = true;
      for (const workspace of workspaces) {
        engine.coordinator.assertWorkspaceCleanupConfirmed(workspace.id);
      }
      runtimeCleanupConfirmed = true;
      for (const workspace of workspaces) {
        engine.coordinator.assertWorkspaceAvailable(workspace.id);
      }
      noActiveExecution = true;
    } catch (error) {
      failure = failureCode(error);
    }
  }
  try {
    if (engine) await engine.close();
    engineClosed = true;
    if (
      failure ||
      nativeCleanupConfirmed !== true ||
      runtimeCleanupConfirmed !== true ||
      noActiveExecution !== true
    ) {
      return {
        engineClosed,
        nativeCleanupConfirmed,
        runtimeCleanupConfirmed,
        noActiveExecution,
        temporaryFilesRemoved: false,
        retainedDirectory: directory,
        failure: failure ?? "BASELINE_CLEANUP_PROOF_UNAVAILABLE",
      };
    }
    const retainedBytesBeforeRemoval = await directoryBytes(directory);
    await rm(directory, { force: true, recursive: true });
    return {
      engineClosed,
      nativeCleanupConfirmed,
      runtimeCleanupConfirmed,
      noActiveExecution,
      temporaryFilesRemoved: true,
      retainedBytesBeforeRemoval,
      failure: null,
    };
  } catch (error) {
    // Keep the database/artifacts on unconfirmed cleanup or unreadable native proof.
    return {
      engineClosed,
      nativeCleanupConfirmed,
      runtimeCleanupConfirmed,
      noActiveExecution,
      temporaryFilesRemoved: false,
      retainedDirectory: directory,
      failure: failureCode(error),
    };
  }
}
