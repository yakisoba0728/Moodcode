import { execFile } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import { EngineError, type Workspace } from "@moodcode/contracts";
import type { LspFactory } from "./index.js";
import { captureTypeScriptProjectSources } from "./project-sources.js";
import { StdioLspConnection } from "./stdio.js";

export interface TypeScriptNativeLspOptions {
  readonly executable: string;
  readonly expectedVersion: "7.0.2";
}
function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}
function check(signal: AbortSignal): void {
  if (signal.aborted) fail("CANCELLED", "TypeScript native startup cancelled");
}
function config(
  input: TypeScriptNativeLspOptions,
): Readonly<TypeScriptNativeLspOptions> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail(
      "INVALID_LSP_CONFIG",
      "Native TypeScript requires plain host configuration",
    );
  const descriptors = Object.getOwnPropertyDescriptors(input),
    keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["executable", "expectedVersion"].includes(key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    fail(
      "INVALID_LSP_CONFIG",
      "Native TypeScript supports only its fixed executable and expected version",
    );
  const executable = descriptors.executable!.value,
    expectedVersion = descriptors.expectedVersion!.value;
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    Buffer.byteLength(executable) > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(executable) ||
    expectedVersion !== "7.0.2"
  )
    fail(
      "INVALID_LSP_CONFIG",
      "Native TypeScript needs an absolute executable and pinned version 7.0.2",
    );
  return Object.freeze({ executable, expectedVersion });
}
async function current(
  workspace: Workspace,
  executable: string,
  signal: AbortSignal,
): Promise<string> {
  check(signal);
  if (!workspace || typeof workspace !== "object" || types.isProxy(workspace))
    fail("INVALID_LSP_CONFIG", "Native TypeScript needs an actual workspace");
  const descriptors = Object.getOwnPropertyDescriptors(workspace);
  if (
    Object.values(descriptors).some((d) => !Object.hasOwn(d, "value")) ||
    !descriptors.root ||
    typeof descriptors.root.value !== "string" ||
    !isAbsolute(descriptors.root.value)
  )
    fail(
      "INVALID_LSP_CONFIG",
      "Native TypeScript workspace must contain plain absolute root data",
    );
  const root = descriptors.root.value as string;
  try {
    const [directory, file, canonicalRoot, canonicalExecutable] =
      await Promise.all([
        lstat(root, { bigint: true }),
        lstat(executable, { bigint: true }),
        realpath(root),
        realpath(executable),
      ]);
    check(signal);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      canonicalRoot !== root
    )
      fail(
        "UNSAFE_LSP_WORKSPACE",
        "Native TypeScript requires a canonical ordinary workspace",
      );
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      canonicalExecutable !== executable
    )
      fail(
        "INVALID_LSP_CONFIG",
        "Native TypeScript executable must be a canonical ordinary file",
      );
    await access(executable, constants.X_OK);
    check(signal);
    return [
      file.dev,
      file.ino,
      file.size,
      file.mtimeNs,
      file.ctimeNs,
      file.mode,
    ].join(":");
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return fail(
      "INVALID_LSP_CONFIG",
      "Native TypeScript executable or workspace is unavailable",
    );
  }
}
async function version(
  executable: string,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        cwd,
        timeout: 2000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        encoding: "utf8",
        signal,
        env: {
          PATH: process.env.PATH,
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
      },
      (error, stdout) => {
        if (signal.aborted)
          reject(
            new EngineError(
              "CANCELLED",
              "Native TypeScript version check cancelled",
            ),
          );
        else if (error)
          reject(
            new EngineError(
              "LSP_VERSION_CHECK_FAILED",
              "Native TypeScript version check did not complete",
            ),
          );
        else if (stdout.trim() !== "Version 7.0.2")
          reject(
            new EngineError(
              "LSP_VERSION_MISMATCH",
              "Native TypeScript executable did not report pinned version 7.0.2",
            ),
          );
        else resolve();
      },
    );
  });
  check(signal);
}

/** Explicit installed native compiler only: no package discovery, installation, shell or model-selected argv. */
export function createTypeScriptNativeLspFactory(
  input: TypeScriptNativeLspOptions,
): LspFactory {
  const options = config(input);
  let originalExecutable: string | undefined;
  const assertCurrent = async (workspace: Workspace, signal: AbortSignal) => {
    const observed = await current(workspace, options.executable, signal);
    if (originalExecutable !== undefined && originalExecutable !== observed)
      fail(
        "LSP_EXECUTABLE_CHANGED",
        "Native compiler changed after its original host factory capture",
      );
    originalExecutable ??= observed;
  };
  const factory: LspFactory = async (workspace, signal) => {
    await assertCurrent(workspace, signal);
    const cwd = Object.getOwnPropertyDescriptor(workspace, "root")!
      .value as string;
    await version(options.executable, cwd, signal);
    await assertCurrent(workspace, signal);
    const connection = await StdioLspConnection.open({
      command: options.executable,
      args: ["--lsp", "--stdio"],
      cwd,
    });
    try {
      await assertCurrent(workspace, signal);
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  };
  Object.defineProperty(factory, "projectSources", {
    enumerable: true,
    writable: false,
    configurable: false,
    value: async (workspace: Workspace, signal: AbortSignal) => {
      await assertCurrent(workspace, signal);
      const snapshot = await captureTypeScriptProjectSources(workspace, signal);
      await assertCurrent(workspace, signal);
      return snapshot;
    },
  });
  return Object.freeze(factory);
}
