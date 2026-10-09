import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { CodexProvider } from "../provider/codex.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fixture,
  accept,
  parts,
  stream,
  spec,
} from "./segment-engine-fixture.js";
import { wav, avi } from "./segment-fixtures.js";
import { createEngine } from "../engine.js";
import { exportEngineArchive } from "../storage/archive.js";
import { LifecycleHookRegistry } from "../lifecycle/index.js";
import { ResponsesProvider } from "../provider/responses.js";
import { providerSegments } from "./segment-provider.js";
import { validateMediaDatabase } from "./native-validation.js";
const until = async (check: () => boolean) => {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error("bounded media observation timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const code = (v: string) => (e: unknown) => (e as { code: string }).code === v;
test("media close joins pre-CAS cancellation and retains exact post-CAS success across reopen", async t => {
  const before = await fixture(t), bytes = wav(), pending = before.engine.importMedia(before.sessionId, bytes, "audio/wav", [{ startMs: 0, endMs: 100 }]);
  const outcomes = await Promise.allSettled([pending, before.engine.close()]);
  assert.equal(outcomes[0]!.status, "rejected"); assert.equal(outcomes[1]!.status, "fulfilled");
  const cancelled = createEngine({ dbPath: before.dbPath, artifactDir: before.artifactDir }); before.engines.push(cancelled);
  assert.equal(cancelled.store.getSessionDocument(before.sessionId, "input_media_segments"), null);
  const after = await fixture(t), original = after.engine.store.putSessionDocument.bind(after.engine.store);
  let closing: Promise<void> | undefined;
  after.engine.store.putSessionDocument = (sessionId, kind, revision, data) => {
    const result = original(sessionId, kind, revision, data);
    if (kind === "input_media_segments") closing = after.engine.close();
    return result;
  };
  const ref = await after.engine.importMedia(after.sessionId, bytes, "audio/wav", [{ startMs: 0, endMs: 100 }]); assert.ok(closing); await closing;
  const durable = createEngine({ dbPath: after.dbPath, artifactDir: after.artifactDir }); after.engines.push(durable);
  assert.deepEqual(durable.store.getSessionDocument(after.sessionId, "input_media_segments")?.data.attachments, [ref]);
  assert.deepEqual(await readFile(join(after.artifactDir, "input-segments", ref.id + ".blob")), bytes);
  assert.equal(durable.store.getSnapshot(after.sessionId).runs.length, 0); assert.equal(durable.store.listInputs(after.sessionId).inputs.length, 0);
  assert.equal(before.requests.length + after.requests.length, 0);
});
for (const origin of [1, 2] as const) test(`v${origin} durable segment receipt bypasses deleted source through both admission APIs`, async t => {
  const f = await fixture(t), ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [{ startMs: 0, endMs: 100 }]);
  const payload = { sessionId: f.sessionId, requestId: "original", prompt: "Exact segment", config: f.engine.getCapabilities().defaults, media: [ref] };
  const dispatch = (schemaVersion: 1 | 2, request = payload) => schemaVersion === 1
    ? f.engine.dispatch({ schemaVersion, commandId: "segment", type: "run.submit", payload: request })
    : f.engine.dispatchSession({ schemaVersion, commandId: "segment", type: "input.accept", payload: { ...request, delivery: "queue" } });
  const first = await dispatch(origin); assert.equal(first.ok, true, JSON.stringify(first.error)); await f.engine.scheduler.waitForSession(f.sessionId);
  const inputId = (first.result as { inputId: string }).inputId, runId = f.engine.store.getInput(inputId).runId!;
  assert.equal((await f.engine.waitForRun(runId)).state, "completed");
  await unlink(join(f.artifactDir, "input-segments", ref.id + ".blob"));
  for (const version of [1, 2] as const) {
    const duplicate = await dispatch(version); assert.equal(duplicate.ok, true, JSON.stringify(duplicate.error));
    assert.equal((duplicate.result as { runId: string }).runId, runId); assert.equal((duplicate.result as { duplicate: boolean }).duplicate, true);
    assert.equal((await dispatch(version, { ...payload, requestId: "fresh" })).error?.code, "MEDIA_STORAGE_FAILED");
    assert.equal((await dispatch(version, { ...payload, prompt: "Changed exact request" })).error?.code, "REQUEST_ID_CONFLICT");
  }
  assert.equal(f.requests.length, 1); assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1);
  assert.equal(f.engine.store.getSnapshot(f.sessionId).runs.length, 1);
});
test("actual pending input source deletion at model lifecycle boundary produces zero HTTP dispatch and no substituted source", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const hooks = new LifecycleHookRegistry();
  hooks.register({
    id: "hold-before-media",
    revision: 1,
    timeoutMs: 1000,
    stages: ["before-model"],
    callback: async () => {
      entered = true;
      await gate;
    },
  });
  const f = await fixture(t, { engine: { lifecycleHookRegistry: hooks } }),
    ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
      { startMs: 0, endMs: 100 },
    ]);
  const operation = accept(f, [ref]);
  await until(() => entered);
  await unlink(join(f.artifactDir, "input-segments", ref.id + ".blob"));
  release();
  const { run } = await operation;
  assert.equal(run?.state, "failed");
  assert.equal(f.requests.length, 0);
  assert.equal(
    f.engine.store
      .getSnapshot(f.sessionId)
      .messages.filter((m) => m.role === "user").length,
    1,
  );
});
test("actual audio cancellation retains captured prefix and cleanup; duplicate input never starts a new attempt", async (t) => {
  let cancelled = 0;
  const first =
    "data: " +
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            audio: {
              id: "cancel-audio",
              data: Buffer.from([1, 0, 2, 0]).toString("base64"),
            },
          },
          finish_reason: null,
        },
      ],
    }) +
    "\n\n";
  const f = await fixture(t, {
    output: true,
    response: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(first));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const accepted = await f.engine.dispatchSession({
    schemaVersion: 2,
    commandId: "cancel",
    type: "input.accept",
    payload: {
      sessionId: f.sessionId,
      requestId: "cancel",
      prompt: "audio",
      delivery: "queue",
    },
  });
  assert.equal(accepted.ok, true);
  let runId = "";
  await until(() => {
    runId =
      f.engine.store.getInput((accepted.result as { inputId: string }).inputId)
        .runId ?? "";
    return Boolean(
      runId &&
      f.engine.store
        .listTurns(runId)
        .some((turn) => turn.state === "streaming"),
    );
  });
  await new Promise((r) => setTimeout(r, 20));
  f.engine.coordinator.cancel(runId);
  const run = await f.engine.coordinator.waitForRun(runId);
  assert.equal(run.state, "cancelled");
  assert.equal(cancelled, 1);
  const media = parts(f.engine, runId).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  assert.equal(media.artifact.complete, false);
  assert.equal(media.state, "interrupted");
  const duplicate = await f.engine.dispatchSession({
    schemaVersion: 2,
    commandId: "dup",
    type: "input.accept",
    payload: {
      sessionId: f.sessionId,
      requestId: "cancel",
      prompt: "audio",
      delivery: "queue",
    },
  });
  assert.equal(duplicate.ok, true);
  assert.equal(f.requests.length, 1);
});
test("underlying audio response cancellation that cannot join remains uncertain and cannot publish a complete artifact", async (t) => {
  const frames = await stream(true).text();
  const f = await fixture(t, {
    output: true,
    response: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(frames));
          },
          cancel() {
            return new Promise<void>(() => {});
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const { run } = await accept(f);
  assert.equal(run?.error?.code, "CLEANUP_UNCERTAIN", JSON.stringify(run));
  const media = parts(f.engine, run!.id).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  assert.equal(media.artifact.complete, false);
  assert.equal(f.requests.length, 1);
});
test("native provider media admission SQL failure after physical publish preserves uncertainty and never fabricates Part", async (t) => {
  const f = await fixture(t, { output: true });
  const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
  db.exec(
    "CREATE TRIGGER media_admission_fault BEFORE INSERT ON session_events WHEN NEW.type='provider.media.admitted' BEGIN SELECT RAISE(ABORT,'fixture media receipt fault'); END",
  );
  const { run } = await accept(f);
  db.exec("DROP TRIGGER media_admission_fault");
  assert.equal(run?.error?.code, "CLEANUP_UNCERTAIN", JSON.stringify(run));
  assert.equal(
    parts(f.engine, run!.id).filter((p) => p.type === "media").length,
    0,
  );
  assert.equal(f.requests.length, 1);
  await f.engine.close();
  const reopened = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
  });
  f.engines.push(reopened);
  assert.equal(reopened.store.getRun(run!.id).error?.code, "CLEANUP_UNCERTAIN");
  assert.equal(f.requests.length, 1);
});
test("native current source and foreign actual Attempt/Part edits cannot be rehashed into provider artifact history", async (t) => {
  const f = await fixture(t, { output: true }),
    one = await accept(f, [], "one"),
    two = await accept(f, [], "two");
  const media = parts(f.engine, one.run!.id).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  const foreign = parts(f.engine, two.run!.id).find((p) => p.type === "media");
  assert.ok(foreign?.type === "media");
  const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
  assert.doesNotThrow(() => validateMediaDatabase(db));
  const changed = structuredClone(media);
  changed.artifact.identity = foreign.artifact.identity;
  db.prepare("UPDATE message_parts SET data=? WHERE id=?").run(
    JSON.stringify(changed),
    media.id,
  );
  assert.throws(() => validateMediaDatabase(db));
  db.prepare("UPDATE message_parts SET data=? WHERE id=?").run(
    JSON.stringify(media),
    media.id,
  );
  const anchor = db
    .prepare(
      "SELECT seq,data FROM session_events WHERE type='provider.media.admitted' AND json_extract(data,'$.payload.part.id')=?",
    )
    .get(media.id)!;
  const changedAnchor = JSON.parse(String(anchor.data));
  changedAnchor.payload.attempt = JSON.parse(
    String(
      db
        .prepare("SELECT data FROM provider_attempts WHERE id=?")
        .get(foreign.artifact.identity.attemptId!)!.data,
    ),
  );
  db.prepare(
    "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
  ).run(JSON.stringify(changedAnchor), f.sessionId, Number(anchor.seq));
  assert.throws(() => validateMediaDatabase(db), code("MEDIA_HISTORY_INVALID"));
  db.prepare(
    "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
  ).run(String(anchor.data), f.sessionId, Number(anchor.seq));
});
test("archive rejects changed immutable input blob and actual generated output bytes", async (t) => {
  for (const output of [false, true]) {
    const f = await fixture(t, { output }),
      ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
        { startMs: 0, endMs: 100 },
      ]),
      { run } = await accept(f, [ref]);
    assert.equal(run?.state, "completed");
    let path = join(f.artifactDir, "input-segments", ref.id + ".blob");
    if (output) {
      const part = parts(f.engine, run!.id).find((p) => p.type === "media");
      assert.ok(part?.type === "media");
      path = join(f.artifactDir, "managed", part.artifact.id, "content");
    }
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    await f.engine.close();
    await assert.rejects(
      exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.root, "corrupt-archive"),
      }),
      code("MEDIA_HISTORY_INVALID"),
    );
  }
});
test("actual Run output cap is charged for binary media and text together", async (t) => {
  const f = await fixture(t, { output: true, limits: { maxOutputBytes: 16 } }),
    { run } = await accept(f);
  assert.equal(run?.state, "failed");
  assert.equal(run?.error?.code, "OUTPUT_LIMIT");
  const media = parts(f.engine, run!.id).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  assert.equal(media.artifact.complete, false);
  assert.equal(f.requests.length, 1);
});
test("media source transport metadata accessors/proxies reject with zero traps", () => {
  let traps = 0;
  const request = {
    modelId: spec.modelId,
    messages: [
      Object.defineProperty({ role: "user", content: "data" }, "media", {
        enumerable: true,
        get() {
          traps++;
          return [];
        },
      }),
    ],
    tools: [],
  };
  assert.throws(() => providerSegments(request as never, () => true));
  const proxy = new Proxy(request, {
    get() {
      traps++;
      return undefined;
    },
  });
  assert.throws(() => providerSegments(proxy as never, () => true));
  assert.equal(traps, 0);
});
test("Responses consumes actual AVI PNG frames with explicit exact model; audio rejects before fetch", async (t) => {
  const f = await fixture(t),
    video = await f.engine.importMedia(f.sessionId, avi(), "video/x-msvideo", [
      { startMs: 0, endMs: 1000 },
    ]);
  let calls = 0,
    payload: Record<string, unknown> = {};
  const p = new ResponsesProvider({
    id: "responses-fixture",
    videoModelIds: ["exact-video"],
    fetch: async (_u, i) => {
      calls++;
      payload = JSON.parse(String(i?.body));
      return new Response(
        "data: " +
          JSON.stringify({
            type: "response.created",
            response: { id: "r", status: "in_progress" },
          }) +
          "\n\n" +
          "data: " +
          JSON.stringify({
            type: "response.completed",
            response: { id: "r", status: "completed", output: [] },
          }) +
          "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const bytes = avi();
  const request = {
    runId: "actual-transport-test",
    sessionId: f.sessionId,
    turnIndex: 0,
    modelId: "exact-video",
    messages: [{ role: "user" as const, content: "observe", media: [video] }],
    tools: [],
    resolvedMedia: [{ attachment: video, data: bytes.toString("base64") }],
  };
  for await (const _ of p.streamTurn(request, new AbortController().signal)) {
  }
  const input = payload.input as Array<{ content: Array<{ type: string }> }>;
  assert.equal(
    input[0]!.content.filter((b) => b.type === "input_image").length,
    2,
  );
  assert.equal(calls, 1);
  const audio = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
    { startMs: 0, endMs: 100 },
  ]);
  await assert.rejects(async () => {
    for await (const _ of p.streamTurn(
      {
        ...request,
        messages: [{ role: "user", content: "audio", media: [audio] }],
        resolvedMedia: [{ attachment: audio, data: wav().toString("base64") }],
      },
      new AbortController().signal,
    )) {
    }
  });
  assert.equal(calls, 1);
});
test("native output paging, exact session scope, post-restart read and physical content integrity are explicit host reads", async (t) => {
  const f = await fixture(t, { output: true }),
    { run } = await accept(f),
    media = parts(f.engine, run!.id).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  const first = await f.engine.readMediaOutput({
    sessionId: f.sessionId,
    partId: media.id,
    limit: 8,
  });
  assert.equal(first.bytes.length, 8);
  assert.equal(first.nextOffset, 8);
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from("RIFF,\0\0\0"));
  await assert.rejects(
    f.engine.readMediaOutput({ sessionId: "foreign", partId: media.id }),
    code("MEDIA_PART_NOT_FOUND"),
  );
  const unknown = f.engine.getMediaCapabilities(
    spec.providerId,
    "unsupported-model",
  );
  assert.equal(unknown.audioOutput, false);
  assert.equal(unknown.tokenCost, null);
  assert.equal(
    f.engine.getMediaCapabilities(spec.providerId, spec.modelId).audioOutput,
    true,
  );
  await f.engine.close();
  const reopened = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
  });
  f.engines.push(reopened);
  const second = await reopened.readMediaOutput({
    sessionId: f.sessionId,
    partId: media.id,
    offset: first.nextOffset,
    limit: 8,
  });
  assert.equal(second.offset, 8);
  assert.equal(f.requests.length, 1);
  const path = join(f.artifactDir, "managed", media.artifact.id, "content"),
    bytes = await readFile(path);
  bytes[44] = 99;
  await writeFile(path, bytes);
  await assert.rejects(
    reopened.readMediaOutput({ sessionId: f.sessionId, partId: media.id }),
  );
});
test("host model media capability evidence and raw command media proxy cannot escalate or trigger traps", async (t) => {
  const f = await fixture(t),
    ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
      { startMs: 0, endMs: 100 },
    ]);
  let traps = 0;
  const proxy = new Proxy([ref], {
    ownKeys() {
      traps++;
      return [];
    },
  });
  const result = await f.engine.dispatchSession({
    schemaVersion: 2,
    commandId: "forged",
    type: "input.accept",
    payload: {
      sessionId: f.sessionId,
      requestId: "forged",
      prompt: "inspect",
      delivery: "queue",
      media: proxy,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(traps, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.engine.store.getSnapshot(f.sessionId).runs.length, 0);
});

test("actual 128-session media index capacity rejects new import atomically, keeps existing index usable and reopens without replay", async (t) => {
  const f = await fixture(t);
  const session = f.engine.store.getSession(f.sessionId),
    workspace = f.engine.store.getWorkspace(session.workspaceId);
  const sessions = [f.sessionId];
  for (let i = 1; i <= 128; i++) {
    const created = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: `capacity-session-${i}`,
      type: "session.create",
      payload: { workspaceId: workspace.id },
    });
    assert.equal(created.ok, true);
    sessions.push((created.result as { id: string }).id);
  }
  for (const id of sessions.slice(0, 128))
    f.engine.store.putSessionDocument(id, "input_media_segments", 0, {
      version: 1,
      owner: {
        sessionId: id,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
      },
      attachments: [],
    });
  const ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
    { startMs: 0, endMs: 100 },
  ]);
  const sql = new DatabaseSync(f.dbPath);
  try {
    const before = sql
      .prepare("SELECT count(*) AS count FROM session_events WHERE session_id=?")
      .get(sessions[128]!)!.count;
    await assert.rejects(
      f.engine.importMedia(sessions[128]!, wav(), "audio/wav", [
        { startMs: 0, endMs: 100 },
      ]),
      code("MEDIA_INDEX_CAPACITY"),
    );
    assert.equal(
      f.engine.store.getSessionDocument(sessions[128]!, "input_media_segments"),
      null,
    );
    assert.equal(
      sql
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id=?",
        )
        .get(sessions[128]!)!.count,
      before,
    );
    assert.equal(
      sql
        .prepare(
          "SELECT count(*) AS count FROM session_documents WHERE kind='input_media_segments'",
        )
        .get()!.count,
      128,
    );
    assert.deepEqual(await readdir(join(f.artifactDir, "input-segments")), [
      ref.id + ".blob",
    ]);
    assert.equal(validateMediaDatabase(sql).sources.length, 1);
  } finally {
    sql.close();
  }
  await f.engine.close();
  const reopened = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
  });
  f.engines.push(reopened);
  assert.equal(
    reopened.store.getSessionDocument(f.sessionId, "input_media_segments")!
      .revision,
    2,
  );
  assert.equal(reopened.store.getSnapshot(f.sessionId).runs.length, 0);
  assert.equal(f.requests.length, 0);
});

test("direct Codex audio/video rejection occurs before any credential filesystem read or transport dispatch", async (t) => {
  const f = await fixture(t);
  const audio = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
    { startMs: 0, endMs: 100 },
  ]);
  const video = await f.engine.importMedia(
    f.sessionId,
    avi(),
    "video/x-msvideo",
    [{ startMs: 0, endMs: 500 }],
  );
  let reads = 0,
    fetched = 0;
  const local = new AsyncLocalStorage<boolean>();
  const hooks = createHook({
    init(_id, type) {
      if (
        local.getStore() &&
        (type === "FSREQPROMISE" || type === "FSREQCALLBACK")
      )
        reads++;
    },
  });
  const adapter = new CodexProvider({
    codexHome: join(f.root, "deliberately-missing-fixture-auth"),
    fetch: async () => {
      fetched++;
      return stream();
    },
  });
  hooks.enable();
  try {
    await local.run(true, () =>
      readFile(join(f.artifactDir, "input-segments", audio.id + ".blob")),
    );
    assert.ok(reads > 0, "filesystem observation must detect a real read");
    reads = 0;
    for (const ref of [audio, video])
      await assert.rejects(
        local.run(true, async () => {
          for await (const _event of adapter.streamTurn(
            {
              runId: "direct-negative-fixture",
              turnIndex: 0,
              modelId: "unsupported-fixture",
              messages: [
                {
                  role: "user",
                  content: "quoted unsupported media",
                  media: [ref],
                },
              ],
              tools: [],
            },
            new AbortController().signal,
          )) {
            /* no event permitted */
          }
        }),
        code("PROVIDER_UNSUPPORTED_INPUT"),
      );
  } finally {
    hooks.disable();
  }
  assert.equal(reads, 0);
  assert.equal(fetched, 0);
});
