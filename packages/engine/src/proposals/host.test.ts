import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash, sha256 } from "../knowledge/validation.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { ProposalBlobStorage } from "./blob-store.js";
import { ProposalHostService, type CreateProposalSetInput } from "./host.js";
import { ProposalSourceCaptureHost } from "./source-capture.js";
import { PROPOSAL_SCHEMA_SQL, ProposalStorage } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "moodcode-proposal-host-"),
  );
  await mkdir(path.join(directory, "workspace"));
  const root = await realpath(path.join(directory, "workspace"));
  const db = new DatabaseSync(path.join(directory, "engine.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    "CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL) STRICT",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run("w", root);
  db.exec(PROPOSAL_SCHEMA_SQL);
  const stat = statSync(root, { bigint: true });
  const binding: KnowledgeHostBinding = {
    workspaceId: "w",
    root,
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    storageBindingSha256: knowledgeHash({
      database: path.join(directory, "engine.sqlite"),
    }),
  };
  const tx = <T>(operation: () => T): T => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const source = new ProposalSourceCaptureHost({ checkBinding: () => binding });
  let host: ProposalHostService;
  const native = new ProposalStorage(db, {
    writeTx: tx,
    getWorkspace: () => ({ id: "w", root }),
    checkBinding: () => binding,
    readSourceCapture: (original) => source.read(original as never),
    assertSourcesCurrent: (capture, original) =>
      host.assertCommitCurrent(capture, original),
    blobs: new ProposalBlobStorage(db),
  });
  host = new ProposalHostService(
    native,
    source,
    tx,
    new AbortController().signal,
  );
  return {
    root,
    db,
    source,
    native,
    host,
    close: async () => {
      await host.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function request(requestId = "one", content = "after"): CreateProposalSetInput {
  return {
    workspaceId: "w",
    requestId,
    proposalId: "host-chosen",
    expectedRevision: 0,
    changes: [{ path: "a.ts", expectedHash: null, content }],
  };
}

test("host rejects preabort/accessors/proxies before native writes or selected-source producer", async (t) => {
  const f = await fixture();
  try {
    let captures = 0,
      traps = 0;
    const original = f.source.capture.bind(f.source);
    t.mock.method(
      f.source,
      "capture",
      (...args: Parameters<typeof original>) => {
        captures++;
        return original(...args);
      },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.host.create({ ...request(), signal: controller.signal }),
      (error: unknown) =>
        error instanceof EngineError && error.code === "PROPOSAL_CANCELLED",
    );
    const getter = { ...request() };
    Object.defineProperty(getter, "changes", {
      enumerable: true,
      get: () => {
        traps++;
        return [];
      },
    });
    await assert.rejects(
      f.host.create(getter),
      (error: unknown) =>
        error instanceof EngineError && error.code === "INVALID_PROPOSAL",
    );
    await assert.rejects(
      f.host.create(
        new Proxy(request(), {
          get: () => {
            traps++;
            throw Error("trap");
          },
          ownKeys: () => {
            traps++;
            throw Error("trap");
          },
        }),
      ),
    );
    assert.equal(captures, 0);
    assert.equal(traps, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("host duplicate returns original revision plus honest current head without another physical capture", async (t) => {
  const f = await fixture();
  try {
    const input = request(),
      first = await f.host.create(input),
      second = await f.host.create({
        ...request("two", "different"),
        expectedRevision: 1,
      });
    let captures = 0;
    t.mock.method(f.source, "capture", () => {
      captures++;
      throw Error("duplicate may not capture");
    });
    await writeFile(path.join(f.root, "a.ts"), "external edit");
    const duplicate = await f.host.create(input);
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(duplicate.revision.sha256, first.revision.sha256);
    assert.equal(duplicate.set.revisionId, second.revision.id);
    assert.equal(duplicate.set.headRevision, 2);
    assert.equal(captures, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});

test("close drains an actual held descriptor read and rejects late native revision commit", async (t) => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let originalHandle: FileHandle | undefined,
    closed = false;
  try {
    await writeFile(path.join(f.root, "a.ts"), "actual before");
    const sample = await open(path.join(f.root, "a.ts"), "r"),
      prototype = Object.getPrototypeOf(sample) as FileHandle;
    const originalRead = prototype.read;
    await sample.close();
    let intercept = true;
    t.mock.method(
      prototype,
      "read",
      async function (this: FileHandle, ...args: unknown[]) {
        const value = await Reflect.apply(originalRead, this, args);
        if (intercept) {
          intercept = false;
          originalHandle = this;
          const originalClose = this.close;
          t.mock.method(this, "close", async () => {
            await Reflect.apply(originalClose, this, []);
            closed = true;
          });
          entered();
          await held;
        }
        return value;
      },
    );
    const creation = f.host.create({
      ...request(),
      changes: [
        {
          path: "a.ts",
          expectedHash: sha256("actual before"),
          content: "after",
        },
      ],
    });
    const observed = creation.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    await started;
    let closeResolved = false;
    const closing = f.host.close().then(() => {
      closeResolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeResolved, false);
    assert.equal(closed, false);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      0,
    );
    release();
    const result = await observed;
    assert.equal(result.ok, false);
    if (!result.ok)
      assert(
        result.error instanceof EngineError &&
          [
            "PROPOSAL_SOURCE_CANCELLED",
            "PROPOSAL_CANCELLED",
            "ENGINE_CLOSED",
          ].includes(result.error.code),
      );
    await closing;
    assert.equal(closed, true);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
      0,
    );
    assert.throws(
      () => f.host.get("w", "host-chosen"),
      (error: unknown) =>
        error instanceof EngineError && error.code === "ENGINE_CLOSED",
    );
  } finally {
    release();
    await f.close();
  }
});
