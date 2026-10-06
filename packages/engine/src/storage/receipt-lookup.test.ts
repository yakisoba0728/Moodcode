import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type AcceptInput,
} from "@moodcode/contracts";
import { SqliteStore } from "./index.js";
const config = {
  providerId: "fixture",
  modelId: "fixture",
  mode: "build" as const,
  limits: { ...DEFAULT_LIMITS },
};
const stamp = "2026-10-07T00:00:00.000Z";
const code = (value: string) => (error: unknown) =>
  error instanceof EngineError && error.code === value;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-receipt-lookup-")),
    path = join(directory, "engine.sqlite"),
    store = new SqliteStore(path);
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: stamp,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Lookup",
    createdAt: stamp,
  });
  const reader = new DatabaseSync(path);
  t.after(() => {
    reader.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rows = () =>
    Object.fromEntries(
      [
        "session_inputs",
        "session_sequences",
        "session_events",
        "inputs",
        "runs",
        "messages",
        "events",
      ].map((table) => [
        table,
        reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  return { store, reader, rows };
}
test("read-only receipt lookup returns absent/pending/cancelled/promoted identity without admission, rebinding or journal mutation", (t) => {
  const f = fixture(t),
    input: AcceptInput = {
      sessionId: "session",
      requestId: "lookup",
      prompt: "Goal",
      config,
      delivery: "queue",
      attachments: [
        {
          id: "img_" + "a".repeat(32),
          kind: "image",
          mimeType: "image/png",
          bytes: 42,
          sha256: "b".repeat(64),
        },
      ],
    };
  f.store.getSnapshot = () => {
    throw new Error("Unbounded lookup is forbidden");
  };
  const before = f.rows();
  assert.equal(f.store.lookupInputReceipt(input), undefined);
  assert.equal(f.store.lookupRunReceipt(input), undefined);
  assert.deepEqual(f.rows(), before);
  const accepted = f.store.acceptInput(input),
    pending = f.rows();
  assert.deepEqual(f.store.lookupInputReceipt(input), {
    ...accepted,
    duplicate: true,
  });
  assert.throws(
    () =>
      f.store.lookupRunReceipt({
        sessionId: input.sessionId,
        requestId: input.requestId,
        prompt: input.prompt,
        config,
        attachments: input.attachments,
      }),
    code("INPUT_NOT_PROMOTED"),
  );
  assert.deepEqual(f.rows(), pending);
  const promoted = f.store.promoteInput(accepted.inputId),
    bound = f.rows();
  assert.equal(f.store.lookupInputReceipt(input)?.runId, promoted.run.id);
  assert.deepEqual(
    f.store.lookupRunReceipt({
      sessionId: input.sessionId,
      requestId: input.requestId,
      prompt: input.prompt,
      config,
      attachments: input.attachments,
    }),
    { ...promoted.receipt, duplicate: true },
  );
  assert.deepEqual(f.rows(), bound);
  const cancelled = { ...input, requestId: "cancelled", attachments: [] };
  const receipt = f.store.acceptInput(cancelled);
  f.store.cancelInput(receipt.inputId);
  const rows = f.rows();
  assert.equal(f.store.lookupInputReceipt(cancelled)?.state, "cancelled");
  assert.deepEqual(f.rows(), rows);
});
test("lookup preserves exact config/media/delivery collision precedence across command versions", (t) => {
  const f = fixture(t),
    input: AcceptInput = {
      sessionId: "session",
      requestId: "steer",
      prompt: "Goal",
      config,
      delivery: "steer",
    };
  f.store.acceptInput(input);
  const before = f.rows();
  assert.throws(
    () => f.store.lookupInputReceipt({ ...input, prompt: "Other" }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.throws(
    () => f.store.lookupInputReceipt({ ...input, delivery: "queue" }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.throws(
    () => f.store.lookupInputReceipt({ ...input, attachments: [] }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.throws(
    () =>
      f.store.lookupInputReceipt({
        ...input,
        config: { ...config, modelId: "other" },
      }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.throws(
    () =>
      f.store.lookupRunReceipt({
        sessionId: input.sessionId,
        requestId: input.requestId,
        prompt: input.prompt,
        config,
      }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.deepEqual(f.rows(), before);
});
test("legacy-only identity lookup returns a real v1 receipt without inventing v2 cursors or binding records", (t) => {
  const f = fixture(t),
    input = {
      sessionId: "session",
      requestId: "legacy-only",
      prompt: "Goal",
      config,
    },
    receipt = f.store.admit(input);
  // Simulate a supported legacy writer identity not yet bound in the native journal.
  f.reader
    .prepare("DELETE FROM session_events WHERE input_id=?")
    .run(receipt.inputId);
  f.reader
    .prepare("DELETE FROM session_inputs WHERE id=?")
    .run(receipt.inputId);
  const before = f.rows();
  assert.deepEqual(
    f.store.lookupInputReceipt({ ...input, delivery: "queue" }),
    {
      inputId: receipt.inputId,
      state: "promoted",
      runId: receipt.runId,
      legacyReceipt: { ...receipt, duplicate: true },
    },
  );
  assert.deepEqual(f.store.lookupRunReceipt(input), {
    ...receipt,
    duplicate: true,
  });
  assert.throws(
    () => f.store.lookupInputReceipt({ ...input, delivery: "steer" }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.throws(
    () => f.store.lookupRunReceipt({ ...input, prompt: "Other" }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.deepEqual(f.rows(), before);
});
