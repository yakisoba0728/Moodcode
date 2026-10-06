import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError, type InputImageAttachment } from "@moodcode/contracts";
import { ImageAttachmentStore } from "../media/store.js";
import { imageFixture, png } from "../media/fixtures.js";
import { SqliteStore } from "./index.js";
import { inspectInputImageIndex } from "./input-image-index.js";

const stamp = "2026-10-07T00:00:00.000Z";
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-image-index-")),
    ),
    path = join(directory, "engine.sqlite"),
    store = new SqliteStore(path),
    writer = new DatabaseSync(path);
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: stamp,
  });
  const session = (id: string) =>
    store.createSession({
      id,
      workspaceId: "workspace",
      title: "Image index",
      createdAt: stamp,
    });
  session("session");
  const document = (id: string, refs: InputImageAttachment[]) => ({
    version: 1,
    owner: {
      sessionId: id,
      workspaceId: "workspace",
      workspaceRoot: directory,
    },
    attachments: refs.map((ref) => ({ ...ref })),
  });
  const put = (id: string, refs: InputImageAttachment[]) =>
    store.putSessionDocument(id, "input_images", 0, document(id, refs));
  const rows = () =>
    Object.fromEntries(
      [
        "workspaces",
        "sessions",
        "session_documents",
        "session_sequences",
        "session_events",
        "inputs",
        "runs",
        "messages",
        "events",
      ].map((table) => [
        table,
        writer.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  t.after(() => {
    writer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, writer, session, document, put, rows };
}

test("primary image index validates real imported owners and detached refs without reading transcript, other documents or blobs", async (t) => {
  const f = fixture(t),
    media = new ImageAttachmentStore({
      directory: join(f.directory, "artifacts", "input-media"),
      documents: f.store,
    });
  const first = await media.import("session", png(), "image/png");
  f.session("second");
  const second = await media.import("second", png(), "image/png");
  f.store.putSessionDocument("session", "irrelevant", 0, {
    unused: "diagnostics must not parse this document",
  });
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='irrelevant'")
    .run("not JSON");
  f.store.getSnapshot = () => {
    throw new Error("Whole transcript read is forbidden");
  };
  f.store.getSessionDocument = () => {
    throw new Error("Generic document read is forbidden");
  };
  let notifications = 0;
  Object.defineProperty(f.store, "notify", {
    value() {
      notifications++;
    },
  });
  const before = f.rows(),
    report = f.store.inspectInputImageIndex();
  assert.equal(report.scope, "primary-database-only");
  assert.equal(report.complete, true);
  assert.equal(report.totalDocuments, 2);
  assert.equal(report.sampledDocuments, 2);
  assert.equal(report.invalidDocuments, 0);
  assert.equal(report.omittedDocuments, 0);
  assert.equal(report.invalidReferences, 0);
  assert.equal(report.omittedReferences, 0);
  assert.deepEqual(new Set(report.imageIds), new Set([first.id, second.id]));
  assert.equal(report.declaredBytes, first.bytes + second.bytes);
  assert.deepEqual(
    report.documents.map((doc) => [
      doc.sessionId,
      doc.workspaceId,
      doc.workspaceRoot,
      doc.revision,
      doc.referenceCount,
    ]),
    [
      ["second", "workspace", f.directory, 1, 1],
      ["session", "workspace", f.directory, 1, 1],
    ],
  );
  assert.equal(report.coverage.childDatabases, "not-read");
  assert.equal(report.coverage.childBlobs, "not-read");
  assert.equal(report.coverage.filesystem, "not-read");
  assert.equal(report.coverage.physicalReadBytes, null);
  const expected = structuredClone(report.refs);
  report.refs[0]!.sha256 = "0".repeat(64);
  report.imageIds.push("caller mutation");
  assert.deepEqual(f.store.inspectInputImageIndex().refs, expected);
  assert.equal(notifications, 0);
  assert.deepEqual(f.rows(), before);
});

test("document/ref/UTF-8 byte caps expose incomplete coverage and never infer skipped reference counts", (t) => {
  const f = fixture(t),
    one = imageFixture().attachment,
    two = imageFixture(png(), "image/png", "b").attachment;
  f.put("session", [one, two]);
  f.session("second");
  f.put("second", [imageFixture(png(), "image/png", "c").attachment]);
  const before = f.rows(),
    limitedDocs = f.store.inspectInputImageIndex({ maxDocuments: 1 });
  assert.equal(limitedDocs.complete, false);
  assert.equal(limitedDocs.totalDocuments, 2);
  assert.equal(limitedDocs.sampledDocuments, 1);
  assert.equal(limitedDocs.omittedDocuments, 1);
  assert.equal(limitedDocs.omittedReferences, null);
  assert.deepEqual(limitedDocs.reasons, ["document-limit"]);
  const limitedRefs = f.store.inspectInputImageIndex({ maxRefs: 1 });
  assert.equal(limitedRefs.complete, false);
  assert.equal(limitedRefs.refs.length, 1);
  assert.equal(limitedRefs.omittedReferences, 2);
  assert.equal(limitedRefs.invalidReferences, 0);
  assert.ok(limitedRefs.reasons.includes("reference-limit"));
  const limitedBytes = f.store.inspectInputImageIndex({ maxJsonBytes: 1 });
  assert.equal(limitedBytes.complete, false);
  assert.equal(limitedBytes.sampledJsonBytes, 0);
  assert.equal(limitedBytes.documents.length, 0);
  assert.equal(limitedBytes.omittedDocuments, 2);
  assert.equal(limitedBytes.omittedReferences, null);
  assert.deepEqual(limitedBytes.reasons, ["json-byte-limit"]);
  assert.deepEqual(f.rows(), before);
});

test("corrupt/oversized/version/root/owner payloads fail closed without copying unbounded data", (t) => {
  const f = fixture(t),
    ref = imageFixture().attachment,
    data = f.document("session", [ref]);
  f.put("session", [ref]);
  const mutations: unknown[] = [
    { ...data, version: 2 },
    { ...data, externalPath: "/tmp/untrusted" },
    { ...data, owner: { ...data.owner, sessionId: "other" } },
    { ...data, owner: { ...data.owner, workspaceId: "other" } },
    { ...data, owner: { ...data.owner, workspaceRoot: "/tmp/other" } },
    { ...data, owner: { ...data.owner, extra: true } },
    { ...data, attachments: "not refs" },
  ];
  for (const mutation of mutations) {
    f.writer
      .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
      .run(JSON.stringify(mutation));
    const report = f.store.inspectInputImageIndex();
    assert.equal(report.complete, false);
    assert.equal(report.invalidDocuments, 1);
    assert.deepEqual(report.imageIds, []);
  }
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
    .run("malformed JSON");
  assert.deepEqual(f.store.inspectInputImageIndex().reasons, [
    "corrupt-image-index-json",
  ]);
  f.writer.exec("PRAGMA ignore_check_constraints=ON");
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
    .run("x".repeat(300_000));
  const oversized = f.store.inspectInputImageIndex();
  assert.equal(oversized.complete, false);
  assert.equal(oversized.sampledJsonBytes, 0);
  assert.equal(oversized.invalidDocuments, 1);
  assert.equal(oversized.omittedReferences, null);
  f.writer.exec("PRAGMA ignore_check_constraints=OFF");
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
    .run(JSON.stringify(data));
  f.writer
    .prepare("UPDATE sessions SET data=? WHERE id=?")
    .run(JSON.stringify({ id: "other", workspaceId: "workspace" }), "session");
  assert.equal(f.store.inspectInputImageIndex().complete, false);
});

test("invalid hash/ID/size/media fields and duplicated blob identities cannot produce a complete primary index", (t) => {
  const f = fixture(t),
    ref = imageFixture().attachment;
  f.put("session", [ref]);
  for (const invalid of [
    { ...ref, sha256: "A".repeat(64) },
    { ...ref, id: "../blob" },
    { ...ref, bytes: 524_289 },
    { ...ref, bytes: 0 },
    { ...ref, mimeType: "image/svg+xml" },
    { ...ref, path: "/tmp/blob" },
  ]) {
    f.writer
      .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
      .run(
        JSON.stringify(
          f.document("session", [invalid as InputImageAttachment]),
        ),
      );
    const report = f.store.inspectInputImageIndex();
    assert.equal(report.complete, false);
    assert.equal(report.invalidDocuments, 1);
    assert.equal(report.invalidReferences, 1);
    assert.deepEqual(report.imageIds, []);
  }
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
    .run(JSON.stringify(f.document("session", [ref, ref])));
  assert.equal(f.store.inspectInputImageIndex().complete, false);
  f.writer
    .prepare("UPDATE session_documents SET data=? WHERE kind='input_images'")
    .run(JSON.stringify(f.document("session", [ref])));
  f.session("second");
  f.put("second", [{ ...ref, sha256: "b".repeat(64) }]);
  const conflict = f.store.inspectInputImageIndex();
  assert.equal(conflict.complete, false);
  assert.equal(conflict.invalidDocuments, 1);
  assert.equal(conflict.invalidReferences, 1);
  assert.equal(conflict.refs.length, 1);
});

test("empty indexes are complete within their explicit scope; option bounds and cancellation precede any SELECT", (t) => {
  const f = fixture(t),
    empty = f.store.inspectInputImageIndex();
  assert.equal(empty.complete, true);
  assert.equal(empty.totalDocuments, 0);
  assert.equal(empty.declaredBytes, 0);
  assert.deepEqual(empty.imageIds, []);
  for (const bad of [
    { maxDocuments: 65 },
    { maxRefs: 2049 },
    { maxJsonBytes: 4_194_305 },
    { maxRefs: 0 },
    { maxJsonBytes: -1 },
    { maxDocuments: 1.5 },
    { maxRefs: null },
    { unknown: 1 },
  ])
    assert.throws(
      () => f.store.inspectInputImageIndex(bad as never),
      code("INVALID_IMAGE_INDEX_OPTIONS"),
    );
  let accessors = 0;
  const accessor = Object.defineProperty({}, "maxRefs", {
    enumerable: true,
    get() {
      accessors++;
      return 1;
    },
  });
  assert.throws(
    () => f.store.inspectInputImageIndex(accessor),
    code("INVALID_IMAGE_INDEX_OPTIONS"),
  );
  assert.equal(accessors, 0);
  const database = new DatabaseSync(":memory:"),
    controller = new AbortController();
  controller.abort("private reason");
  try {
    assert.throws(
      () => inspectInputImageIndex(database, { signal: controller.signal }),
      code("CANCELLED"),
    );
  } finally {
    database.close();
  }
  const before = f.rows();
  assert.throws(
    () => f.store.inspectInputImageIndex({ signal: controller.signal }),
    code("CANCELLED"),
  );
  assert.deepEqual(f.rows(), before);
});

test("SQLite integers outside the JavaScript safe range remain bounded diagnostics", (t) => {
  const f = fixture(t),
    ref = imageFixture().attachment;
  f.put("session", [ref]);
  f.writer
    .prepare(
      "UPDATE session_documents SET revision=? WHERE kind='input_images'",
    )
    .run(9_007_199_254_740_992n);
  const invalid = f.store.inspectInputImageIndex();
  assert.equal(invalid.complete, false);
  assert.equal(invalid.invalidDocuments, 1);
  assert.equal(invalid.omittedReferences, null);
  assert.deepEqual(invalid.imageIds, []);
  f.writer
    .prepare(
      "UPDATE session_documents SET revision=1,rowid=? WHERE kind='input_images'",
    )
    .run(9_007_199_254_740_992n);
  const opaqueRowId = f.store.inspectInputImageIndex();
  assert.equal(opaqueRowId.complete, true);
  assert.deepEqual(opaqueRowId.imageIds, [ref.id]);
});
