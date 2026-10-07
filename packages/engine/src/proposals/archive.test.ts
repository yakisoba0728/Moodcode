import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import { checkDatabase } from "../recovery/snapshot.js";
import { DB_VERSION } from "../storage/migrations.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
  type EngineArchiveResult,
} from "../storage/archive.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type {
  AppendProposalRevisionResult,
  ProposalBlobHeader,
  ProposalRevision,
  ProposalSet,
  ProposalSelection,
} from "./types.js";

const BEFORE = "Original user bytes remain physically unapplied.\n";
const AFTER = "Proposed exact pending body 한글😀 remains unapplied.\n";
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const invalid = (error: unknown) =>
  error instanceof EngineError && error.code === "ARCHIVE_PROPOSAL_INVALID";
function api<T>(
  engine: ReturnType<typeof createEngine>,
  method: string,
  ...args: unknown[]
): T {
  const fn = Reflect.get(engine, method);
  assert.equal(typeof fn, "function");
  return Reflect.apply(fn, engine, args) as T;
}
async function command<T>(
  engine: ReturnType<typeof createEngine>,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const result = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
function signed<T extends { readonly sha256: string }>(record: T): T {
  const { sha256: old, ...body } = record;
  return { ...body, sha256: knowledgeHash(body) } as T;
}
function rows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      ["proposal_revisions", "proposal_blobs"].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
async function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-archive-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "source.ts"), BEFORE);
  let producers = 0;
  const provider: ProviderAdapter = {
    id: "proposal-archive-producer-zero",
    async *streamTurn() {
      producers++;
      throw new Error("Proposal archive inspection must not invoke providers");
    },
  };
  const configuration: EngineOptions & { proposals: boolean } = {
      dbPath,
      artifactDir,
      providers: [provider],
      tools: [],
      proposals: true,
    },
    engine = createEngine(configuration),
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close();
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    created: AppendProposalRevisionResult[] = [];
  for (const id of ["archive-original-proposal", "archive-foreign-proposal"])
    created.push(
      await api<Promise<AppendProposalRevisionResult>>(
        engine,
        "createProposalSet",
        {
          workspaceId: workspace.id,
          requestId: `create-${id}`,
          proposalId: id,
          expectedRevision: 0,
          changes: [
            { path: "source.ts", expectedHash: sha(BEFORE), content: AFTER },
          ],
        },
      ),
    );
  assert.equal(producers, 0);
  assert.equal(engine.store.listSessions(workspace.id).length, 0);
  assert.equal(readFileSync(join(root, "source.ts"), "utf8"), BEFORE);
  await engine.close();
  const archive = await exportEngineArchive({
    dbPath,
    artifactDir,
    destination: join(base, "archive"),
  });
  return {
    base,
    root,
    dbPath,
    artifactDir,
    archive,
    workspace,
    created,
    engines,
    configuration,
    counts: () => producers,
  };
}
/** Independently resign only an actual produced archive, so semantic checks see valid outer SQL/file hashes. */
function resign(
  archive: EngineArchiveResult,
  mutate: (db: DatabaseSync) => void,
): void {
  const manifestPath = join(archive.directory, "data", "manifest.json"),
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((item) => item.role === "primary")!,
    file = join(archive.directory, "data", primary.file),
    db = new DatabaseSync(file);
  try {
    mutate(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      )
      .all()
      .map((row) => String(row.name));
    primary.logicalHash = checkDatabase(db, DB_VERSION, tables, () => {});
  } finally {
    db.close();
  }
  const content = readFileSync(file);
  primary.bytes = content.length;
  primary.sha256 = sha(content);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
async function rejectArchive(f: Awaited<ReturnType<typeof fixture>>) {
  const destination = join(f.base, "rejected");
  assert.throws(
    () => validateEngineArchive({ directory: f.archive.directory }),
    invalid,
  );
  await assert.rejects(
    importEngineArchive({ directory: f.archive.directory, destination }),
    invalid,
  );
  assert.equal(existsSync(destination), false);
  assert.equal(f.counts(), 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), BEFORE);
}

test("actual proposal revision and SQL blob owners survive archive/import exactly while readonly paused history invokes no producer", async (t) => {
  const f = await fixture(t),
    original = rows(f.dbPath),
    validation = await validateEngineArchive({
      directory: f.archive.directory,
    });
  assert.equal(validation.manifestSha256, f.archive.manifestSha256);
  assert.equal(
    f.archive.manifest.databases.find((item) => item.role === "primary")!
      .schemaVersion,
    DB_VERSION,
  );
  const imported = await importEngineArchive({
    directory: f.archive.directory,
    destination: join(f.base, "imported"),
  });
  assert.equal(imported.executionResumed, false);
  assert.deepEqual(rows(imported.dbPath), original);
  const current = createEngine({
    ...f.configuration,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.add(current);
  const selected = api<ProposalSelection>(
    current,
    "getProposalSet",
    f.workspace.id,
    f.created[0]!.set.id,
  );
  assert.deepEqual(selected.revision, f.created[0]!.revision);
  assert.equal(selected.set.status, "paused-import");
  await api(current, "getProposalDiff", {
    workspaceId: f.workspace.id,
    proposalId: selected.set.id,
  });
  assert.equal(f.counts(), 0);
  assert.deepEqual(rows(imported.dbPath), original);
  assert.equal(current.store.listSessions(f.workspace.id).length, 0);
});

test("resigned archive SQL blob owner corruption cannot bind an original revision to another actual proposal", async (t) => {
  const f = await fixture(t),
    original = f.created[0]!.revision.files[0]!.after!;
  resign(f.archive, (db) => {
    db.prepare("UPDATE proposal_blobs SET proposal_id=? WHERE id=?").run(
      f.created[1]!.set.id,
      original.id,
    );
  });
  await rejectArchive(f);
});

test("resigned archive content with unchanged actual byte count cannot pass the original SQL blob digest", async (t) => {
  const f = await fixture(t),
    original = f.created[0]!.revision.files[0]!.after!;
  resign(f.archive, (db) => {
    const bytes = Buffer.from(AFTER);
    bytes[0] = bytes[0] === 65 ? 66 : 65;
    db.prepare("UPDATE proposal_blobs SET content=? WHERE id=?").run(
      bytes,
      original.id,
    );
  });
  await rejectArchive(f);
});

test("resigned archive header hashes do not override the actual original revision reference", async (t) => {
  const f = await fixture(t),
    original = f.created[0]!.revision.files[0]!.after!;
  resign(f.archive, (db) => {
    const header = JSON.parse(
        String(
          db
            .prepare("SELECT data FROM proposal_blobs WHERE id=?")
            .get(original.id)!.data,
        ),
      ) as ProposalBlobHeader,
      { headerSha256: ignored, ...body } = header,
      changed = {
        ...body,
        createdAt: new Date(Date.parse(header.createdAt) + 1).toISOString(),
      },
      next = { ...changed, headerSha256: knowledgeHash(changed) };
    db.prepare(
      "UPDATE proposal_blobs SET data=?,header_sha256=? WHERE id=?",
    ).run(JSON.stringify(next), next.headerSha256, original.id);
  });
  await rejectArchive(f);
});

test("fully resigned native revision and head hashes cannot promote a foreign original blob owner", async (t) => {
  const f = await fixture(t),
    original = f.created[0]!,
    foreign = f.created[1]!.revision.files[0]!.after!;
  resign(f.archive, (db) => {
    const revision = signed<ProposalRevision>({
      ...original.revision,
      files: [{ ...original.revision.files[0]!, after: foreign }],
    });
    db.prepare("UPDATE proposal_revisions SET data=? WHERE id=?").run(
      JSON.stringify(revision),
      revision.id,
    );
    const set = signed<ProposalSet>({
      ...original.set,
      revisionSha256: revision.sha256,
    });
    db.prepare("UPDATE proposal_heads SET data=? WHERE id=?").run(
      JSON.stringify(set),
      set.id,
    );
  });
  await rejectArchive(f);
});

test("a resigned oversized native proposal owner is rejected before import publishes any destination", async (t) => {
  const f = await fixture(t),
    original = f.created[0]!.set;
  resign(f.archive, (db) => {
    db.prepare("UPDATE proposal_heads SET id=? WHERE id=?").run(
      "x".repeat(257),
      original.id,
    );
  });
  await rejectArchive(f);
});
