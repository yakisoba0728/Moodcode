import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "./validation.js";
import { FileKnowledgePublicationHost } from "./file-publication-fs.js";
import {
  BODY,
  BODY2,
  TARGET,
  failure,
  invoke,
  filePublicationFixture as fixture,
  type FilePreview,
  type FilePublicationResult,
} from "./fixtures/file-publication.js";

test("actual pending file candidate and original preview create no directories, file, coding owner or effect receipt", async (t) => {
  const f = await fixture(t),
    candidate = await f.candidate(),
    preview = await f.preview(candidate);
  assert.equal(candidate.target.kind, "workspace-file");
  assert.equal(candidate.target.revision, 0);
  assert.equal(candidate.state, "pending");
  assert.equal(preview.operation, "publish");
  assert.equal(preview.diff.before, "");
  assert.equal(preview.diff.after, BODY);
  assert.equal(preview.diff.afterSha256, sha256(BODY));
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual approved skill creation updates native revision and exact duplicate uses historical receipt without another effect", async (t) => {
  const f = await fixture(t),
    candidate = await f.candidate(),
    preview = await f.preview(candidate),
    result = await f.publish(preview, "file-original-request");
  assert.equal(result.publication.state, "completed");
  assert.equal(readFileSync(join(f.root, TARGET), "utf8"), BODY);
  assert.equal(result.duplicate, false);
  const target = f.engine.captureWorkspaceKnowledgeTarget(
    f.workspace.id,
    TARGET,
  );
  assert.equal(target.revision, 1);
  assert.equal(target.sha256, sha256(BODY));
  const duplicate = await f.publish(preview, "file-original-request");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.id, result.receipt.id);
  assert.equal(duplicate.receipt.sha256, result.receipt.sha256);
  assert.equal(readFileSync(join(f.root, TARGET), "utf8"), BODY);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual existing file update and revoke bind postimage rather than original generation target preimage", async (t) => {
  const f = await fixture(t),
    first = await f.candidate("MEMORY.md"),
    created = await f.publish(await f.preview(first));
  assert.equal(created.publication.state, "completed");
  const next = await f.candidate("MEMORY.md", BODY2);
  assert.equal(next.target.revision, 1);
  assert.equal(next.target.sha256, sha256(BODY));
  const updated = await f.publish(await f.preview(next));
  assert.equal(updated.publication.state, "completed");
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY2);
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
      .revision,
    2,
  );
  const revoked = await f.revoke(await f.revokePreview(updated.publication.id));
  assert.equal(revoked.publication.state, "completed");
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  const target = f.engine.captureWorkspaceKnowledgeTarget(
    f.workspace.id,
    "MEMORY.md",
  );
  assert.equal(target.revision, 3);
  assert.equal(target.sha256, null);
  f.assertNoCoding();
});

for (const mode of [
  "copy",
  "foreign",
  "release",
  "source",
  "target",
  "trust",
  "aborted",
] as const)
  test(`actual ${mode} file approval cannot create an effect from an invalid original capture`, async (t) => {
    const f = await fixture(t),
      candidate = await f.candidate("MEMORY.md"),
      original = await f.preview(candidate);
    let preview = original,
      current = f.engine,
      signal: AbortSignal | undefined;
    if (mode === "copy") preview = structuredClone(original);
    if (mode === "foreign") {
      const other = await fixture(t);
      current = other.engine;
    }
    if (mode === "release")
      invoke<void>(
        f.engine,
        "releaseWorkspaceKnowledgeFilePublicationPreview",
        original,
      );
    if (mode === "source")
      writeFileSync(
        join(f.root, "origin.ts"),
        "export const actualOrigin = 2;\n",
      );
    if (mode === "target")
      writeFileSync(
        join(f.root, "MEMORY.md"),
        "External original target must survive.\n",
      );
    if (mode === "trust") {
      const trust = f.engine.workspaceKnowledge.getTrust(f.workspace.id)!;
      await f.engine.setWorkspaceTrust({
        workspaceId: f.workspace.id,
        requestId: "file-denied",
        expectedRevision: trust.revision,
        decision: "deny",
      });
    }
    if (mode === "aborted") signal = AbortSignal.abort();
    await assert.rejects(
      f.publish(preview, `rejected-${mode}`, current, signal),
      failure(),
    );
    assert.equal(existsSync(join(f.root, TARGET)), false);
    if (mode === "target")
      assert.equal(
        readFileSync(join(f.root, "MEMORY.md"), "utf8"),
        "External original target must survive.\n",
      );
    else assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
    assert.equal(f.generations.length, 1);
    f.assertNoCoding();
  });

test("actual default-off file publication rejects original candidate with no physical effect", async (t) => {
  const f = await fixture(t, false),
    candidate = await f.candidate("MEMORY.md");
  await assert.rejects(f.preview(candidate), failure());
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  f.assertNoCoding();
});

test("actual preview getter and proxy traps run zero times before host history, target, or effect access", async (t) => {
  const f = await fixture(t);
  let traps = 0;
  const input = { workspaceId: f.workspace.id, candidateId: "not-read" };
  Object.defineProperty(input, "candidateId", {
    enumerable: true,
    get() {
      traps++;
      throw new Error("Hostile getter");
    },
  });
  await assert.rejects(
    invoke<Promise<FilePreview>>(
      f.engine,
      "previewWorkspaceKnowledgeFilePublication",
      input,
    ),
    failure(),
  );
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error("Hostile proxy");
      },
    },
  );
  await assert.rejects(
    invoke<Promise<FilePreview>>(
      f.engine,
      "previewWorkspaceKnowledgeFilePublication",
      proxy,
    ),
    failure(),
  );
  assert.equal(traps, 0);
  assert.equal(f.generations.length, 0);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  f.assertNoCoding();
});

test("actual close and same physical restart retain exact completed file receipt without generation or apply replay", async (t) => {
  const f = await fixture(t),
    candidate = await f.candidate("MEMORY.md"),
    result = await f.publish(await f.preview(candidate), "file-restart");
  await f.engine.close();
  const reopened = f.reopen(),
    historical = invoke<FilePublicationResult["publication"]>(
      reopened,
      "getWorkspaceKnowledgeFilePublication",
      f.workspace.id,
      result.publication.id,
    );
  assert.equal(historical.state, "completed");
  const receipt = invoke<FilePublicationResult["receipt"]>(
    reopened,
    "getWorkspaceKnowledgeFilePublicationReceipt",
    f.workspace.id,
    "file-restart",
  );
  assert.equal(receipt.sha256, result.receipt.sha256);
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
  assert.equal(f.generations.length, 1);
  assert.equal(
    reopened.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
      .revision,
    1,
  );
  f.assertNoCoding();
});

test("actual file revoke reduces authority after source deletion and current trust deny while preserving exact published postimage", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.root, "sources"));
  writeFileSync(
    join(f.root, "sources/origin.ts"),
    "export const separateSource = 1;\n",
  );
  const candidate = await f.candidate(
      "MEMORY.md",
      BODY,
      f.engine,
      "sources/origin.ts",
    ),
    published = await f.publish(await f.preview(candidate));
  const trust = f.engine.workspaceKnowledge.getTrust(f.workspace.id)!;
  await f.engine.setWorkspaceTrust({
    workspaceId: f.workspace.id,
    requestId: "deny-before-revoke",
    expectedRevision: trust.revision,
    decision: "deny",
  });
  rmSync(join(f.root, "sources/origin.ts"));
  const preview = await f.revokePreview(published.publication.id);
  assert.equal(preview.diff.before, BODY);
  const revoked = await f.revoke(preview, "revoke-reduced-authority");
  assert.equal(revoked.publication.state, "completed");
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
      .revision,
    2,
  );
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual committed original file request stays historical after source and trust changes and cannot authorize a new ID or budget", async (t) => {
  const f = await fixture(t),
    candidate = await f.candidate("MEMORY.md"),
    preview = await f.preview(candidate),
    committed = await f.publish(preview, "exact-file-history");
  writeFileSync(join(f.root, "origin.ts"), "export const actualOrigin = 99;\n");
  const trust = f.engine.workspaceKnowledge.getTrust(f.workspace.id)!;
  await f.engine.setWorkspaceTrust({
    workspaceId: f.workspace.id,
    requestId: "deny-after-file-history",
    expectedRevision: trust.revision,
    decision: "deny",
  });
  const duplicate = await f.publish(preview, "exact-file-history");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.sha256, committed.receipt.sha256);
  await assert.rejects(
    f.publish(preview, "another-file-history"),
    failure("KNOWLEDGE_FILE_PREVIEW_USED"),
  );
  await assert.rejects(
    invoke<Promise<FilePublicationResult>>(
      f.engine,
      "publishWorkspaceKnowledgeFile",
      {
        workspaceId: f.workspace.id,
        requestId: "exact-file-history",
        preview,
        approved: true,
        budget: { maxDurationMs: 5001 },
      },
    ),
    failure("KNOWLEDGE_FILE_PREVIEW_USED"),
  );
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual concurrent original file previews cannot acquire a second workspace effect and the losing preimage stays stale", async (t) => {
  const f = await fixture(t),
    candidate = await f.candidate("MEMORY.md"),
    first = await f.preview(candidate),
    second = await f.preview(candidate),
    untouched = await f.preview(candidate);
  const host = Reflect.get(f.engine, "knowledgeFileHost");
  assert.ok(host instanceof FileKnowledgePublicationHost);
  const original = host.apply;
  let start!: () => void,
    release!: () => void,
    applyCalls = 0;
  const ready = new Promise<void>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.apply = (capture, input) => {
    applyCalls++;
    return original.call(host, capture, {
      ...input,
      beforeEffect: async () => {
        await input.beforeEffect();
        start();
        await gate;
      },
    });
  };
  t.after(() => {
    release();
    host.apply = original;
  });
  const pending = f.publish(first, "same-frontier-first");
  await Promise.race([
    ready,
    pending.then(() => {
      throw new Error(
        "Original file producer completed before the ready boundary",
      );
    }),
  ]);
  try {
    await assert.rejects(f.publish(second, "same-frontier-losing"), (error) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.ok(
        error.code === "WORKSPACE_BUSY" || error.code === "CLEANUP_PENDING",
      );
      return true;
    });
    assert.equal(applyCalls, 1);
    assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  } finally {
    release();
  }
  const committed = await pending;
  assert.equal(committed.publication.state, "completed");
  await assert.rejects(
    f.publish(second, "same-frontier-losing"),
    failure("KNOWLEDGE_FILE_PREVIEW_USED"),
  );
  await assert.rejects(
    f.publish(untouched, "same-frontier-stale"),
    failure("KNOWLEDGE_FILE_STALE"),
  );
  assert.equal(applyCalls, 1);
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
      .revision,
    1,
  );
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual revoke stays exact after another skill and a root sibling change parent timestamps", async (t) => {
  const f = await fixture(t),
    path = ".moodcode/skills/first/SKILL.md",
    first = await f.publish(await f.preview(await f.candidate(path)));
  await f.publish(
    await f.preview(await f.candidate(".moodcode/skills/second/SKILL.md")),
  );
  writeFileSync(join(f.root, "sibling.md"), "Unrelated root entry.\n");
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, path).revision,
    1,
  );
  const revoked = await f.revoke(await f.revokePreview(first.publication.id));
  assert.equal(revoked.publication.state, "completed");
  assert.equal(existsSync(join(f.root, path)), false);
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, path).revision,
    2,
  );
  f.assertNoCoding();
});

test("actual 16 KiB bodies publish, update and revoke through their previews", async (t) => {
  const f = await fixture(t),
    first = "a".repeat(16383) + "\n",
    second = "b".repeat(16383) + "\n";
  await f.publish(await f.preview(await f.candidate("MEMORY.md", first)));
  const updated = await f.publish(
    await f.preview(await f.candidate("MEMORY.md", second)),
  );
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), second);
  const revoked = await f.revoke(
    await f.revokePreview(updated.publication.id),
  );
  assert.equal(revoked.publication.state, "completed");
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  f.assertNoCoding();
});

test("actual target capture cannot advance the head of an in-flight publication", async (t) => {
  const f = await fixture(t),
    preview = await f.preview(await f.candidate("MEMORY.md"));
  const host = Reflect.get(f.engine, "knowledgeFileHost");
  assert.ok(host instanceof FileKnowledgePublicationHost);
  const original = host.apply;
  let refused: unknown;
  host.apply = async (capture, input) => {
    const outcome = await original.call(host, capture, input);
    try {
      f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md");
    } catch (error) {
      refused = error;
    }
    return outcome;
  };
  t.after(() => {
    host.apply = original;
  });
  const result = await f.publish(preview);
  assert.equal(result.publication.state, "completed");
  failure("KNOWLEDGE_FILE_BUSY")(refused);
  assert.equal(
    f.engine.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
      .revision,
    1,
  );
  f.assertNoCoding();
});
