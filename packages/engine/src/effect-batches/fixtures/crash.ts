import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { batchFixture, until } from "./batch.js";
import type { EffectBatchRecord } from "../types.js";
const [directory, phase] = process.argv.slice(2);
if (
  !directory ||
  ![
    "prepared",
    "before-write",
    "after-write",
    "peer-completed",
    "completed",
  ].includes(phase!)
)
  throw new Error("Actual crash boundary required");
const f = await batchFixture({ after: () => {} }, { directory });
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  writeFileSync(
    join(directory!, "ready.json"),
    JSON.stringify({
      pid: process.pid,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      runId: receipt.runId,
    }),
  );
  process.kill(process.pid, "SIGSTOP");
}
const save = f.engine.store.writeEffectBatch.bind(f.engine.store);
f.engine.store.writeEffectBatch = (record: EffectBatchRecord) => {
  save(record);
  if (
    (phase === "prepared" && record.state === "prepared") ||
    (phase === "completed" && record.state === "completed") ||
    (phase === "peer-completed" &&
      record.state === "running" &&
      record.members[0]!.state === "completed" &&
      record.members[1]!.state === "running")
  )
    stop();
};
const opened = fs.open.bind(fs);
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const h = await opened(...args);
  if (
    typeof args[0] === "string" &&
    [join(f.root, "a.txt"), join(f.root, "b.txt")].includes(args[0]) &&
    typeof args[1] === "number" &&
    (args[1] & 2) === 2
  ) {
    const write = h.write.bind(h);
    h.write = (async (...input: unknown[]) => {
      if (phase === "peer-completed" && args[0] === join(f.root, "b.txt"))
        await new Promise<void>(() => {});
      if (phase === "before-write" && args[0] === join(f.root, "a.txt")) stop();
      const result = await Reflect.apply(write, h, input);
      if (phase === "after-write" && args[0] === join(f.root, "a.txt")) stop();
      return result;
    }) as typeof h.write;
  }
  return h;
}) as typeof fs.open;
const receipt = await f.submit();
if (phase !== "prepared") {
  await until(() => f.pending().length === 2, "Genuine member approvals");
  f.approve();
}
await f.engine.coordinator.waitForRun(receipt.runId);
throw new Error("Crash boundary was missed");
