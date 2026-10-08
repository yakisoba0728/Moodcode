import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../engine.js";
import { OpenAICompatibleProvider } from "../../provider/openai-compatible.js";
import { ArtifactStore } from "../../artifacts/store.js";
import type { JsonObject } from "@moodcode/contracts";
const [rootArgument, mode] = process.argv.slice(2);
if (!rootArgument || !mode) throw new Error("fixture args required");
const root: string = rootArgument;
let engine: ReturnType<typeof createEngine>;
let sessionId = "",
  runId = "";
let stopped = false;
function stop(stage: string) {
  if (stopped) return;
  stopped = true;
  const data = { stage, sessionId, runId, pid: process.pid };
  writeFileSync(join(root, "ready.tmp"), JSON.stringify(data));
  renameSync(join(root, "ready.tmp"), join(root, "ready.json"));
  process.kill(process.pid, "SIGSTOP");
}
const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
const frame = (delta: unknown, reason: unknown = null) =>
  "data: " +
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) +
  "\n\n";
const wire =
  frame({ audio: { id: "crash-audio", data: pcm.toString("base64") } }) +
  frame({}, "stop") +
  frame({ audio: { expires_at: 1893456000 } }) +
  "data: [DONE]\n\n";
const provider = new OpenAICompatibleProvider({
  id: "crash-audio",
  outputAudio: {
    modelIds: ["explicit-local"],
    voice: "alloy",
    sampleRate: 24000,
    channels: 1,
  },
  fetch: async () =>
    new Response(
      mode === "streaming"
        ? new ReadableStream({
            start(c) {
              c.enqueue(
                Buffer.from(
                  frame({
                    audio: { id: "crash-audio", data: pcm.toString("base64") },
                  }),
                ),
              );
            },
          })
        : wire,
      { headers: { "content-type": "text/event-stream" } },
    ),
});
engine = createEngine({
  dbPath: join(root, "engine.sqlite"),
  artifactDir: join(root, "artifacts"),
  providers: [provider],
  allowUnknownMediaTokenCost: true,
  defaults: { providerId: provider.id, modelId: "explicit-local" },
  modelSpecs: [
    {
      providerId: provider.id,
      modelId: "explicit-local",
      contextWindow: null,
      maxOutputTokens: null,
      modalities: ["text", "audio"],
      mediaCapabilities: {
        audioInput: false,
        videoFrames: false,
        audioOutput: true,
      },
      tools: false,
      reasoning: false,
      nativeReplay: false,
      source: { kind: "fixture", observedAt: "2026-10-08T00:00:00Z" },
    },
  ],
});
if (mode === "published") {
  const put = ArtifactStore.prototype.put;
  ArtifactStore.prototype.put = async function (input) {
    const result = await put.call(this, input);
    if ("source" in input.identity) stop("published");
    return result;
  };
}
if (mode === "receipt") {
  const put = engine.store.putPart.bind(engine.store);
  engine.store.putPart = (part) => {
    const result = put(part);
    if (part.type === "media") stop("receipt");
    return result;
  };
}
const opened = await engine.dispatch({
  schemaVersion: 1,
  commandId: "open",
  type: "workspace.open",
  payload: { path: join(root, "repo") },
});
if (!opened.ok) throw new Error(JSON.stringify(opened.error));
const created = await engine.dispatch({
  schemaVersion: 1,
  commandId: "create",
  type: "session.create",
  payload: { workspaceId: (opened.result as JsonObject).id },
});
sessionId = (created.result as JsonObject).id as string;
const admitted = await engine.dispatchSession({
  schemaVersion: 2,
  commandId: "accept",
  type: "input.accept",
  payload: {
    sessionId,
    requestId: "crash-source",
    prompt: "Fixture owned audio",
    delivery: "queue",
  },
});
if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
const inputId = (admitted.result as JsonObject).inputId as string;
const observe = setInterval(() => {
  runId = engine.store.getInput(inputId).runId ?? "";
  if (
    mode === "streaming" &&
    runId &&
    engine.store.listTurns(runId).some((t) => t.state === "streaming")
  )
    stop("streaming");
}, 5);
await engine.scheduler.waitForSession(sessionId);
runId = engine.store.getInput(inputId).runId!;
const run = await engine.coordinator.waitForRun(runId);
if (run.state !== "completed") throw new Error(JSON.stringify(run));
clearInterval(observe);
if (mode === "settled") stop("settled");
await engine.close();
