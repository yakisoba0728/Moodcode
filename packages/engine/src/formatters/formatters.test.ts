import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, type Checkpoint } from "@moodcode/contracts";
import type { ToolContext } from "../ports.js";
import {
  FormatterRegistry,
  createFormatTool,
  applyTextEdits,
} from "./index.js";
const code = (expected: string) => (e: unknown) => {
  assert.equal((e as { code: string }).code, expected);
  return true;
};
test("text edits respect UTF16, BOM and CRLF and reject invalid/overlapping/ambiguous ranges", () => {
  const source = "\ufeff😀bad\r\nnext\r\n";
  const range = {
    start: { line: 0, character: 3 },
    end: { line: 0, character: 6 },
  };
  assert.equal(
    applyTextEdits(source, [{ range, newText: "good" }]),
    "\ufeff😀good\r\nnext\r\n",
  );
  assert.throws(
    () =>
      applyTextEdits(source, [
        {
          range: {
            start: { line: 0, character: 2 },
            end: { line: 0, character: 3 },
          },
          newText: "x",
        },
      ]),
    code("INVALID_FORMAT_RANGE"),
  );
  assert.throws(
    () =>
      applyTextEdits(source, [
        { range, newText: "x" },
        { range, newText: "y" },
      ]),
    code("FORMAT_EDITS_OVERLAP"),
  );
  assert.throws(
    () =>
      applyTextEdits(source, [
        {
          range: {
            start: { line: 99, character: 0 },
            end: { line: 99, character: 0 },
          },
          newText: "x",
        },
      ]),
    code("INVALID_FORMAT_RANGE"),
  );
  assert.throws(
    () => applyTextEdits(source, [{ range, newText: "\0" }]),
    code("INVALID_FORMAT_EDIT"),
  );
  assert.equal(applyTextEdits(source, null), source);
});
async function fixture(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-format-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a"), "bad");
  const checkpoints: Checkpoint[] = [];
  const context: ToolContext = {
    workspace: {
      id: "w",
      root,
      gitRoot: root,
      branch: null,
      createdAt: new Date().toISOString(),
    },
    sessionId: "s",
    runId: "r",
    toolCallId: "format",
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS },
    artifactDir: root,
    recordCheckpoint: (cp) => checkpoints.push(cp),
  };
  return { root, context, checkpoints };
}
test("host formatter receives observed text and result waits for approval/checkpoint before file effects", async (t) => {
  const { root, context, checkpoints } = await fixture(t);
  const registry = new FormatterRegistry();
  registry.register("fixture", async ({ content }) => {
    assert.equal(content, "bad");
    return "good";
  });
  const tool = createFormatTool(registry);
  const prepared = await tool.prepare(
    { path: "a", formatterId: "fixture" },
    context,
  );
  assert.equal(prepared.requiresApproval, true);
  assert.equal(await readFile(join(root, "a"), "utf8"), "bad");
  await tool.execute(prepared, context);
  assert.equal(await readFile(join(root, "a"), "utf8"), "good");
  assert.equal(checkpoints.length, 1);
});
test("formatter cancellation or changed registration never publishes stale proposal", async (t) => {
  const { context } = await fixture(t);
  const registry = new FormatterRegistry();
  let entered!: () => void;
  const handshake = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const dispose = registry.register("wait", async () => {
    entered();
    return new Promise<string>(() => {});
  });
  const controller = new AbortController();
  const pending = registry.propose(
    context.workspace,
    "wait",
    "a",
    controller.signal,
  );
  await handshake;
  controller.abort();
  await assert.rejects(pending, code("CANCELLED"));
  dispose();
  await assert.rejects(
    registry.propose(
      context.workspace,
      "wait",
      "a",
      new AbortController().signal,
    ),
    code("FORMATTER_UNAVAILABLE"),
  );
});
test("formatter external preimage change and invalid binary result are rejected without applying", async (t) => {
  const { root, context } = await fixture(t);
  const registry = new FormatterRegistry();
  registry.register("changed", async () => {
    await writeFile(join(root, "a"), "external");
    return "good";
  });
  await assert.rejects(
    registry.propose(context.workspace, "changed", "a", context.signal),
    code("FORMAT_PREIMAGE_STALE"),
  );
  assert.equal(await readFile(join(root, "a"), "utf8"), "external");
  registry.register("binary", async () => "\0");
  await assert.rejects(
    registry.propose(context.workspace, "binary", "a", context.signal),
    code("INVALID_FORMAT_RESULT"),
  );
});
