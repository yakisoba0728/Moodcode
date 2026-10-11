import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { FileKnowledgePublicationHost } from "./file-publication-fs.js";
import {
  acquireExecutionLock,
  inspectExecutionLock,
} from "../tools/command/execution-lock.js";
import {
  BODY,
  failure,
  filePublicationFixture,
  invoke,
} from "./fixtures/file-publication.js";
import type { KnowledgeFilePublicationStorage } from "./file-publication-store.js";
import type { KnowledgeFilePublicationRecord } from "./file-publication-types.js";
import {
  KnowledgeFilePublicationService,
  type KnowledgeFilePublicationServicePorts,
  type WorkspaceKnowledgeFilePublicationInput,
  type WorkspaceKnowledgeFilePublicationPreviewInput,
} from "./file-publication-service.js";

/** Negative boundary probes carry no invented history, physical success or native receipt. */
function boundary() {
  let portCalls = 0;
  const unavailable = (): never => {
    portCalls++;
    throw new Error("No host producer/history should be reached by this input");
  };
  const ports: KnowledgeFilePublicationServicePorts = {
    native: {
      captureTarget: unavailable,
      getCurrentTarget: unavailable,
      findRequest: unavailable,
      prepare: unavailable,
      dispatch: unavailable,
      complete: unavailable,
      uncertain: unavailable,
      cancel: unavailable,
      release: unavailable,
      getOwner: unavailable,
      getCommitted: unavailable,
    },
    host: {
      captureTarget: unavailable,
      assertFresh: unavailable,
      releaseCapture: unavailable,
      apply: unavailable,
      observeTargetSync: unavailable,
    },
    getCandidate: unavailable,
    getPlan: unavailable,
    getGeneration: unavailable,
    getAttempt: unavailable,
    getTrustRevision: unavailable,
    getTrust: unavailable,
    checkBinding: unavailable,
    assertUnpaused: unavailable,
    assertTrustSourcesCurrent: unavailable,
    assertSourcesCurrent: unavailable,
    withLease: unavailable,
  };
  return {
    service: new KnowledgeFilePublicationService(ports),
    calls: () => portCalls,
  };
}
const typedError = (error: unknown) => {
  assert.ok(error instanceof EngineError);
  return true;
};

test("file preview rejects executable getters, proxies, symbols and unknown fields before any history or filesystem port", async () => {
  const f = boundary();
  let traps = 0;
  const getter = { workspaceId: "workspace", candidateId: "candidate" };
  Object.defineProperty(getter, "candidateId", {
    enumerable: true,
    get() {
      traps++;
      throw new Error("Getter");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error("Proxy");
      },
    },
  );
  for (const value of [
    getter,
    proxy,
    {
      workspaceId: "workspace",
      candidateId: "candidate",
      rawBody: "unapproved",
    },
    {
      workspaceId: "workspace",
      candidateId: "candidate",
      [Symbol("extra")]: true,
    },
  ])
    await assert.rejects(
      f.service.previewPublish(
        value as WorkspaceKnowledgeFilePublicationPreviewInput,
      ),
      typedError,
    );
  assert.equal(traps, 0);
  assert.equal(f.calls(), 0);
  await f.service.close();
});

test("file publication requires an original opaque preview and never trusts copied descriptive fields", async () => {
  const f = boundary();
  let traps = 0;
  const fake = {
    workspaceId: "workspace",
    operation: "publish",
    sha256: "a".repeat(64),
    pins: {},
  };
  for (const preview of [
    fake,
    structuredClone(fake),
    new Proxy(fake, {
      get() {
        traps++;
        throw new Error("Preview proxy");
      },
    }),
  ])
    await assert.rejects(
      f.service.publish({
        workspaceId: "workspace",
        requestId: "request",
        approved: true,
        preview,
      } as unknown as WorkspaceKnowledgeFilePublicationInput),
      typedError,
    );
  assert.equal(traps, 0);
  assert.equal(f.calls(), 0);
  await f.service.close();
});

test("file approval input getters are rejected before selecting the opaque preview or operator approval", async () => {
  const f = boundary();
  let reads = 0;
  const input = {
    workspaceId: "workspace",
    requestId: "request",
    approved: true,
    preview: {},
  };
  Object.defineProperty(input, "approved", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("Approval getter");
    },
  });
  await assert.rejects(
    f.service.publish(
      input as unknown as WorkspaceKnowledgeFilePublicationInput,
    ),
    typedError,
  );
  assert.equal(reads, 0);
  assert.equal(f.calls(), 0);
  await f.service.close();
});

test("file close denies new preview and operation admission without creating a native owner", async () => {
  const f = boundary();
  await f.service.close();
  await assert.rejects(
    f.service.previewPublish({
      workspaceId: "workspace",
      candidateId: "candidate",
    }),
    (error) => error instanceof EngineError && error.code === "ENGINE_CLOSED",
  );
  await assert.rejects(
    f.service.publish({
      workspaceId: "workspace",
      requestId: "request",
      approved: true,
      preview: {},
    } as WorkspaceKnowledgeFilePublicationInput),
    (error) => error instanceof EngineError && error.code === "ENGINE_CLOSED",
  );
  assert.equal(f.calls(), 0);
});

test("actual service consumes its Engine native store and physical executor, preserving one original approval and receipt", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate("MEMORY.md");
  const service = Reflect.get(f.engine, "knowledgeFilePublicationService");
  assert.ok(service instanceof KnowledgeFilePublicationService);
  const preview = await service.previewPublish({
    workspaceId: f.workspace.id,
    candidateId: candidate.id,
  });
  const result = await service.publish({
    workspaceId: f.workspace.id,
    requestId: "service-actual-original",
    approved: true,
    preview,
  });
  assert.equal(result.publication.state, "completed");
  assert.equal(result.checkpoint.cleanupConfirmed, true);
  assert.equal(result.checkpoint.afterContent, BODY);
  assert.equal(result.target.observation.sha256, candidate.bodySha256);
  const duplicate = await service.publish({
    workspaceId: f.workspace.id,
    requestId: "service-actual-original",
    approved: true,
    preview,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.id, result.receipt.id);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("file approval rejects AbortSignal look-alikes and shadowed observations before any native owner", async (t) => {
  const f = await filePublicationFixture(t),
    preview = await f.preview(await f.candidate());
  const shadowed = Object.defineProperty(
    new AbortController().signal,
    "throwIfAborted",
    { value: () => undefined },
  );
  for (const signal of [
    Object.create(AbortSignal.prototype) as AbortSignal,
    shadowed,
  ])
    await assert.rejects(
      f.publish(preview, "service-hostile-signal", f.engine, signal),
      (error) =>
        error instanceof EngineError &&
        error.code === "INVALID_KNOWLEDGE_FILE_PUBLICATION",
    );
  const result = await f.publish(preview, "service-hostile-signal");
  assert.equal(result.publication.state, "completed");
  assert.equal(result.duplicate, false);
  f.assertNoCoding();
});

test("actual native prepared intent cancelled before dispatch creates no file or directory and cannot be retried", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    preview = await f.preview(candidate),
    controller = new AbortController();
  const native = Reflect.get(
      f.engine,
      "knowledgeFilePublications",
    ) as KnowledgeFilePublicationStorage,
    original = native.prepare;
  let publicationId = "";
  native.prepare = (input) => {
    const result = original.call(native, input);
    if (result.kind === "created") {
      publicationId = result.record.id;
      controller.abort();
    }
    return result;
  };
  t.after(() => {
    native.prepare = original;
  });
  await assert.rejects(
    f.publish(
      preview,
      "service-cancelled-prepared",
      f.engine,
      controller.signal,
    ),
  );
  const record = invoke<KnowledgeFilePublicationRecord>(
    f.engine,
    "getWorkspaceKnowledgeFilePublication",
    f.workspace.id,
    publicationId,
  );
  assert.equal(record.state, "cancelled");
  assert.equal(record.dispatchedAt, null);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  await assert.rejects(f.publish(preview, "service-cancelled-prepared"));
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual receipt SQL rollback after a real physical effect retains uncertainty and never redispatches the original file operation", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate("MEMORY.md"),
    preview = await f.preview(candidate);
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  db.exec(
    "CREATE TRIGGER fail_actual_file_receipt BEFORE INSERT ON knowledge_file_publication_receipts BEGIN SELECT RAISE(ABORT, 'actual receipt fixture rollback'); END",
  );
  await assert.rejects(f.publish(preview, "service-receipt-rollback"));
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
  const rows = db
    .prepare("SELECT data FROM knowledge_file_publications WHERE request_id=?")
    .all("service-receipt-rollback");
  assert.equal(rows.length, 1);
  const record = JSON.parse(
    String(rows[0]!.data),
  ) as KnowledgeFilePublicationRecord;
  assert.equal(record.state, "uncertain");
  assert.equal(record.cleanupConfirmed, true);
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM knowledge_file_publication_receipts WHERE request_id=?",
      )
      .get("service-receipt-rollback")!.n,
    0,
  );
  await assert.rejects(f.publish(preview, "service-receipt-rollback"));
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

test("actual Engine close drains the original acquired file operation before releasing its execution guard", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    preview = await f.preview(candidate);
  const host = Reflect.get(f.engine, "knowledgeFileHost");
  assert.ok(host instanceof FileKnowledgePublicationHost);
  const original = host.apply;
  let started!: () => void,
    release!: () => void,
    publicationId = "",
    applyCalls = 0;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
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
        publicationId = input.publicationId;
        started();
        await gate;
      },
    });
  };
  t.after(() => {
    release();
    host.apply = original;
  });
  const outcome = f.publish(preview, "service-close-drain").then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await ready;
  const lockPath = Reflect.get(f.engine, "executionLockPath");
  assert.equal(typeof lockPath, "string");
  assert.equal(inspectExecutionLock(lockPath as string).status, "busy");
  let closed = false;
  const closing = f.engine.close().then(
    () => {
      closed = true;
      return undefined;
    },
    (error) => {
      closed = true;
      return error;
    },
  );
  await delay(30);
  assert.equal(
    closed,
    false,
    "close must await the original producer, not a detached cancellation race",
  );
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  release();
  const actual = await outcome;
  assert.ok("error" in actual);
  const closeError = await closing;
  assert.ok(closeError instanceof EngineError);
  assert.equal(closeError.code, "CLEANUP_UNCERTAIN");
  assert.equal(closed, true);
  f.retireClosed();
  assert.notEqual(inspectExecutionLock(lockPath as string).status, "busy");
  const reopened = f.reopen();
  const record = invoke<KnowledgeFilePublicationRecord>(
    reopened,
    "getWorkspaceKnowledgeFilePublication",
    f.workspace.id,
    publicationId,
  );
  assert.equal(record.state, "uncertain");
  assert.equal(record.cleanupConfirmed, true);
  assert.equal(existsSync(join(f.root, ".moodcode")), false);
  assert.equal(applyCalls, 1);
  assert.equal(f.generations.length, 1);
  f.assertNoCoding();
});

function fileOwner(
  f: Awaited<ReturnType<typeof filePublicationFixture>>,
  requestId: string,
): KnowledgeFilePublicationRecord {
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  const row = db
    .prepare("SELECT data FROM knowledge_file_publications WHERE request_id=?")
    .get(requestId);
  assert.ok(row);
  return JSON.parse(String(row.data)) as KnowledgeFilePublicationRecord;
}

test("actual busy execution lock before marker reservation cancels the file owner without a barrier", async (t) => {
  const f = await filePublicationFixture(t),
    preview = await f.preview(await f.candidate("MEMORY.md")),
    held = acquireExecutionLock(
      Reflect.get(f.engine, "executionLockPath") as string,
    );
  try {
    await assert.rejects(
      f.publish(preview, "file-lock-busy"),
      failure("COMMAND_EFFECTS_BUSY"),
    );
  } finally {
    held.release(true);
  }
  assert.equal(fileOwner(f, "file-lock-busy").state, "cancelled");
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
});

test("actual lock acquisition failure after marker reservation settles the file owner uncertain", async (t) => {
  const f = await filePublicationFixture(t),
    preview = await f.preview(await f.candidate("MEMORY.md")),
    lockPath = Reflect.get(f.engine, "executionLockPath") as string,
    guards = Reflect.get(f.engine, "knowledgeFileExecutionGuards") as {
      reserve(...args: unknown[]): void;
    },
    reserve = guards.reserve;
  let held: ReturnType<typeof acquireExecutionLock> | undefined;
  guards.reserve = (...args) => {
    reserve.apply(guards, args);
    held = acquireExecutionLock(lockPath);
  };
  try {
    await assert.rejects(
      f.publish(preview, "file-lock-after-reservation"),
      failure("KNOWLEDGE_FILE_CLEANUP_UNCERTAIN"),
    );
  } finally {
    held?.release(true);
    guards.reserve = reserve;
  }
  const record = fileOwner(f, "file-lock-after-reservation");
  assert.equal(record.state, "uncertain");
  assert.equal(record.dispatchedAt, null);
  assert.equal(record.cleanupConfirmed, false);
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
});

test("actual release failures free the operation slot and keep a completed receipt", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate("MEMORY.md"),
    previews = [];
  for (let index = 0; index < 34; index++)
    previews.push(await f.preview(candidate));
  const native = Reflect.get(
      f.engine,
      "knowledgeFilePublications",
    ) as KnowledgeFilePublicationStorage,
    host = Reflect.get(f.engine, "knowledgeFileHost");
  assert.ok(host instanceof FileKnowledgePublicationHost);
  const apply = host.apply;
  native.release = () => {
    throw new Error("Release failed");
  };
  host.apply = async () => {
    throw new EngineError("FIXTURE_APPLY_FAILED", "Apply failed before dispatch");
  };
  t.after(() => {
    Reflect.deleteProperty(native, "release");
    host.apply = apply;
  });
  for (const preview of previews.slice(0, 33))
    await assert.rejects(f.publish(preview), /Release failed/);
  host.apply = apply;
  const result = await f.publish(previews[33]!);
  assert.equal(result.publication.state, "completed");
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
});
