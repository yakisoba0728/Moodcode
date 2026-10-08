import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { physicalPin, assertPin } from "../sandbox/platform-backends.js";
import type { SandboxPhysicalPin } from "../sandbox/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  codeModeError,
  codeSign,
  type CodeModeRuntimeCapability,
} from "./types.js";
export const codeModeWorkerPath = () => {
  const compiled = new URL("./worker.mjs", import.meta.url),
    source = new URL("../../src/code-mode/worker.mjs", import.meta.url);
  return realpathSync(fileURLToPath(existsSync(compiled) ? compiled : source));
};
export function codeModeProfile(node: string, worker: string): string {
  const q = JSON.stringify;
  return `(version 1)(deny default)(allow process-exec (literal ${q(node)}))(deny process-fork)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)(allow file-read* file-map-executable (literal "/")(subpath "/System/Library")(subpath "/usr/lib")(literal ${q(node)})(literal ${q(worker)})(literal "/dev/urandom")(literal "/dev/random")(literal "/dev/null"))(allow file-write* (literal "/dev/null"))`;
}
export interface CodeModeRuntimeSource {
  capability: CodeModeRuntimeCapability;
  node: SandboxPhysicalPin;
  worker: SandboxPhysicalPin;
  sandbox: SandboxPhysicalPin;
  trustedFiles: readonly SandboxPhysicalPin[];
  profile: string;
}
/** Actual probe; a capability DTO alone cannot authorize a runtime. */
export async function probeCodeModeRuntime(): Promise<CodeModeRuntimeSource> {
  const loaderDirectory = existsSync(
    new URL("./supervisor.js", import.meta.url),
  )
    ? null
    : dirname(fileURLToPath(import.meta.resolve("tsx")));
  const runtimeFile = (js: string, ts: string) =>
    physicalPin(
      realpathSync(
        fileURLToPath(
          existsSync(new URL(js, import.meta.url))
            ? new URL(js, import.meta.url)
            : new URL(ts, import.meta.url),
        ),
      ),
    );
  const trustedFiles = [
    physicalPin(
      realpathSync(fileURLToPath(import.meta.resolve("@moodcode/contracts"))),
    ),
    ...(loaderDirectory
      ? readdirSync(loaderDirectory)
          .filter((f) => /\.(mjs|cjs)$/.test(f))
          .sort()
          .map((f) => physicalPin(realpathSync(join(loaderDirectory, f))))
      : []),
    runtimeFile("./supervisor.js", "./supervisor.ts"),
    runtimeFile(
      "../tools/command/process-control.js",
      "../tools/command/process-control.ts",
    ),
  ];
  const node = physicalPin(realpathSync(process.execPath)),
    worker = physicalPin(codeModeWorkerPath());
  if (process.platform !== "darwin") codeModeError("CODE_MODE_OS_UNSUPPORTED");
  const sandbox = physicalPin("/usr/bin/sandbox-exec"),
    profile = codeModeProfile(node.path, worker.path),
    root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-code-mode-runtime-")),
    ),
    outside = join(root, "outside");
  writeFileSync(outside, "protected runtime probe");
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  let connections = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let evidence: unknown;
  try {
    const port = (server.address() as { port: number }).port;
    const raw = execFileSync(
      sandbox.path,
      [
        "-p",
        profile,
        node.path,
        "--max-old-space-size=64",
        worker.path,
        "--probe",
        outside,
        String(port),
      ],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    evidence = JSON.parse(raw);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = evidence as Record<string, unknown>;
    if (
      result.file !== "EPERM" ||
      result.write !== "EPERM" ||
      result.process !== "EPERM" ||
      result.network !== "EPERM" ||
      connections !== 0 ||
      existsSync(outside + ".write") ||
      knowledgeHash(result.environment) !== knowledgeHash(["PATH"])
    )
      codeModeError("CODE_MODE_RUNTIME_UNAVAILABLE");
  } catch (error) {
    codeModeError("CODE_MODE_RUNTIME_UNAVAILABLE");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  assertPin(node);
  assertPin(worker);
  assertPin(sandbox);
  const capability = codeSign({
    version: 1 as const,
    registrationId: randomUUID(),
    language: "moodcode-json-v1" as const,
    backend: "darwin-seatbelt-v1" as const,
    available: true,
    fileIsolation: true,
    networkIsolation: true,
    processIsolation: true,
    platform: process.platform,
    osRelease: release(),
    profileSha256: knowledgeHash(profile),
    executableSha256: node.sha256!,
    workerSha256: worker.sha256!,
    trustedSourceSha256: knowledgeHash(trustedFiles),
    evidenceSha256: knowledgeHash({ evidence, connections }),
    code: null,
  });
  return { capability, node, worker, sandbox, profile, trustedFiles };
}
export function assertCodeModeRuntime(source: CodeModeRuntimeSource): void {
  if (
    process.platform !== source.capability.platform ||
    release() !== source.capability.osRelease ||
    knowledgeHash(source.profile) !== source.capability.profileSha256
  )
    codeModeError("CODE_MODE_RUNTIME_STALE");
  if (
    knowledgeHash(source.trustedFiles) !== source.capability.trustedSourceSha256
  )
    codeModeError("CODE_MODE_RUNTIME_STALE");
  for (const pin of source.trustedFiles) assertPin(pin);
  assertPin(source.node);
  assertPin(source.worker);
  assertPin(source.sandbox);
}
