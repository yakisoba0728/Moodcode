import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { batchFixture, batchCommand } from "./batch.js";
import type { CodingAttemptGroup } from "../types.js";
const [base, boundary] = process.argv.slice(2);
if (!base || !boundary || !process.send)
  throw new Error("actual crash fixture requires IPC");
const f = await batchFixture({ after() {} }, { dbRoot: base });
function stop(g: CodingAttemptGroup) {
  writeFileSync(
    join(base!, "boundary.json"),
    JSON.stringify({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      parentRunId: f.parent.runId,
      groupId: g.groupId,
      configuration: {
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        defaults: f.config,
        agentProfiles: f.configuration.agentProfiles,
      },
      boundary,
    }),
  );
  process.send!({ ready: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const host = Reflect.get(f.engine, "codingBatches") as {
  observed: (...args: any[]) => void;
  merged: (...args: any[]) => void;
  native: { put: (r: CodingAttemptGroup, expected: number) => void };
};
if (boundary === "child-complete") {
  const observed = host.observed.bind(host);
  host.observed = (...args) => {
    if (args[1] === "review") {
      const g = f.engine.inspectBatchEvidence(f.workspace.id, f.input.groupId);
      stop(g);
    }
    return observed(...args);
  };
}
if (boundary === "merge-receipt") {
  const put = host.native.put.bind(host.native);
  host.native.put = (r, expected) => {
    if (r.selection?.state === "merged")
      stop(f.engine.inspectBatchEvidence(f.workspace.id, f.input.groupId));
    return put(r, expected);
  };
}
f.approveChildren();
const preview = await f.engine.previewCodingAttemptGroup(f.input),
  g = f.engine.startCodingAttemptGroup({
    workspaceId: f.workspace.id,
    requestId: "start",
    approved: true,
    preview,
  }),
  ready = await f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "run",
    expectedRevision: g.revision,
    approved: true,
  }),
  selection = await f.engine.previewCodingAttemptSelection({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    caseId: "A",
    expectedRevision: ready.revision,
  }),
  selected = f.engine.selectCodingAttempt({
    workspaceId: f.workspace.id,
    requestId: "select",
    approved: true,
    preview: selection,
  });
if (boundary === "selected") stop(selected);
f.releaseParent(selected.cases[0]!.instanceId);
await f.approveMerge();
await f.finish();
const completed = f.engine.inspectBatchEvidence(f.workspace.id, g.groupId);
if (boundary === "export") {
  f.engine.captureBatchEvidenceExport(f.workspace.id, g.groupId);
  stop(completed);
}
await batchCommand(f.engine, "session.pause", { sessionId: f.session.id });
const target = f.engine.captureCodingBatchDeliveryTarget({
  workspaceId: f.workspace.id,
  groupId: g.groupId,
  config: f.run.config,
});
if (boundary === "input-before-commit") {
  const accept = f.engine.store.acceptInput.bind(f.engine.store);
  f.engine.store.acceptInput = (input) => {
    const r = accept(input);
    if (input.requestId.startsWith("workflow-result:")) stop(completed);
    return r;
  };
}
if (boundary === "input-after-commit") {
  const wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = (session) => {
    stop(completed);
    return wake(session);
  };
}
f.engine.deliverCodingBatchResult({
  workspaceId: f.workspace.id,
  groupId: g.groupId,
  requestId: "delivery",
  expectedRevision: 0,
  approved: true,
  target,
});
throw new Error("crash boundary not reached");
