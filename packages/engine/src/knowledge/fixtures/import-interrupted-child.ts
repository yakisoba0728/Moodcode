import assert from "node:assert/strict";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { HostGenerationRequest } from "../../provider/generation.js";
import { KnowledgeGenerationStorage } from "../generation-store.js";
import type { KnowledgeGenerationObservation } from "../generation-types.js";
import type { KnowledgeSourceSelection } from "../host.js";
import { canonicalKnowledge, sha256 } from "../validation.js";

const [directoryArgument, phaseArgument] = process.argv.slice(2);
if (!directoryArgument || !["prepared", "streaming"].includes(phaseArgument!))
  throw new Error("Invalid actual interrupted-import boundary");
const directory = directoryArgument,
  phase = phaseArgument!;
const config = JSON.parse(
  readFileSync(join(directory, "interrupted-config.json"), "utf8"),
) as {
  workspaceId: string;
  planId: string;
  requestId: string;
  requestSha256: string;
  requestBytes: number;
  selection: KnowledgeSourceSelection[];
};
const provider: ProviderAdapter = {
  id: "import-interrupted-fixture",
  async *streamTurn() {
    appendFileSync(join(directory, "unexpected-coding.log"), "UNEXPECTED\n");
    throw new Error("Host generation cannot create a coding Turn");
  },
  streamGeneration(request: HostGenerationRequest) {
    appendFileSync(
      join(directory, "actual-provider-calls.jsonl"),
      JSON.stringify({
        owner: request.owner,
        sha256: sha256(canonicalKnowledge(request)),
        bytes: Buffer.byteLength(canonicalKnowledge(request)),
      }) + "\n",
    );
    const events: ProviderEvent[] = [
      { type: "usage", inputTokens: 7, outputTokens: 2 },
      {
        type: "text.delta",
        delta: "Actual partial output before SIGKILL 한글😀.\n",
      },
    ];
    let index = 0;
    const iterator: AsyncIterableIterator<ProviderEvent> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next() {
        const event = events[index++];
        return event
          ? { done: false, value: event }
          : new Promise<IteratorResult<ProviderEvent>>(() => {});
      },
      async return() {
        appendFileSync(
          join(directory, "unexpected-cleanup.log"),
          "return-called\n",
        );
        return { done: true, value: undefined };
      },
    };
    return iterator;
  },
};
const engine = createEngine({
  dbPath: join(directory, "source.sqlite"),
  artifactDir: join(directory, "source-artifacts"),
  tools: [],
  providers: [provider],
  knowledgeGeneration: true,
  defaults: { providerId: provider.id, modelId: "interrupted-model" },
});
function stop(generationId: string) {
  const native = Reflect.get(
    engine,
    "knowledgeGenerations",
  ) as KnowledgeGenerationStorage;
  assert.ok(native instanceof KnowledgeGenerationStorage);
  const generation = native.getGeneration(config.workspaceId, generationId),
    attempt = native.getAttempt(config.workspaceId, generation.attemptId!);
  const temporary = join(directory, "interrupted-ready.json.temporary");
  writeFileSync(temporary, JSON.stringify({ phase, generation, attempt }), {
    mode: 0o600,
  });
  renameSync(temporary, join(directory, "interrupted-ready.json"));
  process.kill(process.pid, "SIGSTOP");
  throw new Error(
    "Parent must kill the exact stopped worker without resuming it",
  );
}
const method = phase === "prepared" ? "prepareAttempt" : "observe",
  descriptor = Object.getOwnPropertyDescriptor(
    KnowledgeGenerationStorage.prototype,
    method,
  )!;
assert.equal(typeof descriptor.value, "function");
Object.defineProperty(KnowledgeGenerationStorage.prototype, method, {
  ...descriptor,
  value(this: KnowledgeGenerationStorage, ...args: unknown[]) {
    const result = Reflect.apply(
      descriptor.value as (...args: unknown[]) => unknown,
      this,
      args,
    );
    if (
      phase === "prepared" ||
      (args[2] as KnowledgeGenerationObservation).textDelta !== undefined
    )
      stop((args[0] as { generationId: string }).generationId);
    return result;
  },
});
const projection = engine.captureWorkspaceKnowledgeSources(
    config.workspaceId,
    config.selection,
  ),
  preview = engine.previewWorkspaceKnowledgeGeneration({
    providerId: provider.id,
    modelId: "interrupted-model",
    projection,
  });
assert.equal(preview.requestSha256, config.requestSha256);
assert.equal(preview.requestBytes, config.requestBytes);
await engine.generateWorkspaceKnowledge({
  workspaceId: config.workspaceId,
  planId: config.planId,
  requestId: config.requestId,
  projection,
});
throw new Error(`Original producer failed to stop at ${phase}`);
