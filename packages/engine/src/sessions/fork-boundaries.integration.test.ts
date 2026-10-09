import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTerminal,
  type RunReceipt,
  type Workspace,
  type Session,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { OpenAICompatibleProvider } from "../provider/openai-compatible.js";
import { avi, wav } from "../media/segment-fixtures.js";
import {
  forkFixture,
  forkUntil,
  forkCounts,
  forkCommand,
} from "./fixtures/fork.js";

for (const kind of ["audio", "video"] as const)
  for (const disposition of ["exact-replay", "semantic"] as const)
    test(`actual ${kind} input refuses ${disposition} fork before materialization and preserves its native source`, async (t) => {
      const evidence = process.env.MOODCODE_FORK_MEDIA_EVIDENCE_DIR;
      if (evidence) mkdirSync(evidence, { recursive: true });
      const directory = realpathSync(
          mkdtempSync(join(evidence ?? tmpdir(), "moodcode-fork-media-")),
        ),
        root = join(directory, "repo"),
        dbPath = join(directory, "engine.sqlite"),
        artifactDir = join(directory, "artifacts");
      mkdirSync(root);
      writeFileSync(join(root, "seed.txt"), "original media source\n");
      execFileSync("git", ["init", "--quiet", "--template=", root]);
      execFileSync("git", ["-C", root, "add", "seed.txt"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "authored media source",
      ]);
      let calls = 0;
      const providerId = "fork-media-fixture",
        modelId = "fork-media-model";
      const provider = new OpenAICompatibleProvider({
        id: providerId,
        audioModelIds: [modelId],
        videoModelIds: [modelId],
        fetch: async () => {
          calls++;
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Observed local media source"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const engine = createEngine({
        dbPath,
        artifactDir,
        providers: [provider],
        conversationForks: true,
        allowUnknownMediaTokenCost: true,
        modelSpecs: [
          {
            providerId,
            modelId,
            contextWindow: 1_000_000,
            maxOutputTokens: 10_000,
            modalities: ["text", "image", "audio", "video"],
            mediaCapabilities: {
              audioInput: true,
              videoFrames: true,
              audioOutput: false,
            },
            tools: true,
            reasoning: false,
            nativeReplay: false,
            source: { kind: "fixture", observedAt: "2026-10-09T00:00:00Z" },
          },
        ],
        defaults: {
          providerId,
          modelId,
          mode: "plan",
          limits: {
            maxTurns: 2,
            maxDurationMs: 10_000,
            maxContextBytes: 131_072,
          },
        },
      });
      const primary = Reflect.get(engine.store, "db") as DatabaseSync,
        owner = Reflect.get(engine.store, "ownership") as DatabaseSync;
      t.after(async () => {
        const before = {
          primaryIsOpen: primary.isOpen,
          ownerIsOpen: owner.isOpen,
        };
        try {
          await engine.close();
        } finally {
          if (evidence)
            writeFileSync(
              join(directory, "close-evidence.json"),
              JSON.stringify({
                before,
                after: {
                  primaryIsOpen: primary.isOpen,
                  ownerIsOpen: owner.isOpen,
                },
                retainedOriginalFixture: directory,
              }) + "\n",
            );
        }
        assert.equal(primary.isOpen, false);
        assert.equal(owner.isOpen, false);
        if (!evidence) rmSync(directory, { recursive: true, force: true });
        else t.diagnostic(`Retained original native fixture: ${directory}`);
      });
      const workspace = await forkCommand<Workspace>(engine, "workspace.open", {
          path: root,
        }),
        session = await forkCommand<Session>(engine, "session.create", {
          workspaceId: workspace.id,
          title: "Actual media source",
        });
      const bytes = kind === "audio" ? wav() : avi(),
        mime = kind === "audio" ? "audio/wav" : "video/x-msvideo";
      const media = await engine.importMedia(session.id, bytes, mime, [
        { startMs: 0, endMs: 1_000 },
      ]);
      assert.equal(media.kind, kind);
      const receipt = await forkCommand<RunReceipt>(engine, "run.submit", {
        sessionId: session.id,
        requestId: "actual-media-source",
        prompt: "Inspect the exact imported source",
        media: JSON.parse(JSON.stringify([media])),
      });
      const run = await engine.waitForRun(receipt.runId);
      assert.equal(run.state, "completed", JSON.stringify(run));
      const snapshot = engine.store.getSnapshot(session.id),
        events = engine.store.readEvents(session.id, 0),
        counts = forkCounts(dbPath),
        callsBefore = calls;
      assert.deepEqual(
        snapshot.messages.find((message) => message.role === "user")?.media,
        [media],
      );
      const blob = join(artifactDir, "input-segments", media.id + ".blob");
      assert.deepEqual(readFileSync(blob), bytes);
      try {
        await assert.rejects(
          engine.captureForkPreview({
            sourceSessionId: session.id,
            throughRunId: run.id,
            prompt: "Readonly fork",
            disposition,
          }),
          { code: "FORK_MEDIA_UNSUPPORTED" },
        );
      } finally {
        assert.deepEqual(forkCounts(dbPath), counts);
        assert.equal(calls, callsBefore);
        assert.deepEqual(engine.store.getSnapshot(session.id), snapshot);
        assert.deepEqual(engine.store.readEvents(session.id, 0), events);
        assert.deepEqual(readFileSync(blob), bytes);
      }
    });
test("actual nonterminal source and cancelled unresolved tool cannot authorize a frozen fork", async (t) => {
  const f = await forkFixture(t, { skipSource: true }),
    receipt = await forkCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: "held-source",
      prompt: "source",
      config: JSON.parse(JSON.stringify(f.config)),
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "No actual pending tool",
  );
  const count = forkCounts(f.dbPath);
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    { code: "FORK_SOURCE_ACTIVE" },
  );
  assert.deepEqual(forkCounts(f.dbPath), count);
  await f.engine.coordinator.cancel(receipt.runId);
  await forkUntil(
    () => isTerminal(f.engine.store.getRun(receipt.runId).state),
    "Source cancel has not reached native terminal",
  );
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    { code: "FORK_CLEANUP_UNCERTAIN" },
  );
});
test("native source SQL identity alias is rejected before snapshot grant or model entry", async (t) => {
  const f = await forkFixture(t),
    db = new DatabaseSync(f.dbPath),
    calls = f.entries.length,
    count = forkCounts(f.dbPath);
  try {
    const row = db
        .prepare("SELECT id,data FROM messages WHERE session_id=? LIMIT 1")
        .get(f.session.id)!,
      body = JSON.parse(String(row.data));
    body.id = "borrowed-native-message";
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      JSON.stringify(body),
      row.id!,
    );
    await assert.rejects(
      f.engine.captureForkPreview({
        sourceSessionId: f.session.id,
        prompt: "forged",
      }),
      { code: "FORK_NATIVE_INVALID" },
    );
    assert.deepEqual(forkCounts(f.dbPath), count);
    assert.equal(f.entries.length, calls);
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      String(row.data),
      row.id!,
    );
  } finally {
    db.close();
  }
});
test("fixed context budget and late catalogue drift reject before a new actual provider or native first input", async (t) => {
  const f = await forkFixture(t),
    count = forkCounts(f.dbPath),
    calls = f.entries.length;
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
      config: { limits: { maxContextBytes: 1024 } },
    }),
    { code: "FORK_CONTEXT_LIMIT" },
  );
  const o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    p = f.engine.readForkPreview(o);
  f.engine.profiles.register({
    id: "moodcode-conversation-fork-readonly",
    description: "changed host profile",
    instructions: "read only",
    tools: ["read_file"],
  });
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: o,
        requestId: "stale-profile",
        approved: true,
        approvalFingerprint: p.sha256,
      }),
    { code: "FORK_PROFILE_STALE" },
  );
  assert.deepEqual(forkCounts(f.dbPath), count);
  assert.equal(f.entries.length, calls);
});
test("accepted readonly fork is fenced at real queue promotion when its pinned profile changes", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "queued-fork",
    }),
    p = f.engine.readForkPreview(o),
    wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = async () => {};
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "queued-stale",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  f.engine.scheduler.wake = wake;
  const calls = f.entries.length;
  f.engine.profiles.register({
    id: "moodcode-conversation-fork-readonly",
    description: "new revision",
    instructions: "read only",
    tools: ["read_file"],
  });
  await assert.rejects(f.engine.scheduler.wake(r.record.sessionId), {
    code: "FORK_TARGET_STALE",
  });
  assert.equal(f.entries.length, calls);
  assert.equal(
    f.engine.store.getInput(r.record.input.inputId).state,
    "pending",
  );
  assert.equal(f.engine.store.getSnapshot(r.record.sessionId).runs.length, 0);
  assert.equal(f.effects(), "effect\n");
});
test("fully changed native first input cannot rewrite the independent actual acceptance receipt", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "queued-fork",
    }),
    p = f.engine.readForkPreview(o),
    wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = async () => {};
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "input-tamper",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  f.engine.scheduler.wake = wake;
  const db = new DatabaseSync(f.dbPath);
  try {
    const row = db
      .prepare("SELECT data FROM session_inputs WHERE id=?")
      .get(r.record.input.inputId)!;
    const data = JSON.parse(String(row.data));
    data.admittedSeq += 1;
    db.prepare(
      "UPDATE session_inputs SET data=?,admitted_seq=? WHERE id=?",
    ).run(JSON.stringify(data), data.admittedSeq, r.record.input.inputId);
    assert.throws(
      () => f.engine.inspectConversationLineage(r.record.sessionId),
      { code: "FORK_NATIVE_INVALID" },
    );
    db.prepare(
      "UPDATE session_inputs SET data=?,admitted_seq=? WHERE id=?",
    ).run(String(row.data), r.record.input.admittedSeq, r.record.input.inputId);
  } finally {
    db.close();
  }
});
test("oversized current native body is rejected from metadata before history projection", async (t) => {
  const f = await forkFixture(t),
    db = new DatabaseSync(f.dbPath);
  try {
    const row = db
        .prepare("SELECT id,data FROM messages WHERE session_id=? LIMIT 1")
        .get(f.session.id)!,
      body = JSON.parse(String(row.data));
    body.content = "x".repeat(300000);
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      JSON.stringify(body),
      row.id!,
    );
    await assert.rejects(
      f.engine.captureForkPreview({
        sourceSessionId: f.session.id,
        prompt: "large",
      }),
      { code: "FORK_LIMIT" },
    );
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      String(row.data),
      row.id!,
    );
  } finally {
    db.close();
  }
});
