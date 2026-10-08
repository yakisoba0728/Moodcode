import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { JsonObject } from "@moodcode/contracts";
import { backendCommand, backendFixture, backendUntil } from "./backend.js";
import { sessionLoadLifecyclePeer } from "./session-load-lifecycle-peer.js";
import type { AgentBackendSessionLoad } from "../types.js";
import { AgentBackendStorage } from "../store.js";

/** Independent native boundaries use the real peer and mutate only its fixture mode. */
const peer = sessionLoadLifecyclePeer.replace(
  '    update("user_message_chunk", "HISTORICAL_USER_DATA_ONLY", "old-user");',
  `    if (mode === "foreign-session") {
      send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"foreign-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"FOREIGN_HISTORY"}}}}); return;
    }
    if (mode === "replay-limit") {
      for (let i=0;i<129;i++) update("agent_message_chunk","DUPLICATE_HISTORY","duplicate"); return;
    }
    if (mode === "disconnect") { process.exit(0); }
    if (mode === "duplicate-ack") {
      send({jsonrpc:"2.0",id:loadId,result:{}});
      send({jsonrpc:"2.0",id:loadId,result:{}}); return;
    }
    update("user_message_chunk", "HISTORICAL_USER_DATA_ONLY", "old-user");`,
);
export async function sessionLoadFixture(t: TestContext, mode = "positive") {
  const f = await backendFixture(t, { mode: "native-load" });
  writeFileSync(f.peerPath, peer);
  const registered = f.register();
  assert.equal(
    (await (await f.submit("SOURCE_NATIVE_CURRENT_INPUT")).done).state,
    "completed",
  );
  const source = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  const sourceTuple: AgentBackendSessionLoad = {
    sourceBackendId: f.backendId,
    sourceBackendRevisionId: registered.result.record.id,
    sourceRequestId: source.remoteRequestId,
    sourceRequestRevisionId: source.id,
    sourceRequestSha256: source.sha256,
    sourceConnectionId: connection.connectionId,
    sourceConnectionRevisionId: connection.id,
    sourceConnectionSha256: connection.sha256,
    remoteSessionId: source.remoteSessionId,
  };
  const alias = "native-loaded-peer",
    config = { ...f.config, providerId: `acp:${alias}` };
  writeFileSync(join(f.root, "load-mode.txt"), mode);
  const original = f.engine.captureAgentBackendTarget({
    backendId: alias,
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    config,
    launch: f.launch,
    credentialReference: null,
    endpointAudience: "local-fixture",
    contextOwner: "agent",
    sessionLoad: sourceTuple,
  });
  const pin = f.engine.readAgentBackendTarget(original);
  const spec = {
    ...f.spec(pin),
    id: alias,
    contextOwner: "agent" as const,
    sessionLoad: sourceTuple,
  };
  const registration = f.engine.registerAgentBackend(original, {
    workspaceId: f.workspace.id,
    requestId: randomUUID(),
    expectedRevision: 0,
    spec,
  });
  async function submit() {
    const accepted = await backendCommand<{ inputId: string }>(
      f.engine,
      "input.accept",
      {
        sessionId: f.session.id,
        requestId: randomUUID(),
        prompt: "LOAD_NATIVE_CURRENT_INPUT",
        config: config as unknown as JsonObject,
        delivery: "queue",
      },
    );
    await backendUntil(
      () => Boolean(f.engine.store.getInput(accepted.inputId).runId),
      "Actual native load input was not promoted",
    );
    const runId = f.engine.store.getInput(accepted.inputId).runId!;
    return { runId, done: f.engine.coordinator.waitForRun(runId) };
  }
  const native = Reflect.get(f.engine, "backendRecords") as AgentBackendStorage;
  return {
    ...f,
    alias,
    original,
    spec,
    config,
    source,
    connection,
    sourceTuple,
    registration,
    native,
    submitLoad: submit,
  };
}
