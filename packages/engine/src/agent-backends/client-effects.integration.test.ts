import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  backendFixture,
  backendUntil,
  backendCommand,
} from "./fixtures/backend.js";
import { groupExists } from "../tools/command/process-control.js";
import {
  approvedEffect as approved,
  decideEffect as decide,
  effectPeerFile as peerFile,
} from "./fixtures/effects.js";
const policy = [
  { tool: "apply_patch", decision: "ask" as const },
  { tool: "run_command", decision: "ask" as const },
];
test("actual ACP permission → exact native patch approval → physical file → Part/checkpoint/delivery in one Attempt", async (t) => {
  const f = await approved(t, "permission-write");
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(
    readFileSync(join(f.root, "effect.txt"), "utf8"),
    "Approved exact native ACP write.\n",
  );
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.state, "completed");
  assert.equal(effect.permission?.allowed, true);
  assert.ok(effect.permissionDelivery);
  assert.ok(effect.executionFrame);
  assert.ok(effect.delivery);
  assert.equal(effect.completion?.effectMethod, "fs/write_text_file");
  assert.equal(f.engine.store.listTurns(f.runId).length, 1);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 1);
  assert.equal(
    f.engine.inspectAgentBackendConnections(f.workspace.id)[0]?.capabilities
      ?.writeTextFile,
    true,
  );
});
test("actual native denial rejects permission with no physical write and records delivered denied effect", async (t) => {
  const f = await approved(t, "permission-write");
  await decide(f, "deny");
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  const e = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(e.state, "denied");
  assert.equal(e.permission?.allowed, false);
  assert.ok(e.delivery);
});
test("actual terminal create acknowledges native dispatch, wait/output/release settles supervised group and command checkpoint", async (t) => {
  const f = await approved(t, "terminal");
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(
    readFileSync(join(f.root, "command.txt"), "utf8"),
    "actual command",
  );
  const e = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(e.completion?.effectMethod, "terminal/create");
  assert.equal(e.completion?.cleanupConfirmed, true);
  assert.equal(e.controls?.length, 3);
  assert.ok(f.logs().find((v) => v.message?.id === "output")?.message?.result);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 1);
});
test("default effect opt-in off refuses write even with effect tools in Root catalogue", async (t) => {
  const f = await backendFixture(t, {
    mode: "direct-write",
    peerFile,
    tools: ["read_file", "apply_patch"],
    toolPolicy: policy,
  });
  f.register();
  const { done } = await f.submit();
  assert.equal((await done).state, "completed");
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  assert.equal(f.engine.inspectAgentBackendEffects(f.workspace.id).length, 0);
});
test("changed wire input after allow_once cannot spend the native approved effect or write widened content", async (t) => {
  const f = await approved(t, "permission-mutate");
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "failed");
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
});
test("source replacement during native approval fails the exact patch preimage with no overwritten external content", async (t) => {
  const f = await approved(t, "direct-write");
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "approval missing",
  );
  writeFileSync(
    join(f.root, "effect.txt"),
    "External replacement is preserved.\n",
  );
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(
    readFileSync(join(f.root, "effect.txt"), "utf8"),
    "External replacement is preserved.\n",
  );
  assert.equal(
    f.engine.inspectAgentBackendEffects(f.workspace.id)[0]?.state,
    "failed",
  );
});
test("terminal create ACK is not successful execution: actual nonzero exit retains native failed effect and output", async (t) => {
  const f = await approved(t, "terminal-fail");
  await decide(f);
  assert.equal((await f.done).state, "completed");
  const e = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(e.state, "failed");
  assert.equal(e.completion?.cleanupConfirmed, true);
  assert.equal((e.completion?.result as { exitCode: number }).exitCode, 7);
  assert.ok(e.delivery);
});
test("terminal kill uses its original native command abort and joins the actual process group", async (t) => {
  const f = await approved(t, "terminal-kill");
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(readFileSync(join(f.root, "command-ready"), "utf8"), "ready\n");
  const pid = Number(readFileSync(join(f.root, "command-pid"), "utf8"));
  assert.equal(groupExists(pid), false);
  const e = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(e.completion?.cleanupConfirmed, true);
  assert.equal(e.controls?.length, 3);
  assert.equal(
    (e.completion?.result as { cancelled: boolean }).cancelled,
    true,
  );
});
test("parent cancellation joins original terminal/peer groups and keeps remote outcome uncertain", async (t) => {
  const f = await approved(t, "terminal-hold");
  await decide(f);
  await backendUntil(
    () => existsSync(join(f.root, "command-pid")),
    "actual group did not start",
  );
  const pid = Number(readFileSync(join(f.root, "command-pid"), "utf8"));
  f.engine.coordinator.cancel(f.runId);
  await f.done;
  assert.equal(groupExists(pid), false);
  const c = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!;
  assert.equal(groupExists(c.proof.processId), false);
  const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  assert.equal(request.state, "uncertain");
  assert.equal(
    (request.cancellation?.message as { method?: string } | undefined)?.method,
    "session/cancel",
  );
  assert.ok(f.logs().some((v) => v.type === "cancel-received"));
  assert.equal(
    f.logs().filter((v) => v.message?.method === "session/prompt").length,
    1,
  );
});
test("late native approval after parent cancellation cannot grant or execute a write", async (t) => {
  const f = await approved(t, "permission-write");
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "approval missing",
  );
  const a = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find((a) => a.status === "pending")!;
  f.engine.coordinator.cancel(f.runId);
  await f.done;
  const decision = await f.engine.dispatch({
    schemaVersion: 1,
    commandId: "late-decision",
    type: "approval.decide",
    payload: {
      approvalId: a.id,
      decision: "allow",
      fingerprint: a.fingerprint,
    },
  });
  assert.equal(decision.ok, false);
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(
    f
      .logs()
      .some(
        (v) =>
          v.message?.id === "permission" &&
          (v.message.result as { outcome: { optionId?: string } } | undefined)
            ?.outcome.optionId === "once",
      ),
    false,
  );
});
test("duplicate wire effect identity cannot commit a second file checkpoint or spend another tool approval", async (t) => {
  const f = await approved(t, "duplicate-write");
  await decide(f);
  await f.done;
  assert.equal(
    readFileSync(join(f.root, "effect.txt"), "utf8"),
    "Approved exact native ACP write.\n",
  );
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 1);
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1);
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
test("live terminal output does not wait for exit and concurrent wait/kill joins the actual inherited descendant group", async (t) => {
  const f = await approved(t, "terminal-live-wait-kill");
  await decide(f);
  const run = await f.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  const output = f.logs().find((v) => v.message?.id === "live-output")?.message
    ?.result as { output: string; truncated: boolean; exitStatus?: unknown };
  assert.ok(
    output.output.includes("running live output"),
    JSON.stringify(output),
  );
  assert.equal(output.exitStatus, undefined);
  for (const name of ["command-pid", "command-child-pid"])
    assert.equal(
      pidAlive(Number(readFileSync(join(f.root, name), "utf8"))),
      false,
    );
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.completion?.cleanupConfirmed, true);
  assert.equal(effect.controls?.length, 4);
});
test("terminal argv is quoted as literal data, including apostrophes and shell syntax", async (t) => {
  const f = await approved(t, "terminal-args");
  await decide(f);
  assert.equal((await f.done).state, "completed");
  assert.equal(
    readFileSync(join(f.root, "argv.txt"), "utf8"),
    "literal's $(untrusted) value",
  );
});
for (const mode of ["outside", "wrong-session"])
  test(`actual ${mode} client write is rejected before native tool approval and physical effect`, async (t) => {
    const f = await approved(t, mode);
    await f.done;
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
    assert.equal(existsSync(join(f.root, "effect.txt")), false);
    assert.equal(existsSync(join(f.root, "../outside.txt")), false);
  });
test("actual symlink replacement while exact patch approval waits preserves the outside target", async (t) => {
  const f = await approved(t, "direct-write");
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "approval missing",
  );
  const outside = join(f.base, "outside-file");
  writeFileSync(outside, "unchanged outside");
  symlinkSync(outside, join(f.root, "effect.txt"));
  await decide(f);
  await f.done;
  assert.equal(readFileSync(outside, "utf8"), "unchanged outside");
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
});
test("actual fixed peer source replacement after approval cannot dispatch a client effect", async (t) => {
  const f = await approved(t, "direct-write");
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "approval missing",
  );
  writeFileSync(
    f.peerPath,
    readFileSync(f.peerPath, "utf8") + "\n// actual replacement\n",
  );
  await decide(f);
  await f.done;
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
});
