import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import {
  acquireExecutionLock,
  assertExecutionLockAvailable as verifyExecutionIdle,
} from "../tools/command/execution-lock.js";
import {
  FileKnowledgePublicationHost,
  type FileKnowledgePublicationApplyInput,
} from "./file-publication-fs.js";
import type { KnowledgeHostBinding } from "./types.js";
import { knowledgeHash, sha256 } from "./validation.js";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof EngineError && error.code === expected;
}
function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-file-publication-")),
    ),
    root = join(base, "workspace"),
    artifacts = join(base, "artifacts");
  mkdirSync(root);
  mkdirSync(artifacts);
  const db = new DatabaseSync(join(base, "head.sqlite"));
  db.exec(
    "CREATE TABLE heads(path TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
  );
  const physical = (selected: string) => {
    const stat = lstatSync(selected, { bigint: true });
    return {
      path: selected,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
    };
  };
  const storage = {
      database: physical(join(base, "head.sqlite")),
      artifacts: physical(artifacts),
    },
    rootMeta = lstatSync(root, { bigint: true });
  const binding: KnowledgeHostBinding = Object.freeze({
    workspaceId: "physical-fixture",
    root,
    rootDevice: rootMeta.dev.toString(),
    rootInode: rootMeta.ino.toString(),
    storageBindingSha256: knowledgeHash(storage),
  });
  let revisionReads = 0,
    bindingReads = 0,
    guards = 0,
    releases = 0;
  const lockPath = join(base, "effects.sqlite");
  const host = new FileKnowledgePublicationHost({
    checkBinding: () => {
      bindingReads++;
      return binding;
    },
    readTargetRevision: (_binding, relative) => {
      revisionReads++;
      return Number(
        db.prepare("SELECT revision FROM heads WHERE path=?").get(relative)
          ?.revision ?? 0,
      );
    },
    acquireExecutionGuard: () => {
      guards++;
      const original = acquireExecutionLock(lockPath);
      return {
        release: (confirmed: boolean) => {
          releases++;
          original.release(confirmed);
        },
      };
    },
  });
  t.after(() => {
    db.close();
    if (process.env.MOODCODE_HOST_VALIDATION_PRESERVE_FIXTURES === "1")
      t.diagnostic(`Preserved native fixture: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    root,
    artifacts,
    binding,
    host,
    db,
    lockPath,
    counts: () => ({ revisionReads, guards, releases }),
    bindingReads: () => bindingReads,
    input: (
      beforeEffect: () => void | Promise<void>,
      changes: Partial<FileKnowledgePublicationApplyInput> = {},
    ): FileKnowledgePublicationApplyInput => ({
      operation: "publish",
      body: "Actual approved file content.\n",
      publicationId: randomUUID(),
      deadline: Date.now() + 5000,
      beforeEffect,
      ...changes,
    }),
  };
}

test("raw synchronous physical read never invokes native revision; original capture preserves bounded UTF8 and nanosecond pins", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Astral 🧠 and CRLF\r\n");
  const raw = f.host.observeTargetSync(f.binding, "MEMORY.md");
  assert.equal(f.counts().revisionReads, 0);
  assert.equal(raw.sha256, sha256("Astral 🧠 and CRLF\r\n"));
  assert.equal(raw.bytes, Buffer.byteLength("Astral 🧠 and CRLF\r\n"));
  assert.match(raw.mtimeNs!, /^\d+$/);
  assert.equal(raw.parentPins[0]!.path, ".");
  const prepared = await f.host.captureTarget(f.binding, "MEMORY.md");
  assert.equal(prepared.beforeContent, "Astral 🧠 and CRLF\r\n");
  assert.deepEqual(prepared.observation, raw);
  assert.equal(prepared.revision, 0);
  assert.ok(Object.isFrozen(prepared.observation.parentPins));
  await f.host.assertFresh(prepared.capture);
  await f.host.assertFresh(prepared.capture);
  assert.equal(f.counts().guards, 0);
  f.host.releaseCapture(prepared.capture);
  await assert.rejects(
    f.host.assertFresh(prepared.capture),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
});

test("original skill preview creates no parents; durable intent precedes every actual mkdir/write and closed file afterimage is observed", async (t) => {
  const f = fixture(t),
    relative = ".moodcode/skills/authored/SKILL.md",
    prepared = await f.host.captureTarget(f.binding, relative);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  assert.deepEqual(prepared.observation.missingParents, [
    ".moodcode",
    ".moodcode/skills",
    ".moodcode/skills/authored",
  ]);
  let intent = 0;
  const result = await f.host.apply(
    prepared.capture,
    f.input(() => {
      intent++;
      assert.equal(existsSync(join(f.root, ".moodcode")), false);
      assert.throws(() => verifyExecutionIdle(f.lockPath));
    }),
  );
  assert.equal(intent, 1);
  assert.equal(result.state, "applied", JSON.stringify(result));
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(
    result.checkpoint.createdParents,
    prepared.observation.missingParents,
  );
  assert.equal(result.after!.sha256, sha256("Actual approved file content.\n"));
  assert.equal(result.after!.present, true);
  assert.equal(
    readFileSync(join(f.root, relative), "utf8"),
    "Actual approved file content.\n",
  );
  assert.equal(lstatSync(join(f.root, relative)).nlink, 1);
  assert.deepEqual(readdirSync(join(f.root, ".moodcode/skills/authored")), [
    "SKILL.md",
  ]);
  assert.equal(result.checkpoint.partial, false);
  assert.equal(result.checkpoint.createdFiles.length, 2);
  assert.equal(result.checkpoint.removedFiles.length, 1);
  verifyExecutionIdle(f.lockPath);
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {}),
    ),
    code("KNOWLEDGE_FILE_CAPTURE_USED"),
  );
});

test("actual existing file replacement preserves mode and revocation observes absence without manufacturing native target revisions", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Original.");
  chmodSync(join(f.root, "MEMORY.md"), 0o640);
  const before = lstatSync(join(f.root, "MEMORY.md"));
  const prepared = await f.host.captureTarget(f.binding, "MEMORY.md"),
    result = await f.host.apply(
      prepared.capture,
      f.input(() => {}),
    );
  assert.equal(result.state, "applied", JSON.stringify(result));
  assert.equal(result.after!.mode, 0o640);
  assert.notEqual(result.after!.inode, String(before.ino));
  assert.deepEqual(result.checkpoint.replacedFiles, ["MEMORY.md"]);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM heads").get()!.n, 0);
  verifyExecutionIdle(f.lockPath);
  const revoke = await f.host.captureTarget(f.binding, "MEMORY.md"),
    removed = await f.host.apply(
      revoke.capture,
      f.input(() => {}, { operation: "revoke", body: "" }),
    );
  assert.equal(removed.state, "applied", JSON.stringify(removed));
  assert.equal(removed.after!.present, false);
  assert.deepEqual(removed.checkpoint.removedFiles, ["MEMORY.md"]);
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  verifyExecutionIdle(f.lockPath);
});

test("copied/foreign/proxy/getter inputs and stale native revisions invoke no physical producer", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Original.");
  const prepared = await f.host.captureTarget(f.binding, "MEMORY.md");
  let traps = 0;
  const copied = { ...prepared.capture };
  await assert.rejects(
    f.host.apply(
      copied,
      f.input(() => {}),
    ),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  const proxy = new Proxy(prepared.capture, {
    get() {
      traps++;
      throw Error("trap");
    },
  });
  await assert.rejects(
    f.host.assertFresh(proxy),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  const input = f.input(() => {});
  Object.defineProperty(input, "body", {
    enumerable: true,
    get() {
      traps++;
      return "Hostile";
    },
  });
  await assert.rejects(
    f.host.apply(prepared.capture, input),
    code("INVALID_KNOWLEDGE_FILE"),
  );
  assert.equal(traps, 0);
  const second = new FileKnowledgePublicationHost({
    checkBinding: () => f.binding,
    readTargetRevision: () => 0,
    acquireExecutionGuard: () => {
      throw Error("producer must not run");
    },
  });
  await assert.rejects(
    second.assertFresh(prepared.capture),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  f.db.prepare("INSERT INTO heads VALUES(?,1)").run("MEMORY.md");
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {}),
    ),
    code("KNOWLEDGE_FILE_STALE"),
  );
  assert.equal(f.counts().guards, 0);
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), "Original.");
});

test("native signal brand and descriptors reject before physical capture freshness or apply effects", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Original native preimage.\n");
  const prepared = await f.host.captureTarget(
      f.binding,
      "MEMORY.md",
      Object.assign(new AbortController().signal, {
        hostObservation: "safe data",
        [Symbol("hostObservation")]: "safe symbol data",
      }),
    ),
    counts = f.counts(),
    bindingReads = f.bindingReads();
  let traps = 0,
    intents = 0;
  const accessor = (key: PropertyKey) =>
    Object.defineProperty(new AbortController().signal, key, {
      get() {
        traps++;
        throw Error("signal getter must not execute");
      },
    });
  const override = (key: string) =>
    Object.defineProperty(new AbortController().signal, key, {
      value: () => {
        traps++;
        throw Error("signal override must not execute");
      },
    });
  const invalid = [
    ["own aborted accessor", accessor("aborted")],
    ["own reason accessor", accessor("reason")],
    ["own addEventListener", override("addEventListener")],
    ["own removeEventListener", override("removeEventListener")],
    ["other own accessor", accessor("hostObservation")],
    ["own symbol accessor", accessor(Symbol("hostObservation"))],
    ["prototype without native brand", Object.create(AbortSignal.prototype)],
    ["null signal", null as unknown as AbortSignal],
    ["primitive signal", 1 as unknown as AbortSignal],
  ] as const;
  for (const [label, signal] of invalid) {
    await t.test(`${label} / captureTarget`, async () => {
      await assert.rejects(
        f.host.captureTarget(f.binding, "MEMORY.md", signal),
        code("INVALID_KNOWLEDGE_FILE"),
      );
    });
    await t.test(`${label} / assertFresh`, async () => {
      await assert.rejects(
        f.host.assertFresh(prepared.capture, signal),
        code("INVALID_KNOWLEDGE_FILE"),
      );
    });
    await t.test(`${label} / apply`, async () => {
      await assert.rejects(
        f.host.apply(
          prepared.capture,
          f.input(() => {
            intents++;
          }, { signal }),
        ),
        code("INVALID_KNOWLEDGE_FILE"),
      );
    });
  }
  assert.equal(traps, 0);
  assert.equal(intents, 0);
  assert.deepEqual(f.counts(), counts);
  assert.equal(f.bindingReads(), bindingReads);
  assert.equal(
    readFileSync(join(f.root, "MEMORY.md"), "utf8"),
    "Original native preimage.\n",
  );
  assert.deepEqual(readdirSync(f.root), ["MEMORY.md"]);
  await assert.rejects(
    f.host.captureTarget(f.binding, "MEMORY.md", AbortSignal.abort()),
    code("KNOWLEDGE_FILE_CANCELLED"),
  );
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {
        intents++;
      }, { signal: AbortSignal.abort() }),
    ),
    code("KNOWLEDGE_FILE_CANCELLED"),
  );
  assert.deepEqual(f.counts(), counts);
  assert.equal(f.bindingReads(), bindingReads);
  await f.host.assertFresh(prepared.capture, new AbortController().signal);
  f.host.releaseCapture(prepared.capture);
});

test("physical source edits, symlink and hardlink substitutions reject before intent or target writes", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Original.");
  const prepared = await f.host.captureTarget(f.binding, "MEMORY.md");
  writeFileSync(join(f.root, "MEMORY.md"), "Changed externally.");
  let intents = 0;
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {
        intents++;
      }),
    ),
    code("KNOWLEDGE_FILE_STALE"),
  );
  assert.equal(intents, 0);
  assert.equal(f.counts().guards, 0);
  writeFileSync(join(f.base, "outside.md"), "Outside preserved.");
  unlinkSync(join(f.root, "MEMORY.md"));
  symlinkSync(join(f.base, "outside.md"), join(f.root, "MEMORY.md"));
  await assert.rejects(
    f.host.captureTarget(f.binding, "MEMORY.md"),
    code("KNOWLEDGE_FILE_UNSAFE"),
  );
  assert.equal(
    readFileSync(join(f.base, "outside.md"), "utf8"),
    "Outside preserved.",
  );
  unlinkSync(join(f.root, "MEMORY.md"));
  linkSync(join(f.base, "outside.md"), join(f.root, "MEMORY.md"));
  await assert.rejects(
    f.host.captureTarget(f.binding, "MEMORY.md"),
    code("KNOWLEDGE_FILE_UNSAFE"),
  );
  assert.throws(
    () => f.host.observeTargetSync(f.binding, "MEMORY.md"),
    code("KNOWLEDGE_FILE_UNSAFE"),
  );
});

test("failed durable callback creates no skill parent or file and real execution guard is released", async (t) => {
  const f = fixture(t),
    prepared = await f.host.captureTarget(
      f.binding,
      ".moodcode/skills/no-effect/SKILL.md",
    );
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {
        throw new EngineError(
          "ACTUAL_APPROVAL_STALE",
          "Current approval no longer matches",
        );
      }),
    ),
    code("ACTUAL_APPROVAL_STALE"),
  );
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  assert.deepEqual(f.counts(), { revisionReads: 3, guards: 1, releases: 1 });
  verifyExecutionIdle(f.lockPath);
});

test("actual parent symlink swap across awaited intent yields no target effect and preserves outside file", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "memory"));
  writeFileSync(join(f.root, "memory", "MEMORY.md"), "Original.");
  mkdirSync(join(f.base, "outside"));
  writeFileSync(join(f.base, "outside", "MEMORY.md"), "Outside preserved.");
  const prepared = await f.host.captureTarget(f.binding, "memory/MEMORY.md");
  const result = await f.host.apply(
    prepared.capture,
    f.input(async () => {
      await Promise.resolve();
      renameSync(join(f.root, "memory"), join(f.root, "old-memory"));
      symlinkSync(join(f.base, "outside"), join(f.root, "memory"));
    }),
  );
  assert.equal(result.state, "uncertain");
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.checkpoint.createdFiles, []);
  assert.deepEqual(result.checkpoint.replacedFiles, []);
  assert.equal(
    readFileSync(join(f.root, "old-memory", "MEMORY.md"), "utf8"),
    "Original.",
  );
  assert.equal(
    readFileSync(join(f.base, "outside", "MEMORY.md"), "utf8"),
    "Outside preserved.",
  );
  verifyExecutionIdle(f.lockPath);
});

test("root moved after intent await yields no file effect, and pre-abort/deadline never acquires execution guard", async (t) => {
  const f = fixture(t),
    prepared = await f.host.captureTarget(f.binding, "MEMORY.md");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {}, { signal: abort.signal }),
    ),
    code("KNOWLEDGE_FILE_CANCELLED"),
  );
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {}, { deadline: Date.now() }),
    ),
    code("KNOWLEDGE_FILE_DEADLINE"),
  );
  assert.equal(f.counts().guards, 0);
  const result = await f.host.apply(
    prepared.capture,
    f.input(async () => {
      await Promise.resolve();
      renameSync(f.root, join(f.base, "original-root"));
      mkdirSync(f.root);
    }),
  );
  assert.equal(result.state, "uncertain");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.after, null);
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  assert.equal(existsSync(join(f.base, "original-root", "MEMORY.md")), false);
  verifyExecutionIdle(f.lockPath);
});

test("cancellation after durable intent drains original operation and returns observed zero-effect uncertainty with confirmed handle cleanup", async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    prepared = await f.host.captureTarget(
      f.binding,
      ".moodcode/skills/cancelled/SKILL.md",
    );
  let intent = 0;
  const result = await f.host.apply(
    prepared.capture,
    f.input(
      async () => {
        intent++;
        await Promise.resolve();
        controller.abort();
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(intent, 1);
  assert.equal(result.state, "uncertain");
  assert.equal(result.errorCode, "KNOWLEDGE_FILE_CANCELLED");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.after!.present, false);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  verifyExecutionIdle(f.lockPath);
});

test("cancellation after actual first skill directory preserves exact partial effect and confirms real guard cleanup", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let didAbort = false;
  const host = new FileKnowledgePublicationHost({
    checkBinding: () => {
      if (!didAbort && existsSync(join(f.root, ".moodcode"))) {
        didAbort = true;
        controller.abort();
      }
      return f.binding;
    },
    readTargetRevision: () => 0,
    acquireExecutionGuard: () => acquireExecutionLock(f.lockPath),
  });
  const prepared = await host.captureTarget(
      f.binding,
      ".moodcode/skills/partial/SKILL.md",
    ),
    result = await host.apply(
      prepared.capture,
      f.input(() => {}, { signal: controller.signal }),
    );
  assert.equal(didAbort, true);
  assert.equal(result.state, "uncertain");
  assert.equal(result.errorCode, "KNOWLEDGE_FILE_CANCELLED");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.checkpoint.partial, true);
  assert.deepEqual(result.checkpoint.createdParents, [".moodcode"]);
  assert.deepEqual(result.checkpoint.createdFiles, []);
  assert.equal(existsSync(join(f.root, ".moodcode")), true);
  assert.equal(existsSync(join(f.root, ".moodcode/skills")), false);
  verifyExecutionIdle(f.lockPath);
});

test("actual external preimage edit after owned temporary creation is preserved; original descriptor closes and exact temporary cleanup is observed", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "Original.");
  let mutated = false;
  const host = new FileKnowledgePublicationHost({
    checkBinding: () => {
      if (
        !mutated &&
        readdirSync(f.root).some((value) => value.endsWith(".tmp"))
      ) {
        mutated = true;
        writeFileSync(
          join(f.root, "MEMORY.md"),
          "Concurrent external content.",
        );
      }
      return f.binding;
    },
    readTargetRevision: () => 0,
    acquireExecutionGuard: () => acquireExecutionLock(f.lockPath),
  });
  const prepared = await host.captureTarget(f.binding, "MEMORY.md"),
    result = await host.apply(
      prepared.capture,
      f.input(() => {}),
    );
  assert.equal(mutated, true);
  assert.equal(result.state, "uncertain");
  assert.equal(result.errorCode, "KNOWLEDGE_FILE_STALE");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.after!.sha256, sha256("Concurrent external content."));
  assert.deepEqual(result.checkpoint.replacedFiles, []);
  assert.equal(result.checkpoint.createdFiles.length, 1);
  assert.deepEqual(
    result.checkpoint.removedFiles,
    result.checkpoint.createdFiles,
  );
  assert.equal(
    readFileSync(join(f.root, "MEMORY.md"), "utf8"),
    "Concurrent external content.",
  );
  assert.deepEqual(readdirSync(f.root), ["MEMORY.md"]);
  verifyExecutionIdle(f.lockPath);
});

test("bounded invalid text/deep paths/non-skill missing parents never dispatch; same-tick capture capacity counts outstanding reads", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "invalid.md"), Buffer.from([0xff]));
  await assert.rejects(
    f.host.captureTarget(f.binding, "invalid.md"),
    code("KNOWLEDGE_FILE_UNSAFE"),
  );
  await assert.rejects(
    f.host.captureTarget(f.binding, Array(65).fill("a").join("/")),
    code("KNOWLEDGE_FILE_LIMIT"),
  );
  const prepared = await f.host.captureTarget(f.binding, "generic/missing.md");
  await assert.rejects(
    f.host.apply(
      prepared.capture,
      f.input(() => {}),
    ),
    code("KNOWLEDGE_FILE_PARENT_UNSUPPORTED"),
  );
  assert.equal(existsSync(join(f.root, "generic")), false);
  f.host.releaseCapture(prepared.capture);
  const pending = Array.from({ length: 129 }, () =>
    f.host.captureTarget(f.binding, "absent.md"),
  );
  const outcomes = await Promise.allSettled(pending);
  assert.equal(
    outcomes.filter((value) => value.status === "fulfilled").length,
    128,
  );
  assert.equal(
    outcomes.filter(
      (value) =>
        value.status === "rejected" &&
        code("KNOWLEDGE_FILE_LIMIT")(value.reason),
    ).length,
    1,
  );
  assert.equal(f.counts().guards, 0);
  for (const value of outcomes)
    if (value.status === "fulfilled")
      f.host.releaseCapture(value.value.capture);
});

test("release-all waits for original effect callback, then invalidates all remaining opaque captures without file writes", async (t) => {
  const f = fixture(t),
    prepared = await f.host.captureTarget(f.binding, "MEMORY.md");
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const original = f.host.apply(
    prepared.capture,
    f.input(async () => {
      entered();
      await gate;
      throw new EngineError("ACTUAL_APPROVAL_STALE", "No write approval.");
    }),
  );
  await ready;
  assert.throws(() => f.host.releaseAllCaptures(), code("KNOWLEDGE_FILE_BUSY"));
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  resume();
  await assert.rejects(original, code("ACTUAL_APPROVAL_STALE"));
  f.host.releaseAllCaptures();
  await assert.rejects(
    f.host.assertFresh(prepared.capture),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  verifyExecutionIdle(f.lockPath);
});
