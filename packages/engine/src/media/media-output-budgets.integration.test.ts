import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture, parts } from "./segment-engine-fixture.js";
import { decodePcmWave } from "./segments.js";

// The genuine wire fixture emits eight PCM bytes. Its complete WAV is 52 bytes.
// These ceilings belong to the admitted Run, while the managed store stays at
// the larger engine defaults; narrowing the global store would hide the bug.
const PCM_BYTES = 8;
const WAV_BYTES = 44 + PCM_BYTES;
for (const budget of ["maxArtifactBytes", "maxProducerBytes"] as const) {
  for (const ceiling of [WAV_BYTES - 1, WAV_BYTES]) {
    test(`actual Run ${budget}=${ceiling} counts the WAV header before media publication`, async (t) => {
      const f = await fixture(t, { output: true });
      const budgets = {
        maxArtifactBytes: 4096,
        maxProducerBytes: 4096,
        [budget]: ceiling,
      };
      const requestId = `media-run-${budget}-${ceiling}`;
      const command = {
        schemaVersion: 2 as const,
        commandId: requestId,
        type: "input.accept" as const,
        payload: {
          sessionId: f.sessionId,
          requestId,
          prompt: "Generate the locally supplied wire fixture audio",
          delivery: "queue" as const,
          config: { budgets },
        },
      };
      const accepted = await f.engine.dispatchSession(command);
      assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
      const inputId = (accepted.result as { inputId: string }).inputId;
      await f.engine.scheduler.waitForSession(f.sessionId);
      const input = f.engine.store.getInput(inputId);
      assert.ok(input.runId);
      const run = await f.engine.coordinator.waitForRun(input.runId);
      assert.equal(run.config.budgets?.[budget], ceiling);
      assert.equal(f.requests.length, 1);
      assert.equal(f.engine.store.getSnapshot(f.sessionId).tools.length, 0);
      const turns = f.engine.store.listTurns(run.id);
      assert.equal(turns.length, 1);
      const attempt = f.engine.store.getLatestAttemptForTurn(turns[0]!.id);
      assert.ok(attempt);
      assert.equal(attempt.runId, run.id);
      const cleanup = f.engine.store.getAttemptCleanup(attempt.id, f.sessionId);
      assert.equal(cleanup.state, "confirmed");
      assert.equal(cleanup.cleanupConfirmed, true);
      const media = parts(f.engine, run.id).filter((p) => p.type === "media");
      const published = (await readdir(join(f.artifactDir, "managed"))).filter(
        (name) => name.startsWith("artifact_"),
      );
      if (ceiling < WAV_BYTES) {
        assert.ok(
          run.state === "failed" || run.state === "interrupted",
          JSON.stringify(run),
        );
        assert.ok(
          run.error?.code === "ARTIFACT_LIMIT" ||
            run.error?.code === "CLEANUP_UNCERTAIN",
          JSON.stringify(run.error),
        );
        assert.equal(media.length, 0, "no oversized native media Part");
        assert.deepEqual(published, [], "no oversized physical publication");
      } else {
        assert.equal(run.state, "completed", JSON.stringify(run));
        assert.equal(media.length, 1);
        const part = media[0]!;
        assert.equal(part.state, "completed");
        assert.equal(part.artifact.complete, true);
        assert.equal(part.artifact.storedBytes, WAV_BYTES);
        assert.equal(part.artifact.observedBytes, WAV_BYTES);
        assert.ok("source" in part.artifact.identity);
        assert.equal(part.artifact.identity.source, "provider");
        assert.equal(part.artifact.identity.attemptId, attempt.id);
        assert.equal("toolCallId" in part.artifact.identity, false);
        assert.equal(part.artifact.producerTruncatedBytes, 0);
        assert.equal(part.artifact.artifactTruncatedBytes, 0);
        assert.deepEqual(published, [part.artifact.id]);
        const content = await readFile(
          join(f.artifactDir, "managed", part.artifact.id, "content"),
        );
        assert.equal(content.byteLength, WAV_BYTES);
        assert.equal(decodePcmWave(content).samples.byteLength, PCM_BYTES);
        assert.deepEqual([...decodePcmWave(content).samples], [0, 0, 1, 0, 2, 0, 3, 0]);
      }
      const duplicate = await f.engine.dispatchSession(command);
      assert.equal(duplicate.ok, true, JSON.stringify(duplicate.error));
      assert.equal((duplicate.result as { inputId: string }).inputId, inputId);
      assert.equal(f.requests.length, 1, "duplicate native input cannot replay");
    });
  }
}
