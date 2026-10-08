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
export const spec = {
  providerId: "audio-fixture",
  modelId: "explicit-fixture-model",
  contextWindow: 1000000,
  maxOutputTokens: 100000,
  modalities: ["text", "image", "audio", "video"] as const,
  mediaCapabilities: { audioInput: true, videoFrames: true, audioOutput: true },
  tools: true,
  reasoning: false,
  nativeReplay: false,
  source: { kind: "fixture" as const, observedAt: "2026-10-08T00:00:00Z" },
};
export function stream(audio = false, partial = false): Response {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const choices = (delta: unknown, finish_reason: unknown = null) => ({
    choices: [{ index: 0, delta, finish_reason }],
  });
  const frames = audio
    ? [
        choices({
          audio: {
            id: "fixture-audio-1",
            data: pcm.subarray(0, 4).toString("base64"),
          },
        }),
        ...(partial
          ? []
          : [
              choices({
                audio: {
                  data: pcm.subarray(4).toString("base64"),
                  transcript: "Local generated sound",
                },
              }),
              choices({}, "stop"),
              choices({ audio: { expires_at: 1893456000 } }),
            ]),
      ]
    : [
        choices({ content: "Observed exact local source" }),
        choices({}, "stop"),
      ];
  return new Response(
    frames.map((v) => "data: " + JSON.stringify(v) + "\n\n").join("") +
      (partial ? "" : "data: [DONE]\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  );
}
export async function fixture(
  t: test.TestContext,
  options: {
    output?: boolean;
    partial?: boolean;
    allow?: boolean;
    caps?: boolean;
    response?: () => Response;
    engine?: Partial<import("../engine.js").EngineOptions>;
    limits?: Record<string, number>;
  } = {},
) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-segments-")),
    ),
    repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  const requests: JsonObject[] = [];
  const provider = new OpenAICompatibleProvider({
    id: spec.providerId,
    audioModelIds: [spec.modelId],
    videoModelIds: [spec.modelId],
    ...(options.output
      ? {
          outputAudio: {
            modelIds: [spec.modelId],
            voice: "alloy",
            sampleRate: 24000,
            channels: 1,
          },
        }
      : {}),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return options.response?.() ?? stream(options.output, options.partial);
    },
  });
  const dbPath = join(root, "engine.sqlite"),
    artifactDir = join(root, "artifacts");
  const engine = createEngine({
    dbPath,
    artifactDir,
    providers: [provider],
    modelSpecs: options.caps === false ? [] : [spec],
    allowUnknownMediaTokenCost: options.allow !== false,
    defaults: {
      providerId: spec.providerId,
      modelId: spec.modelId,
      limits: {
        maxOutputBytes: 1048576,
        maxContextBytes: 1048576,
        ...options.limits,
      },
    },
    ...options.engine,
  });
  const engines = [engine];
  t.after(async () => {
    for (const e of engines) await e.close();
    await rm(root, { recursive: true, force: true });
  });
  const opened = await engine.dispatch({
    schemaVersion: 1,
    commandId: "open",
    type: "workspace.open",
    payload: { path: repo },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  const created = await engine.dispatch({
    schemaVersion: 1,
    commandId: "create",
    type: "session.create",
    payload: { workspaceId: (opened.result as JsonObject).id },
  });
  assert.equal(created.ok, true);
  return {
    root,
    dbPath,
    artifactDir,
    engine,
    engines,
    requests,
    sessionId: (created.result as JsonObject).id as string,
  };
}
export async function accept(
  f: Awaited<ReturnType<typeof fixture>>,
  media: InputMediaAttachment[] = [],
  requestId = "media",
) {
  const result = await f.engine.dispatchSession({
    schemaVersion: 2,
    commandId: requestId,
    type: "input.accept",
    payload: {
      sessionId: f.sessionId,
      requestId,
      prompt: "Inspect quoted local media",
      media,
      delivery: "queue",
    },
  });
  if (!result.ok) return { result, run: null };
  await f.engine.scheduler.waitForSession(f.sessionId);
  const id = f.engine.store.getInput(
    (result.result as JsonObject).inputId as string,
  ).runId!;
  return { result, run: await f.engine.coordinator.waitForRun(id) };
}
export function parts(engine: MoodcodeEngine, runId: string): MessagePart[] {
  return engine.store
    .listTurns(runId)
    .flatMap((turn) => engine.store.listParts(turn.id));
}
