import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import { OpenAICompatibleProvider } from "../provider/openai-compatible.js";
import type {
  JsonObject,
  InputMediaAttachment,
  MessagePart,
} from "@moodcode/contracts";
import { avi, wav } from "./segment-fixtures.js";
import { decodePcmWave } from "./segments.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  spec,
  fixture,
  stream,
  accept,
  parts,
} from "./segment-engine-fixture.js";
test("actual Engine resolves WAV samples and AVI PNG frames into frozen Chat payload with exact timestamps and no raw context bytes", async (t) => {
  const f = await fixture(t),
    audio = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
      { startMs: 250, endMs: 500 },
    ]),
    video = await f.engine.importMedia(f.sessionId, avi(), "video/x-msvideo", [
      { startMs: 0, endMs: 1000 },
    ]);
  const { run, result } = await accept(f, [audio, video]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(run?.state, "completed", JSON.stringify(run));
  assert.equal(f.requests.length, 1);
  const messages = f.requests[0]!.messages as unknown as Array<{
    content: Array<{
      type: string;
      text?: string;
      input_audio?: { data: string };
      image_url?: { url: string };
    }>;
  }>;
  const blocks = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content : [],
  );
  const wavBlock = blocks.find((b) => b.type === "input_audio")!;
  assert.equal(
    decodePcmWave(Buffer.from(wavBlock.input_audio!.data, "base64")).durationMs,
    250,
  );
  assert.equal(blocks.filter((b) => b.type === "image_url").length, 2);
  assert.ok(blocks.some((b) => b.text?.includes('"startMs":500')));
  const snapshot = f.engine.store.getSnapshot(f.sessionId);
  assert.deepEqual(snapshot.messages.find((m) => m.role === "user")?.media, [
    audio,
    video,
  ]);
  assert.equal(
    JSON.stringify(snapshot).includes(wavBlock.input_audio!.data),
    false,
  );
  assert.equal(
    f.engine.context.diagnostics(f.sessionId)?.plan.inputEstimate.mediaTokens,
    null,
  );
  const duplicate = await accept(f, [audio, video]);
  assert.equal(duplicate.run?.id, run!.id);
  assert.equal(f.requests.length, 1);
});
test("genuine streamed audio becomes provider-owned native media Part and complete real WAV Artifact without fabricated Tool", async (t) => {
  const f = await fixture(t, { output: true }),
    { run } = await accept(f);
  assert.equal(run?.state, "completed", JSON.stringify(run));
  const media = parts(f.engine, run!.id).find((p) => p.type === "media")!;
  assert.equal(media.type, "media");
  if (media.type !== "media") return;
  assert.equal(media.state, "completed");
  assert.equal(media.mime, "audio/wav");
  assert.ok("source" in media.artifact.identity);
  assert.equal("toolCallId" in media.artifact.identity, false);
  assert.equal(media.artifact.complete, true);
  const bytes = await readFile(
    join(f.artifactDir, "managed", media.artifact.id, "content"),
  );
  assert.deepEqual([...decodePcmWave(bytes).samples], [0, 0, 1, 0, 2, 0, 3, 0]);
  assert.equal(f.engine.store.getSnapshot(f.sessionId).tools.length, 0);
  const metric = f.engine.store.getNativeMetrics(f.sessionId);
  assert.equal(metric.attemptUsage.samples, 0);
  await f.engine.close();
  const reopened = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
  });
  f.engines.push(reopened);
  assert.deepEqual(
    parts(reopened, run!.id).find((p) => p.type === "media"),
    media,
  );
  assert.equal(f.requests.length, 1);
});
test("partial actual audio is retained as interrupted Artifact/failed Part and is never replayed on reopen", async (t) => {
  const f = await fixture(t, { output: true, partial: true }),
    { run } = await accept(f);
  assert.equal(run?.state, "failed", JSON.stringify(run));
  const media = parts(f.engine, run!.id).find((p) => p.type === "media");
  assert.ok(media?.type === "media");
  assert.equal(media.state, "failed");
  assert.equal(media.artifact.complete, false);
  assert.equal(media.artifact.outcome, "interrupted");
  assert.equal(f.requests.length, 1);
  await f.engine.close();
  const reopened = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
  });
  f.engines.push(reopened);
  assert.deepEqual(
    parts(reopened, run!.id).find((p) => p.type === "media"),
    media,
  );
  assert.equal(f.requests.length, 1);
});
test("unknown capability, unknown cost and deleted/foreign source reject before actual provider effect", async (t) => {
  for (const option of [{ caps: false }, { allow: false }, {}]) {
    const f = await fixture(t, option),
      ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
        { startMs: 0, endMs: 100 },
      ]);
    if (Object.keys(option).length === 0)
      await unlink(join(f.artifactDir, "input-segments", ref.id + ".blob"));
    const { result } = await accept(f, [ref]);
    assert.equal(result.ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.engine.store.getSnapshot(f.sessionId).runs.length, 0);
  }
});
test("real archive preserves source segment and provider output history, imported engine never dispatches", async (t) => {
  const f = await fixture(t, { output: true }),
    ref = await f.engine.importMedia(f.sessionId, wav(), "audio/wav", [
      { startMs: 0, endMs: 100 },
    ]),
    { run } = await accept(f, [ref]);
  assert.equal(run?.state, "completed");
  const before = parts(f.engine, run!.id);
  await f.engine.close();
  const directory = join(f.root, "archive");
  await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: directory,
  });
  const imported = await importEngineArchive({
    directory,
    destination: join(f.root, "imported"),
  });
  const reopened = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.push(reopened);
  assert.deepEqual(parts(reopened, run!.id), before);
  assert.deepEqual(
    reopened.store.getSessionDocument(f.sessionId, "input_media_segments")?.data
      .attachments,
    [ref],
  );
  assert.equal(f.requests.length, 1);
});
