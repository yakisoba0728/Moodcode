import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishCrashEvidence } from "./atomic-crash-evidence.js";

const evidence = {
  boundary: "after-write",
  native: { state: "running", text: "원본 😀\n" },
  receipt: null,
};
const expected = Buffer.from(
  '{"boundary":"after-write","native":{"state":"running","text":"원본 😀\\n"},"receipt":null}',
);
const badDescriptor = (error: unknown) =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "EBADF";

test("native partial staging remains private until full bytes, close and same-directory rename", (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), "moodcode-full-evidence-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const readyPath = join(base, "ready.json");
  const stagingPath = readyPath + ".tmp";
  const open = fs.openSync,
    write = fs.writeFileSync,
    rename = fs.renameSync;
  let fd = -1,
    observedPartial = false,
    observedClosed = false;
  fs.openSync = (...args) => {
    const result = open(...args);
    if (args[0] === stagingPath && fd === -1) {
      assert.equal(args[1], "wx");
      assert.equal(args[2], 0o600);
      fd = result;
    }
    return result;
  };
  fs.writeFileSync = (file, data, options) => {
    if (file !== fd) return write(file, data, options);
    assert.ok(Buffer.isBuffer(data));
    const boundary = Math.floor(data.length / 2);
    write(file, data.subarray(0, boundary), options);
    assert.equal(fs.existsSync(readyPath), false);
    assert.deepEqual(
      fs.readFileSync(stagingPath),
      expected.subarray(0, boundary),
    );
    assert.throws(
      () => JSON.parse(fs.readFileSync(stagingPath, "utf8")),
      SyntaxError,
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(stagingPath).mode & 0o777, 0o600);
    observedPartial = true;
    write(file, data.subarray(boundary), options);
    assert.equal(fs.existsSync(readyPath), false);
  };
  fs.renameSync = (oldPath, newPath) => {
    assert.deepEqual([oldPath, newPath], [stagingPath, readyPath]);
    assert.throws(() => fs.fstatSync(fd), badDescriptor);
    assert.deepEqual(fs.readFileSync(stagingPath), expected);
    observedClosed = true;
    rename(oldPath, newPath);
  };
  syncBuiltinESMExports();
  try {
    publishCrashEvidence(readyPath, evidence);
  } finally {
    fs.openSync = open;
    fs.writeFileSync = write;
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(observedPartial, true);
  assert.equal(observedClosed, true);
  assert.deepEqual(fs.readFileSync(readyPath), expected);
  assert.equal(fs.existsSync(stagingPath), false);
});

test("actual native write failure keeps partial private staging and closes its original FD", (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), "moodcode-evidence-write-fault-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const readyPath = join(base, "ready.json");
  const stagingPath = readyPath + ".tmp";
  const write = fs.writeFileSync;
  let fd = -1;
  fs.writeFileSync = (file, data, options) => {
    assert.equal(typeof file, "number");
    assert.ok(Buffer.isBuffer(data));
    fd = file as number;
    const boundary = Math.floor(data.length / 2);
    write(fd, data.subarray(0, boundary), options);
    // The same native stage is reopened read-only; its next real write fails.
    const readOnly = fs.openSync(stagingPath, "r");
    try {
      write(readOnly, data.subarray(boundary), options);
    } finally {
      fs.closeSync(readOnly);
    }
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => publishCrashEvidence(readyPath, evidence),
      badDescriptor,
    );
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.throws(() => fs.fstatSync(fd), badDescriptor);
  assert.equal(fs.existsSync(readyPath), false);
  assert.deepEqual(
    fs.readFileSync(stagingPath),
    expected.subarray(0, Math.floor(expected.length / 2)),
  );
  assert.throws(
    () => JSON.parse(fs.readFileSync(stagingPath, "utf8")),
    SyntaxError,
  );
  if (process.platform !== "win32")
    assert.equal(fs.statSync(stagingPath).mode & 0o777, 0o600);
});

test("exclusive native staging collision preserves the original private bytes", (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), "moodcode-evidence-collision-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const readyPath = join(base, "ready.json");
  const stagingPath = readyPath + ".tmp";
  fs.writeFileSync(stagingPath, "Original retained staging bytes.", {
    mode: 0o600,
  });
  assert.throws(
    () => publishCrashEvidence(readyPath, evidence),
    (error: unknown) =>
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EEXIST",
  );
  assert.equal(fs.existsSync(readyPath), false);
  assert.equal(
    fs.readFileSync(stagingPath, "utf8"),
    "Original retained staging bytes.",
  );
});
