import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { EngineOptions } from "../engine.js";
import type { ProviderEvent } from "../ports.js";
import { observationFixture, stop } from "./fixtures/execution-observation.js";

for (const excluded of ["Git metadata", "owned artifact"] as const)
  test(`actual core reads of excluded ${excluded} remain unknown and an external edit permits rereading`, async (t) => {
    const extra: Partial<EngineOptions> = {},
      relative =
        excluded === "Git metadata"
          ? ".git/private-observed-file"
          : ".state/artifacts/private-observed-file";
    const f = await observationFixture(t, {
      extra,
      setup(root) {
        if (excluded === "owned artifact") {
          extra.dbPath = join(root, ".state/engine.sqlite");
          extra.artifactDir = join(root, ".state/artifacts");
          mkdirSync(extra.artifactDir, { recursive: true });
        }
        writeFileSync(join(root, relative), "before excluded source\n");
      },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 1)
          writeFileSync(join(f.root, relative), "after excluded source\n");
        if (request.turnIndex < 2) {
          yield {
            type: "tool.call",
            call: {
              id: `excluded-${request.turnIndex}`,
              name: "read_file",
              input: { path: relative },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    });
    const submitted = await f.submit(),
      run = await f.engine.waitForRun(submitted.runId),
      rows = f.page(run.id).items;
    assert.equal(run.state, "completed");
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.resultSha256, rows[1]!.resultSha256);
    for (const row of rows) {
      assert.equal(row.sourceBefore.completeness, "unknown");
      assert.equal(row.sourceBefore.sha256, null);
      assert.equal(row.sourceAfter?.completeness, "unknown");
    }
    assert.equal(f.stall(run.id).signal, "unknown");
  });
