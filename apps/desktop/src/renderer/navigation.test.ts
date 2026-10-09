import assert from "node:assert/strict";
import test from "node:test";
import { workspaceFilePath } from "./navigation.js";

test("canonical Windows drive and UNC roots accept forward-slash relative hints", () => {
  for (const root of ["C:\\repo", "d:\\", "E:\\work space\\문서", "\\\\server\\share", "\\\\server\\share\\repo\\"])
    assert.equal(workspaceFilePath(root, "src/a.ts"), "src/a.ts", root);
});

test("malformed Windows roots cannot authorize relative hints", () => {
  for (const root of [
    "C:repo", "C:/repo", "1:\\repo", "\\repo", "\\\\server", "\\\\server\\", "\\\\\\\server\\share",
    "\\\\?\\C:\\repo", "\\\\.\\pipe", "C:\\repo\\..\\other", "C:\\repo\\.\\src", "C:\\repo\\\\src",
    "C:\\bad/part", "C:\\bad:stream", "C:\\bad?name", "C:\\bad\u0000name", "C:\\trailing.", "C:\\trailing ",
    "C:\\CON", "C:\\LPT1.txt", "\\\\server\\share\\..", "\\\\server\\share\\bad/part",
  ]) assert.equal(workspaceFilePath(root, "src/a.ts"), null, root);
});

test("relative traversal, native absolute input and URL-like references remain rejected", () => {
  for (const root of ["/repo", "C:\\repo", "\\\\server\\share\\repo"])
    for (const path of [
      "", ".", "..", "./a.ts", "../private.ts", "src/../a.ts", "src/./a.ts", "src//a.ts", "src/a.ts/",
      "/outside/a.ts", "//server/share/a.ts", "C:/repo/a.ts", "C:\\repo\\a.ts", "src\\a.ts",
      "file:///repo/a.ts", "https://example.com/a.ts", "src/a.ts?open=true", "src/a.ts#L1", "src/a.ts\u0000",
    ]) assert.equal(workspaceFilePath(root, path), null, `${root}: ${path}`);
});

test("POSIX workspace-local absolute references preserve their existing conversion", () => {
  assert.equal(workspaceFilePath("/repo/", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(workspaceFilePath("/repo", "/repository/src/a.ts"), null);
  assert.equal(workspaceFilePath("/", "/src/a.ts"), "src/a.ts");
  assert.equal(workspaceFilePath("/repo", "문서/my file.md"), "문서/my file.md");
});
