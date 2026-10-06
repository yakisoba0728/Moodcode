import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type InputImageAttachment,
} from "@moodcode/contracts";
import { SqliteStore } from "./index.js";

const config = {
  providerId: "fixture",
  modelId: "fixture",
  mode: "build" as const,
  limits: { ...DEFAULT_LIMITS },
};
const date = "2026-10-07T00:00:00.000Z";
const image: InputImageAttachment = {
  id: "img_" + "a".repeat(32),
  kind: "image",
  mimeType: "image/png",
  bytes: 128,
  sha256: "a".repeat(64),
};
const conflict = (error: unknown) =>
  error instanceof EngineError && error.code === "REQUEST_ID_CONFLICT";
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-input-images-")),
    path = join(directory, "engine.sqlite");
  let store = new SqliteStore(path);
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: date,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Images",
    createdAt: date,
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new SqliteStore(path);
    },
  };
}
test("queued image references preserve exact request identity, real Run and detached user metadata through promotion/restart", (t) => {
  const f = fixture(t),
    input = {
      sessionId: "session",
      requestId: "queued-image",
      prompt: "Observe imported image",
      config,
      delivery: "queue" as const,
      attachments: [structuredClone(image)],
    };
  const receipt = f.store.acceptInput(input);
  input.attachments[0]!.bytes = 129;
  const expected = { ...input, attachments: [image] };
  assert.equal(f.store.acceptInput(expected).duplicate, true);
  assert.throws(() => f.store.acceptInput(input), conflict);
  const promoted = f.store.promoteInput(receipt.inputId);
  assert.deepEqual(promoted.run.attachments, [image]);
  assert.deepEqual(promoted.input.attachments, [image]);
  assert.deepEqual(f.store.getSnapshot("session").messages[0]?.attachments, [
    image,
  ]);
  promoted.run.attachments![0]!.bytes = 777;
  assert.deepEqual(f.store.getRun(promoted.run.id).attachments, [image]);
  assert.equal(
    f.store.admit({
      sessionId: "session",
      requestId: input.requestId,
      prompt: input.prompt,
      config,
      attachments: [image],
    }).runId,
    promoted.run.id,
  );
  f.reopen();
  assert.deepEqual(f.store.getInput(receipt.inputId).attachments, [image]);
  assert.deepEqual(f.store.getSnapshot("session").messages[0]?.attachments, [
    image,
  ]);
});
test("steering images remain user-message observations while the primary Run keeps its original attachment identity", (t) => {
  const f = fixture(t),
    receipt = f.store.admit({
      sessionId: "session",
      requestId: "original",
      prompt: "Original",
      config,
    });
  f.store.commit(
    receipt.runId,
    "run.started",
    {},
    { run: { state: "running" } },
  );
  const input = {
    sessionId: "session",
    requestId: "steer",
    prompt: "New image",
    config,
    delivery: "steer" as const,
    attachments: [image],
  };
  const steer = f.store.acceptInput(input);
  assert.equal(
    f.store.promoteSteers([steer.inputId], receipt.runId)[0]?.runId,
    receipt.runId,
  );
  assert.equal(
    Object.hasOwn(f.store.getRun(receipt.runId), "attachments"),
    false,
  );
  assert.deepEqual(
    f.store.getSnapshot("session").messages.at(-1)?.attachments,
    [image],
  );
  assert.equal(f.store.acceptInput(input).duplicate, true);
  assert.throws(
    () =>
      f.store.acceptInput({
        ...input,
        attachments: [{ ...image, sha256: "b".repeat(64) }],
      }),
    conflict,
  );
  assert.throws(
    () => f.store.acceptInput({ ...input, attachments: [] }),
    conflict,
  );
});
test("legacy input without image references preserves the omitted shape in all durable projections", (t) => {
  const f = fixture(t),
    receipt = f.store.admit({
      sessionId: "session",
      requestId: "plain",
      prompt: "Plain",
      config,
    });
  assert.equal(
    Object.hasOwn(f.store.getRun(receipt.runId), "attachments"),
    false,
  );
  assert.equal(
    Object.hasOwn(f.store.getInput(receipt.inputId), "attachments"),
    false,
  );
  assert.equal(
    Object.hasOwn(f.store.getSnapshot("session").messages[0]!, "attachments"),
    false,
  );
});
