import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  workflowEffectsFixture,
  effectsCommand,
  effectsUntil,
} from "./effects.js";
const base = process.argv[2]!,
  boundary = process.argv[3]!;
const f = await workflowEffectsFixture(
  { after() {} },
  { dbRoot: base, automaticDelivery: false },
);
function stop() {
  const state = {
    boundary,
    pid: process.pid,
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    parentRunId: f.parent.runId,
    instanceId: f.record().instanceId,
    root: f.root,
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    profile: f.configuration.agentProfiles,
    defaults: f.configuration.defaults,
  };
  writeFileSync(join(base, "crash-state.json"), JSON.stringify(state));
  process.send?.({ ready: true, boundary }, () =>
    process.kill(process.pid, "SIGSTOP"),
  );
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const consumer = Reflect.get(f.engine, "workflowEffects"),
  native = Reflect.get(consumer, "native");
if (boundary === "child-completed") {
  const prior = consumer.captureChild.bind(consumer);
  consumer.captureChild = async (...args: unknown[]) => {
    const original = await prior(...args);
    stop();
    return original;
  };
}
if (boundary === "stage-before-commit") {
  const prior = native.publish.bind(native);
  native.publish = (...args: unknown[]) => {
    const result = prior(...args);
    if (result.role === "editor" && result.state === "observed") stop();
    return result;
  };
}
if (boundary === "merge-before-receipt") {
  const prior = consumer.toolSettled.bind(consumer);
  consumer.toolSettled = (tool: { name: string }) => {
    if (tool.name === "merge_workflow_stage") stop();
    return prior(tool);
  };
}
if (["child-completed", "stage-before-commit"].includes(boundary)) {
  f.proceed.resolve();
  await f.approveParent("request_workflow_stage");
  await f.approveChild("apply_patch");
  await new Promise<void>(() => {});
}
await f.throughValidation();
await f.approveParent("merge_workflow_stage");
await effectsUntil(
  () =>
    consumer.native.read(f.session.id, f.record().instanceId, "edit").state ===
    "merged",
  "Merged stage did not settle",
);
await effectsUntil(() => f.sourceTerminal(), "Source did not terminal");
await effectsCommand(f.engine, "session.pause", { sessionId: f.session.id });
if (boundary === "delivery-before-commit") {
  const prior = f.engine.store.acceptInput.bind(f.engine.store);
  f.engine.store.acceptInput = (input) => {
    const receipt = prior(input);
    if (input.requestId.startsWith("workflow-result:")) stop();
    return receipt;
  };
}
if (boundary === "delivery-after-commit") {
  f.engine.scheduler.wake = async () => {
    stop();
    return;
  };
}
const target = f.engine.captureWorkflowDeliveryTarget({
  workspaceId: f.workspace.id,
  instanceId: f.record().instanceId,
  config: f.engine.store.getRun(f.parent.runId).config,
});
f.engine.deliverWorkflowResult({
  workspaceId: f.workspace.id,
  requestId: "crash-result",
  expectedRevision: 0,
  target,
  approved: true,
});
throw new Error("Crash boundary was not reached");
