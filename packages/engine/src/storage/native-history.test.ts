import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type InputImageAttachment,
  type Message,
  type ToolCallRecord,
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
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-current-history-")),
    path = join(directory, "engine.sqlite");
  const store = new SqliteStore(path);
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
    title: "History",
    createdAt: date,
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, path };
}
function populate(
  store: SqliteStore,
  path: string,
  targetMessages: number,
  calls = 16,
) {
  const receipt = store.admit({
    sessionId: "session",
    requestId: "long",
    prompt: "Original user constraint",
    config,
    attachments: [image],
  });
  store.commit(receipt.runId, "run.started", {}, { run: { state: "running" } });
  const database = new DatabaseSync(path);
  database.exec("BEGIN IMMEDIATE");
  const insert = database.prepare(
    "INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)",
  );
  const tool = database.prepare(
    "INSERT INTO tools(id,session_id,run_id,state,data) VALUES(?,?,?,?,?)",
  );
  const content = "과거 도구 관측 ".repeat(1024);
  let sequence = 1;
  const append = (message: Message) => {
    insert.run(
      message.id,
      message.sessionId,
      message.runId,
      JSON.stringify(message),
    );
    sequence++;
  };
  let latestCallId = "";
  const resultMeta = (callId: string) => ({
    artifactRefs: [
      {
        id: "artifact-" + callId,
        identity: {
          sessionId: "session",
          runId: receipt.runId,
          toolCallId: callId,
        },
        sha256: "c".repeat(64),
        storedBytes: Buffer.byteLength(content),
        observedBytes: Buffer.byteLength(content),
        producerTruncatedBytes: 0,
        artifactTruncatedBytes: 0,
        createdAt: date,
        expiresAt: "2026-10-08T00:00:00.000Z",
        complete: true,
        outcome: "completed" as const,
      },
    ],
    warnings: [],
    outcome: "completed" as const,
  });
  while (sequence + calls + 2 <= targetMessages) {
    const toolCalls = Array.from({ length: calls }, (_, index) => ({
      id: `call-${sequence}-${index}`,
      name: "read_file",
      input: { path: `${index}.txt` },
    }));
    latestCallId = toolCalls[0]!.id;
    append({
      id: `assistant-${sequence}`,
      sessionId: "session",
      runId: receipt.runId,
      role: "assistant",
      content: "",
      toolCalls,
      createdAt: date,
      providerReplay: {
        providerId: "fixture",
        items: [{ type: "reasoning", encrypted_content: `opaque-${sequence}` }],
      },
    });
    for (const call of toolCalls) {
      append({
        id: `result-${call.id}`,
        sessionId: "session",
        runId: receipt.runId,
        role: "tool",
        content,
        toolCallId: call.id,
        createdAt: date,
        toolResult: resultMeta(call.id),
      });
      const record: ToolCallRecord = {
        id: call.id,
        sessionId: "session",
        runId: receipt.runId,
        name: call.name,
        input: call.input,
        state: "completed",
        output: content,
      };
      tool.run(
        record.id,
        "session",
        receipt.runId,
        record.state,
        JSON.stringify(record),
      );
    }
    if (
      sequence < targetMessages / 2 &&
      sequence + calls + 2 >= targetMessages / 2
    ) {
      append({
        id: "latest-steer",
        sessionId: "session",
        runId: receipt.runId,
        role: "user",
        content: "Keep the second user constraint",
        createdAt: date,
        attachments: [{ ...image, id: "img_" + "b".repeat(32) }],
      });
    }
  }
  const remaining = targetMessages - sequence;
  if (remaining) {
    const toolCalls = Array.from(
      { length: Math.max(0, remaining - 1) },
      (_, index) => ({
        id: `final-call-${index}`,
        name: "read_file",
        input: { path: `final-${index}.txt` },
      }),
    );
    if (toolCalls.length) latestCallId = toolCalls[0]!.id;
    append({
      id: "final-assistant",
      sessionId: "session",
      runId: receipt.runId,
      role: "assistant",
      content: "",
      createdAt: date,
      ...(toolCalls.length ? { toolCalls } : {}),
      providerReplay: {
        providerId: "fixture",
        items: [{ type: "reasoning", encrypted_content: "opaque-final" }],
      },
    });
    for (const call of toolCalls)
      append({
        id: `result-${call.id}`,
        sessionId: "session",
        runId: receipt.runId,
        role: "tool",
        content,
        toolCallId: call.id,
        createdAt: date,
        toolResult: resultMeta(call.id),
      });
  }
  database.exec("COMMIT");
  database.close();
  return {
    runId: receipt.runId,
    count: sequence,
    latestCallId,
    originalContent: content,
  };
}

for (const size of [1_000, 10_000])
  test(`active ${size}-message SQLite history reads bounded anchors and complete 16-call exchanges`, (t) => {
    const f = fixture(t),
      original = populate(f.store, f.path, size);
    f.store.getSnapshot = () => {
      throw new Error("Unbounded snapshot is forbidden");
    };
    const page = f.store.readModelHistory("session", 64, 65_536);
    for (let warm = 0; warm < 5; warm++)
      f.store.readModelHistory("session", 64, 65_536);
    const latencies: number[] = [];
    for (let sample = 0; sample < 30; sample++) {
      const started = performance.now();
      f.store.readModelHistory("session", 64, 65_536);
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    t.diagnostic(
      JSON.stringify({
        targetMessages: size,
        totalMessages: original.count,
        samples: 30,
        warmups: 5,
        p50Ms: latencies[14],
        p95Ms: latencies[28],
        maxMs: latencies.at(-1),
        snapshotJsonBytes: Buffer.byteLength(JSON.stringify(page.snapshot)),
        queryPayloadJsonBytes: Buffer.byteLength(JSON.stringify(page)),
        metadataRows: page.activeWindow?.metadataRows,
        selectedMessages: page.snapshot.messages.length,
        omittedMessages: page.omittedMessages,
        physicalReadBytes: null,
      }),
    );
    assert.equal(
      page.snapshot.messages[0]?.content,
      "Original user constraint",
    );
    assert.deepEqual(page.snapshot.messages[0]?.attachments, [image]);
    assert.deepEqual(
      page.snapshot.messages.find((item) => item.id === "latest-steer")
        ?.attachments,
      [{ ...image, id: "img_" + "b".repeat(32) }],
    );
    assert.ok(page.snapshot.messages.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 65_536);
    assert.ok(page.activeWindow!.metadataRows <= 100);
    assert.equal(page.activeWindow!.summarized, false);
    assert.equal(
      page.activeWindow!.omittedMessages,
      original.count - page.snapshot.messages.length,
    );
    assert.equal(original.count, size);
    assert.equal(page.omittedMessages, page.activeWindow!.omittedMessages);
    assert.equal(
      page.snapshot.messages.some((item) =>
        item.toolCalls?.some((call) => call.id === original.latestCallId),
      ),
      true,
    );
    for (const assistant of page.snapshot.messages.filter(
      (item) => item.role === "assistant",
    )) {
      assert.ok(assistant.providerReplay);
      for (const call of assistant.toolCalls ?? [])
        assert.equal(
          page.snapshot.messages.filter(
            (item) => item.role === "tool" && item.toolCallId === call.id,
          ).length,
          1,
        );
    }
    assert.ok(page.activeWindow!.toolContentProjections.length > 0);
    const latestResult = page.snapshot.messages.find(
      (item) => item.toolCallId === original.latestCallId,
    )!;
    assert.equal(
      latestResult.toolResult?.artifactRefs[0]?.id,
      "artifact-" + original.latestCallId,
    );
    assert.ok(
      latestResult.content.includes("artifact-" + original.latestCallId),
    );
    assert.ok(
      page.snapshot.messages
        .filter((item) => item.role === "tool")
        .every(
          (item) =>
            item.content.includes("completeContent") &&
            item.content.includes("originalUtf8Bytes"),
        ),
    );
    const reader = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        JSON.parse(
          String(
            reader
              .prepare("SELECT data FROM messages WHERE id=?")
              .get(`result-${original.latestCallId}`)?.data,
          ),
        ).content,
        original.originalContent,
      );
      assert.equal(
        reader
          .prepare("SELECT count(*) AS count FROM messages WHERE run_id=?")
          .get(original.runId)?.count,
        original.count,
      );
    } finally {
      reader.close();
    }
  });

test("active required batch and original user anchor cannot be silently dropped to meet limits", (t) => {
  const f = fixture(t);
  populate(f.store, f.path, 100);
  assert.throws(
    () => f.store.readModelHistory("session", 8, 65_536),
    code("MODEL_HISTORY_LIMIT"),
  );
  assert.throws(
    () => f.store.readModelHistory("session", 64, 1024),
    code("MODEL_HISTORY_LIMIT"),
  );
});
