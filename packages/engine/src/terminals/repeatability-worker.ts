import {
  runPtyRepeatabilityCase,
  type PtyRepeatabilityScenario,
} from "./repeatability.js";
import { readFileSync, writeFileSync } from "node:fs";
import {
  sourceRuntimeIdentity,
  assertIdentityStable,
} from "../evaluation/runtime.js";

const [scenario, iteration, directory, timeoutMs] = process.argv.slice(2);
if (scenario === "--identity") {
  const identity = await sourceRuntimeIdentity();
  writeFileSync(iteration!, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
  });
  if (directory)
    assertIdentityStable(JSON.parse(readFileSync(directory, "utf8")), identity);
} else {
  const stopping = new AbortController();
  const stop = () =>
    stopping.abort(
      Object.assign(new Error("Original worker stop requested"), {
        code: "PTY_REPEATABILITY_WORKER_STOP",
      }),
    );
  process.once("SIGTERM", stop);
  const result = await runPtyRepeatabilityCase({
    scenario: scenario as PtyRepeatabilityScenario,
    iteration: Number(iteration),
    directory: directory!,
    timeoutMs: Number(timeoutMs),
    signal: stopping.signal,
  });
  process.removeListener("SIGTERM", stop);
  process.exitCode =
    result.status === "passed" ? 0 : result.status === "unsupported" ? 2 : 1;
}
