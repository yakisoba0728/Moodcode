import { existsSync } from "node:fs";
import type { TestContext } from "node:test";
import { backendFixture, backendUntil, backendCommand } from "./backend.js";
const compiled = new URL("./effect-peer.mjs", import.meta.url),
  source = new URL(
    "../../../src/agent-backends/fixtures/effect-peer.mjs",
    import.meta.url,
  );
export const effectPeerFile = existsSync(compiled) ? compiled : source;
const policy = [
  { tool: "apply_patch", decision: "ask" as const },
  { tool: "run_command", decision: "ask" as const },
];
export async function approvedEffect(t: TestContext, mode: string) {
  const f = await backendFixture(t, {
    mode,
    peerFile: effectPeerFile,
    tools: ["read_file", "apply_patch", "run_command"],
    toolPolicy: policy,
    engine: { agentBackendClientEffects: true, jobs: true },
  });
  f.register();
  const submitted = await f.submit();
  return { ...f, ...submitted };
}
export async function decideEffect(
  f: Awaited<ReturnType<typeof approvedEffect>>,
  decision: "allow" | "deny" = "allow",
) {
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "Precise native approval absent",
  );
  const a = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find((a) => a.status === "pending")!;
  await backendCommand(f.engine, "approval.decide", {
    approvalId: a.id,
    decision,
    fingerprint: a.fingerprint,
  });
  return a;
}
