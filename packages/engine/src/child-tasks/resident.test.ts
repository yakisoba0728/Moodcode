import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  nextResidentRecord,
  uncertainResidentPatch,
  validateResidentRecord,
  type ResidentChildRecord,
} from "./resident.js";

const sha = (digit: string) => digit.repeat(64);
function resident(): ResidentChildRecord {
  const body = {
    version: 1,
    taskId: `child_${"1".repeat(32)}`,
    rootSessionId: "root-session",
    parentRunId: "root-run",
    initialRunId: "child-run-1",
    childSessionId: "child-session",
    storageSha256: sha("a"),
    runtimeEpoch: "epoch",
    revision: 2,
    state: "running",
    allocation: {
      turns: 4,
      toolCalls: 4,
      outputBytes: 4096,
      durationMs: 60000,
    },
    idleTimeoutMs: 1000,
    expiresAt: "2026-01-01T00:00:00.000Z",
    sourceConfigSha256: sha("b"),
    profileSha256: sha("c"),
    catalogueSha256: sha("d"),
    runs: [
      {
        runId: "child-run-1",
        inputId: null,
        inputSha256: null,
        configSha256: sha("e"),
        promptSha256: sha("f"),
        state: "completed",
        usage: { turns: 1, toolCalls: 0, outputBytes: 10 },
        outcomeSha256: sha("1"),
      },
      {
        runId: "child-run-2",
        inputId: "input-2",
        inputSha256: sha("2"),
        configSha256: sha("e"),
        promptSha256: sha("3"),
        state: "running",
        usage: null,
        outcomeSha256: null,
      },
    ],
  };
  return validateResidentRecord({ ...body, sha256: knowledgeHash(body) });
}

test("resident uncertain transition reseals the next revision with unchanged record bytes", () => {
  const current = resident();
  const { sha256: _sha, ...old } = current;
  const body = {
    ...old,
    revision: current.revision + 1,
    state: "uncertain",
    runs: current.runs.map((x) =>
      x.state === "running" ? { ...x, state: "uncertain" } : x,
    ),
  };
  const next = nextResidentRecord(current, uncertainResidentPatch(current));
  assert.equal(
    JSON.stringify(next),
    JSON.stringify({ ...body, sha256: knowledgeHash(body) }),
  );
  assert.equal(
    next.sha256,
    "14541ebc2ec356fb034a47643e4031cf828a95bbf74126e443bf36c873bfa786",
  );
  assert.equal(current.revision, 2);
  assert.throws(
    () => nextResidentRecord(current, { state: "idle" }),
    (error: unknown) =>
      (error as { code?: string }).code === "RESIDENT_RECORD_INVALID",
  );
});
