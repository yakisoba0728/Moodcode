import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  clientEffectToolName,
  clientReadToolInput,
  terminalCommandLine,
  workspaceLocalPath,
} from "./client-effects.js";

test("client effects map to the exact Runner tool inputs that the store verifies", () => {
  assert.equal(
    clientEffectToolName({ callId: "r", path: "/w/a" }),
    "read_file",
  );
  assert.equal(
    clientEffectToolName({
      callId: "w",
      method: "fs/write_text_file",
      path: "/w/a",
      content: "",
    }),
    "apply_patch",
  );
  assert.equal(
    clientEffectToolName({
      callId: "t",
      method: "terminal/create",
      command: "ls",
      args: [],
      cwd: "/w",
      outputByteLimit: 1,
    }),
    "run_command",
  );
  const root = join("/", "workspace");
  assert.equal(workspaceLocalPath(root, join(root, "src", "a.ts")), "src/a.ts");
  for (const outside of [root, join(root, ".."), join(root, "..", "other")])
    assert.equal(workspaceLocalPath(root, outside), undefined);
  assert.equal(terminalCommandLine("ls -la | wc", []), "ls -la | wc");
  assert.equal(
    terminalCommandLine("printf", ["%s", "it's"]),
    "'printf' '%s' 'it'\\''s'",
  );
  assert.equal(
    JSON.stringify(clientReadToolInput("a.ts", undefined, undefined)),
    '{"path":"a.ts","startLine":1}',
  );
  assert.equal(
    JSON.stringify(clientReadToolInput("a.ts", 5, 3)),
    '{"path":"a.ts","startLine":5,"endLine":7}',
  );
});
