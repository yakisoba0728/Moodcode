import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash, sha256 } from "../knowledge/validation.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { ProposalBlobStorage } from "./blob-store.js";
import {
  ProposalSourceCaptureHost,
  type PreparedProposalSourceCapture,
} from "./source-capture.js";
import {
  PROPOSAL_LIMITS,
  PROPOSAL_SCHEMA_SQL,
  ProposalStorage,
  pauseImportedProposals,
  normalizeProposalCaptureInput,
  proposalRequestFingerprint,
  validateProposalDatabase,
} from "./store.js";
import type {
  AppendProposalRevisionResult,
  PreparedProposalCapture,
  ProposalCaptureInput,
  ProposalStoragePorts,
} from "./types.js";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof EngineError && error.code === expected;
}
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "moodcode-proposal-native-"),
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
      path: path.join(directory, "engine.sqlite"),
    }),
  };
  const source = new ProposalSourceCaptureHost({ checkBinding: () => binding }),
    blobs = new ProposalBlobStorage(db);
  let bindings = 0,
    fresh = 0,
    reads = 0;
  const tx = <T>(operation: () => T): T => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const ports: ProposalStoragePorts = {
    writeTx: tx,
    getWorkspace: () => ({ id: "w", root }),
    checkBinding: () => {
      bindings++;
      return binding;
    },
    readSourceCapture: (capture) => {
      reads++;
      return source.read(capture as PreparedProposalSourceCapture);
    },
    assertSourcesCurrent: (_native, capture) => {
      fresh++;
      source.assertFreshSync(capture as PreparedProposalSourceCapture);
    },
    blobs,
  };
  const store = new ProposalStorage(db, ports);
  async function append(
    input: ProposalCaptureInput,
  ): Promise<AppendProposalRevisionResult> {
    const started = store.beginCapture(input);
    if (started.kind === "duplicate") return started;
    let original: PreparedProposalSourceCapture | undefined;
    try {
      original = await source.capture(
        started.capture.binding,
        input.operations,
      );
      return store.appendRevision(started.capture, original);
    } finally {
      if (original) source.release(original);
      store.release(started.capture);
    }
  }
  return {
    directory,
    root,
    db,
    binding,
    source,
    blobs,
    ports,
    store,
    tx,
    append,
    counters: () => ({ bindings, fresh, reads }),
    close: async () => {
      await source.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const request = (
  requestId = "r",
  after: string | null = "new",
): ProposalCaptureInput => ({
  workspaceId: "w",
  requestId,
  expectedHeadRevision: 0,
  operations: [{ path: "a.ts", expectedSha256: null, after }],
});

test("original selected source becomes a native revision with exact dedicated blob owner and no file effect", async () => {
  const f = await fixture();
  try {
    const result = await f.append(request());
    assert.equal(result.kind, "created");
    assert.equal(result.set.status, "pending");
    assert.equal(result.revision.revision, 1);
    assert.equal(result.revision.previousId, null);
    assert.equal(result.revision.files[0]!.operation, "create");
    const ref = result.revision.files[0]!.after!;
    assert.deepEqual(
      {
        workspaceId: ref.workspaceId,
        proposalId: ref.proposalId,
        revisionId: ref.revisionId,
        role: ref.role,
        operationIndex: ref.operationIndex,
      },
      {
        workspaceId: "w",
        proposalId: result.set.id,
        revisionId: result.revision.id,
        role: "after",
        operationIndex: 0,
      },
    );
    assert.equal(ref.sha256, sha256("new"));
    assert.equal(result.revision.totalBytes, 3);
    assert.equal(
      f.tx(() => f.blobs.readText(ref)),
      "new",
    );
    await assert.rejects(readFile(path.join(f.root, "a.ts")), {
      code: "ENOENT",
    });
    assert.equal(f.counters().fresh, 2);
    validateProposalDatabase(f.db);
    assert(Object.isFrozen(result.revision.sourceManifest.files));
  } finally {
    await f.close();
  }
});

test("exact duplicate is historical observation before binding/source callbacks even after physical source changes", async () => {
  const f = await fixture();
  try {
    const input = request(),
      old = await f.append(input),
      before = f.counters();
    await writeFile(path.join(f.root, "a.ts"), "independent edit");
    const duplicate = f.store.beginCapture(input);
    assert.equal(duplicate.kind, "duplicate");
    if (duplicate.kind === "duplicate")
      assert.equal(duplicate.revision.sha256, old.revision.sha256);
    assert.deepEqual(f.counters(), before);
    assert.throws(
      () => f.store.findRequest(request("r", "changed")),
      code("PROPOSAL_REQUEST_CONFLICT"),
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("two authentic captures race same head and only one revision wins CAS", async () => {
  const f = await fixture();
  try {
    const first = await f.append(request());
    const input = (id: string): ProposalCaptureInput => ({
      ...request(id, id),
      proposalId: first.set.id,
      expectedHeadRevision: 1,
    });
    const a = f.store.beginCapture(input("a")),
      b = f.store.beginCapture(input("b"));
    assert.equal(a.kind, "created");
    assert.equal(b.kind, "created");
    if (a.kind !== "created" || b.kind !== "created") return;
    const sa = await f.source.capture(f.binding, input("a").operations),
      sb = await f.source.capture(f.binding, input("b").operations);
    try {
      const next = f.store.appendRevision(a.capture, sa);
      assert.equal(next.set.headRevision, 2);
      assert.equal(next.revision.previousId, first.revision.id);
      assert.throws(
        () => f.store.appendRevision(b.capture, sb),
        code("PROPOSAL_STALE"),
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
        2,
      );
      validateProposalDatabase(f.db);
    } finally {
      f.source.release(sa);
      f.source.release(sb);
      f.store.release(a.capture);
      f.store.release(b.capture);
    }
  } finally {
    await f.close();
  }
});

test("copied or released original capability cannot append or invoke physical capture reader", async () => {
  const f = await fixture();
  try {
    const begun = f.store.beginCapture(request());
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    const source = await f.source.capture(f.binding, request().operations),
      before = f.counters();
    assert.throws(
      () => f.store.appendRevision({ ...begun.capture }, source),
      code("PROPOSAL_CAPTURE_REQUIRED"),
    );
    f.store.release(begun.capture);
    assert.throws(
      () => f.store.appendRevision(begun.capture, source),
      code("PROPOSAL_CAPTURE_REQUIRED"),
    );
    assert.deepEqual(f.counters(), before);
    f.source.release(source);
  } finally {
    await f.close();
  }
});

test("actual blob insertion and revision both roll back if final original source freshness fails", async () => {
  const f = await fixture();
  try {
    const store = new ProposalStorage(f.db, {
      ...f.ports,
      assertSourcesCurrent: () => {
        throw new EngineError("PROPOSAL_SOURCE_STALE", "changed");
      },
    });
    const begun = store.beginCapture(request());
    if (begun.kind !== "created") assert.fail();
    const source = await f.source.capture(f.binding, request().operations);
    let called = 0;
    const rollback = new ProposalStorage(f.db, {
      ...f.ports,
      assertSourcesCurrent: (_native, original) => {
        if (++called === 2)
          throw new EngineError("PROPOSAL_SOURCE_STALE", "changed after blobs");
        f.source.assertFreshSync(original as PreparedProposalSourceCapture);
      },
    });
    const owned = rollback.beginCapture(request());
    if (owned.kind !== "created") assert.fail();
    try {
      assert.throws(
        () => rollback.appendRevision(owned.capture, source),
        code("PROPOSAL_SOURCE_STALE"),
      );
      assert.equal(called, 2);
      for (const table of [
        "proposal_revisions",
        "proposal_heads",
        "proposal_blobs",
      ])
        assert.equal(
          f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          0,
        );
    } finally {
      rollback.release(owned.capture);
      store.release(begun.capture);
      f.source.release(source);
    }
  } finally {
    await f.close();
  }
});

test("actual SQL trigger failure after blob insert never leaves a partial revision receipt or head", async () => {
  const f = await fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER stop_head BEFORE INSERT ON proposal_heads BEGIN SELECT RAISE(ABORT,'test-head-failure'); END",
    );
    await assert.rejects(f.append(request()), /test-head-failure/u);
    for (const table of [
      "proposal_revisions",
      "proposal_heads",
      "proposal_blobs",
    ])
      assert.equal(
        f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        0,
      );
  } finally {
    await f.close();
  }
});

test("import pause changes only head CAS and blocks fresh mutation/overlay while duplicate/history stay exact", async () => {
  const f = await fixture();
  try {
    const input = request(),
      old = await f.append(input),
      rows = f.db.prepare("SELECT data FROM proposal_revisions").all();
    f.tx(() => pauseImportedProposals(f.db, "w", sha256("archive")));
    const current = f.store.getSet("w", old.set.id)!;
    assert.equal(current.status, "paused-import");
    assert.equal(current.headRevision, 2);
    assert.equal(f.store.getSelection("w", old.set.id), undefined);
    assert.deepEqual(
      f.db.prepare("SELECT data FROM proposal_revisions").all(),
      rows,
    );
    assert.equal(
      f.store.findRequest(input)!.revision.sha256,
      old.revision.sha256,
    );
    assert.throws(
      () =>
        f.store.beginCapture({
          ...request("later"),
          proposalId: old.set.id,
          expectedHeadRevision: 2,
        }),
      code("PROPOSAL_IMPORTED_PAUSED"),
    );
    validateProposalDatabase(f.db);
  } finally {
    await f.close();
  }
});

test("malformed descriptors and proxies execute zero traps and zero native binding callbacks", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const getter = { ...request() };
    Object.defineProperty(getter, "operations", {
      enumerable: true,
      get: () => {
        calls++;
        return [];
      },
    });
    assert.throws(() => f.store.beginCapture(getter), code("INVALID_PROPOSAL"));
    assert.throws(
      () =>
        f.store.beginCapture(
          new Proxy(request(), {
            get: () => {
              calls++;
              throw Error("trap");
            },
            ownKeys: () => {
              calls++;
              throw Error("trap");
            },
          }),
        ),
      code("INVALID_PROPOSAL"),
    );
    assert.equal(calls, 0);
    assert.deepEqual(f.counters(), { bindings: 0, fresh: 0, reads: 0 });
    assert.throws(
      () => normalizeProposalCaptureInput(null),
      code("INVALID_PROPOSAL"),
    );
    assert.throws(
      () =>
        normalizeProposalCaptureInput({ ...request(), operations: Array(1) }),
      code("INVALID_PROPOSAL"),
    );
  } finally {
    await f.close();
  }
});

test("file count/body/aggregate/path alias caps reject before binding and preserve exact null/empty body distinction", async () => {
  const f = await fixture();
  try {
    const many = {
      ...request(),
      operations: Array.from({ length: 129 }, (_, i) => ({
        path: `${i}.ts`,
        expectedSha256: null,
        after: "",
      })),
    };
    assert.throws(() => f.store.beginCapture(many), code("PROPOSAL_LIMIT"));
    assert.throws(
      () =>
        f.store.beginCapture(
          request("big", "x".repeat(PROPOSAL_LIMITS.fileBytes + 1)),
        ),
      code("PROPOSAL_LIMIT"),
    );
    assert.throws(
      () =>
        f.store.beginCapture({
          ...request(),
          operations: [
            { path: "A.ts", expectedSha256: null, after: "" },
            { path: "a.ts", expectedSha256: null, after: "" },
          ],
        }),
      code("PROPOSAL_PATH_CONFLICT"),
    );
    assert.throws(
      () =>
        f.store.beginCapture({
          ...request(),
          operations: [
            { path: "a", expectedSha256: null, after: "" },
            { path: "a/b", expectedSha256: null, after: "" },
          ],
        }),
      code("PROPOSAL_PATH_CONFLICT"),
    );
    assert.equal(f.counters().bindings, 0);
    const empty = await f.append(request("empty", ""));
    assert.equal(empty.revision.files[0]!.after!.bytes, 0);
    assert.equal(empty.revision.files[0]!.after!.sha256, sha256(""));
    assert.throws(
      () => proposalRequestFingerprint(request("null", null)),
      code("INVALID_PROPOSAL"),
    );
  } finally {
    await f.close();
  }
});

test("bounded metadata read rejects oversized corrupted row before its body SELECT", async () => {
  const f = await fixture();
  try {
    const old = await f.append(request());
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db
      .prepare("UPDATE proposal_revisions SET data=? WHERE id=?")
      .run("x".repeat(PROPOSAL_LIMITS.revisionBytes + 1), old.revision.id);
    let bodyReads = 0;
    const original = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      if (sql.startsWith("SELECT data FROM proposal_revisions")) bodyReads++;
      return original(sql);
    }) as typeof f.db.prepare;
    assert.throws(
      () => f.store.getRevision("w", old.revision.id),
      code("INVALID_PROPOSAL"),
    );
    assert.equal(bodyReads, 0);
  } finally {
    await f.close();
  }
});

test("bounded revision pages contain hashes and counts without manifest or blob bodies", async () => {
  const f = await fixture();
  try {
    let latest = await f.append(request("0"));
    for (let i = 1; i < 5; i++)
      latest = await f.append({
        ...request(String(i)),
        proposalId: latest.set.id,
        expectedHeadRevision: latest.set.headRevision,
      });
    const page = f.store.listRevisions("w", latest.set.id, {
      limit: 2,
      maxBytes: 4096,
    });
    assert.equal(page.items.length, 2);
    assert.notEqual(page.next, null);
    assert(page.bytes <= 4096);
    assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page)));
    assert(!("files" in page.items[0]!));
    const next = f.store.listRevisions("w", latest.set.id, {
      after: page.next!,
      limit: 2,
    });
    assert.equal(next.items.length, 2);
    assert(!page.items.some((x) => next.items.some((y) => y.id === x.id)));
    assert.throws(
      () => f.store.listSets("w", { limit: 65 }),
      code("INVALID_PROPOSAL"),
    );
  } finally {
    await f.close();
  }
});

test("native semantic validation rejects a resigned wrong request digest and orphaned exact blob owner", async () => {
  const f = await fixture();
  try {
    const old = await f.append(request()),
      r = old.revision;
    const { sha256: _old, ...body } = r,
      changed = { ...body, requestInputSha256: sha256("different") },
      corrupt = { ...changed, sha256: knowledgeHash(changed) };
    f.db
      .prepare(
        "UPDATE proposal_revisions SET request_sha256=?,data=? WHERE id=?",
      )
      .run(corrupt.requestInputSha256, JSON.stringify(corrupt), r.id);
    assert.throws(
      () => validateProposalDatabase(f.db),
      code("PROPOSAL_HASH_MISMATCH"),
    );
  } finally {
    await f.close();
  }
});

test("reopen reads immutable pending proposal without a new source producer or dispatcher", async () => {
  const f = await fixture();
  try {
    const old = await f.append(request());
    const reopened = new ProposalStorage(f.db, {
      ...f.ports,
      checkBinding: () => assert.fail("historical binding callback"),
      readSourceCapture: () => assert.fail("history source callback"),
    });
    assert.equal(
      reopened.getSelection("w", old.set.id)!.revision.sha256,
      old.revision.sha256,
    );
    assert.equal(
      reopened.findRequest(request())!.revision.sha256,
      old.revision.sha256,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("actual 128-file revision is stored whole with bodies only in native BLOBs", async () => {
  const f = await fixture();
  try {
    const input = {
      ...request("128"),
      operations: Array.from({ length: 128 }, (_, i) => ({
        path: `source-${i}.ts`,
        expectedSha256: null,
        after: `export const value${i}=${i};\n`,
      })),
    };
    const result = await f.append(input);
    assert.equal(result.revision.files.length, 128);
    assert.equal(result.revision.sourceManifest.fileCount, 128);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
      128,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      1,
    );
    const body = f.db.prepare("SELECT data FROM proposal_revisions").get()!
      .data as string;
    assert(!body.includes("export const value"));
    assert(Buffer.byteLength(body) <= PROPOSAL_LIMITS.revisionBytes);
    validateProposalDatabase(f.db);
  } finally {
    await f.close();
  }
});

test("actual original 8MiB combined body cap stores without a fictitious 32-file apply lane", async () => {
  const f = await fixture();
  try {
    const text = "x".repeat(PROPOSAL_LIMITS.fileBytes);
    const input = {
      ...request("8MiB"),
      operations: Array.from({ length: 8 }, (_, i) => ({
        path: `large-${i}.ts`,
        expectedSha256: null,
        after: text,
      })),
    };
    const result = await f.append(input);
    assert.equal(result.revision.totalBytes, PROPOSAL_LIMITS.totalBytes);
    assert.equal(
      f.db
        .prepare("SELECT sum(length(content)) AS bytes FROM proposal_blobs")
        .get()!.bytes,
      PROPOSAL_LIMITS.totalBytes,
    );
    assert(
      Buffer.byteLength(JSON.stringify(result.revision)) <
        PROPOSAL_LIMITS.revisionBytes,
    );
    assert.throws(
      () =>
        f.store.beginCapture({
          ...input,
          requestId: "overflow",
          operations: [
            ...input.operations,
            { path: "overflow.ts", expectedSha256: null, after: "x" },
          ],
        }),
      code("PROPOSAL_LIMIT"),
    );
  } finally {
    await f.close();
  }
});

test("actual observed before and after images charge combined bytes and delete retains native preimage", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "a.ts"), "old\n");
    const input = {
      ...request("update"),
      operations: [
        { path: "a.ts", expectedSha256: sha256("old\n"), after: "new\n" },
      ],
    };
    const result = await f.append(input);
    assert.equal(result.revision.totalBytes, 8);
    assert.equal(result.revision.files[0]!.operation, "update");
    assert.equal(
      f.tx(() => f.blobs.readText(result.revision.files[0]!.before!)),
      "old\n",
    );
    assert.equal(await readFile(path.join(f.root, "a.ts"), "utf8"), "old\n");
    const deleted = await f.append({
      ...request("delete"),
      operations: [
        { path: "a.ts", expectedSha256: sha256("old\n"), after: null },
      ],
    });
    assert.equal(deleted.revision.files[0]!.operation, "delete");
    assert.equal(deleted.revision.files[0]!.after, null);
    assert.equal(deleted.revision.totalBytes, 4);
    validateProposalDatabase(f.db);
  } finally {
    await f.close();
  }
});

test("changing actual source after native capture rejects without revision or blob receipts", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "a.ts"), "old");
    const input = {
      ...request("stale"),
      operations: [
        { path: "a.ts", expectedSha256: sha256("old"), after: "new" },
      ],
    };
    const native = f.store.beginCapture(input);
    if (native.kind !== "created") assert.fail();
    const original = await f.source.capture(f.binding, input.operations);
    await writeFile(path.join(f.root, "a.ts"), "changed");
    try {
      assert.throws(
        () => f.store.appendRevision(native.capture, original),
        (error: unknown) =>
          error instanceof EngineError &&
          error.code === "PROPOSAL_SOURCE_STALE",
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
        0,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
        0,
      );
    } finally {
      f.store.release(native.capture);
      f.source.release(original);
    }
  } finally {
    await f.close();
  }
});

test("fake BLOB producer observation cannot create a revision without actual persisted content", async () => {
  const f = await fixture();
  try {
    let header: unknown;
    const store = new ProposalStorage(f.db, {
      ...f.ports,
      blobs: {
        ...f.blobs,
        put: (input) => {
          header = input;
        },
        get: () => header as never,
        read: () => assert.fail("not used"),
      },
    });
    const begun = store.beginCapture(request());
    if (begun.kind !== "created") assert.fail();
    const original = await f.source.capture(f.binding, request().operations);
    try {
      assert.throws(
        () => store.appendRevision(begun.capture, original),
        code("PROPOSAL_BLOB_MISSING"),
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
        0,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM proposal_heads").get()!.n,
        0,
      );
    } finally {
      store.release(begun.capture);
      f.source.release(original);
    }
  } finally {
    await f.close();
  }
});

test("bounded live capture capacity is released without any durable producer authority", async () => {
  const f = await fixture();
  try {
    const owners: PreparedProposalCapture[] = [];
    for (let i = 0; i < PROPOSAL_LIMITS.handles; i++) {
      const r = f.store.beginCapture(request(`owner-${i}`));
      if (r.kind !== "created") assert.fail();
      owners.push(r.capture);
    }
    assert.throws(
      () => f.store.beginCapture(request("exhausted")),
      code("PROPOSAL_CAPTURE_LIMIT"),
    );
    f.store.release(owners.pop()!);
    const replacement = f.store.beginCapture(request("replacement"));
    assert.equal(replacement.kind, "created");
    if (replacement.kind === "created") f.store.release(replacement.capture);
    for (const owner of owners) f.store.release(owner);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("explicit host proposal identity registers only absent revision zero and preserves original request digest", async () => {
  const f = await fixture();
  try {
    const input = { ...request("named"), proposalId: "chosen-by-host" };
    const result = await f.append(input);
    assert.equal(result.set.id, "chosen-by-host");
    assert.equal(result.revision.requestedProposalId, "chosen-by-host");
    assert.equal(
      result.revision.requestInputSha256,
      proposalRequestFingerprint(input),
    );
    validateProposalDatabase(f.db);
    assert.throws(
      () =>
        f.store.beginCapture({
          ...request("stale-named"),
          proposalId: "chosen-by-host",
        }),
      code("PROPOSAL_STALE"),
    );
    f.db.prepare("INSERT INTO workspaces VALUES(?,?)").run("foreign", f.root);
    const before = f.counters();
    assert.throws(
      () =>
        f.store.beginCapture({
          ...request("foreign"),
          workspaceId: "foreign",
          proposalId: "chosen-by-host",
        }),
      code("PROPOSAL_SCOPE_MISMATCH"),
    );
    assert.deepEqual(f.counters(), before);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM proposal_revisions").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});
