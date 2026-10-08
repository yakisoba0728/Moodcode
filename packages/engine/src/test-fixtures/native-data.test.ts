import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { nativeFixtureData } from "./native-data.js";

function database(t: TestContext, tables: Record<string, readonly string[]>) {
  const base = mkdtempSync(join(tmpdir(), "moodcode-native-data-proof-")),
    path = join(base, "original.sqlite"),
    db = new DatabaseSync(path);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  try {
    for (const [table, rows] of Object.entries(tables)) {
      db.exec(`CREATE TABLE ${table} (data TEXT NOT NULL)`);
      const insert = db.prepare(`INSERT INTO ${table} (data) VALUES (?)`);
      for (const raw of rows) insert.run(raw);
    }
  } finally {
    db.close();
  }
  return path;
}

function readOnlyCloses(t: TestContext, action: () => void, expected: number) {
  const original = DatabaseSync.prototype.close;
  let closes = 0;
  const close = t.mock.method(
    DatabaseSync.prototype,
    "close",
    function (this: DatabaseSync) {
      try {
        assert.throws(
          () => this.prepare("INSERT INTO runs (data) VALUES ('{}')").run(),
          /readonly database/,
        );
      } finally {
        original.call(this);
        closes++;
      }
    },
  );
  try {
    action();
  } finally {
    close.mock.restore();
    assert.equal(closes, expected);
  }
}

const fileHash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("native DATA preserves the ordered caller manifest and omits unselected message_parts", (t) => {
  const path = database(t, {
      runs: ['{"id":"original-run"}'],
      message_parts: ['{"text":"original part"}'],
      session_events: ['{"seq":1}'],
    }),
    before = fileHash(path);
  readOnlyCloses(
    t,
    () => {
      const withParts = nativeFixtureData(path, [
        "runs",
        "message_parts",
        "session_events",
      ]);
      assert.deepEqual(Object.keys(withParts), [
        "runs",
        "message_parts",
        "session_events",
      ]);
      assert.deepEqual(withParts, {
        runs: [{ id: "original-run" }],
        message_parts: [{ text: "original part" }],
        session_events: [{ seq: 1 }],
      });
      assert.deepEqual(nativeFixtureData(path, ["runs", "session_events"]), {
        runs: [{ id: "original-run" }],
        session_events: [{ seq: 1 }],
      });
    },
    2,
  );
  assert.equal(fileHash(path), before);
});

test("native DATA accepts 1024 original rows in rowid order and rejects row 1025", (t) => {
  const authored = Array.from({ length: 1024 }, (_, n) => ({ n: 1024 - n })),
    rows = authored.map((row) => JSON.stringify(row)),
    exact = database(t, { runs: rows }),
    overflow = database(t, { runs: [...rows, '{"n":0}'] }),
    overflowHash = fileHash(overflow);
  readOnlyCloses(
    t,
    () => {
      assert.deepEqual(nativeFixtureData(exact, ["runs"]), { runs: authored });
      assert.throws(() => nativeFixtureData(overflow, ["runs"]), {
        name: "AssertionError",
        message: "Fixture native evidence row ceiling exceeded",
      });
    },
    2,
  );
  assert.equal(fileHash(overflow), overflowHash);
});

test("native DATA charges raw UTF-8 JSON across tables at exactly 8 MiB and rejects one more byte", (t) => {
  const value = "é".repeat(2_097_146),
    raw = `{"value":"${value}"}`,
    larger = `{"value":"${value}x"}`;
  assert.equal(Buffer.byteLength(raw), 4_194_304);
  assert.equal(Buffer.byteLength(larger), 4_194_305);
  const exact = database(t, { runs: [raw], tools: [raw] }),
    overflow = database(t, { runs: [raw], tools: [larger] }),
    overflowHash = fileHash(overflow);
  readOnlyCloses(
    t,
    () => {
      const accepted = nativeFixtureData(exact, ["runs", "tools"]);
      assert.equal(accepted.runs![0]!.value, value);
      assert.equal(accepted.tools![0]!.value, value);
      assert.throws(() => nativeFixtureData(overflow, ["runs", "tools"]), {
        name: "AssertionError",
        message: "Fixture native evidence byte ceiling exceeded",
      });
    },
    2,
  );
  assert.equal(fileHash(overflow), overflowHash);
});

test("native DATA keeps original JSON and SQL failures and closes their read-only handles", (t) => {
  const invalidJson = database(t, { runs: ["authored invalid JSON"] }),
    missingTable = database(t, { runs: ['{"id":"retained"}'] }),
    hashes = [invalidJson, missingTable].map(fileHash);
  readOnlyCloses(
    t,
    () => {
      assert.throws(
        () => nativeFixtureData(invalidJson, ["runs"]),
        SyntaxError,
      );
      assert.throws(
        () => nativeFixtureData(missingTable, ["runs", "tools"]),
        /no such table: tools/,
      );
    },
    2,
  );
  assert.deepEqual([invalidJson, missingTable].map(fileHash), hashes);
});

test("native DATA rejects a missing original database without creating a replacement", (t) => {
  const base = mkdtempSync(join(tmpdir(), "moodcode-native-data-missing-")),
    path = join(base, "absent.sqlite");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.throws(
    () => nativeFixtureData(path, ["runs"]),
    /unable to open database file/,
  );
  assert.equal(existsSync(path), false);
});
