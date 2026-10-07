import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@moodcode/contracts";
import {
  captureTypeScriptProjectSources,
  TYPESCRIPT_PROJECT_SOURCE_LIMITS,
} from "./project-sources.js";
import { runGit } from "../workspace/git.js";

const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, expected);
  return true;
};
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-ts-project-source-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  const workspace: Workspace = {
    id: "project-source",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
  return { root, workspace };
}

test("native project digest pins unopened sources, membership and tsconfig without including document bodies", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const value = 1;\r\n");
  await writeFile(join(f.root, "barrel.ts"), "export { value } from './a';\n");
  await writeFile(
    join(f.root, "tsconfig.json"),
    '{"compilerOptions":{"strict":true}}',
  );
  const first = await captureTypeScriptProjectSources(f.workspace, signal());
  assert.deepEqual(
    await captureTypeScriptProjectSources(f.workspace, signal()),
    first,
  );
  assert.equal(first.fileCount, 3);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(JSON.stringify(first).includes("export"), false);
  await writeFile(
    join(f.root, "barrel.ts"),
    "export { value } from './a';\n// changed unopened source\n",
  );
  const edited = await captureTypeScriptProjectSources(f.workspace, signal());
  assert.notEqual(edited.sha256, first.sha256);
  await writeFile(
    join(f.root, "tsconfig.json"),
    '{"compilerOptions":{"strict":false}}',
  );
  const configured = await captureTypeScriptProjectSources(
    f.workspace,
    signal(),
  );
  assert.notEqual(configured.sha256, edited.sha256);
  await rm(join(f.root, "barrel.ts"));
  const deleted = await captureTypeScriptProjectSources(f.workspace, signal());
  assert.equal(deleted.fileCount, 2);
  assert.notEqual(deleted.sha256, configured.sha256);
});

test("project snapshot excludes Git-ignored and generated/dependency trees and binds effective ignore changes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".gitignore"), "private/\n");
  await writeFile(join(f.root, "a.ts"), "export const value = 1;");
  for (const name of ["private", "node_modules", "dist"]) {
    await mkdir(join(f.root, name));
    await writeFile(
      join(f.root, name, "hidden.ts"),
      "export const hidden = 2;",
    );
  }
  const first = await captureTypeScriptProjectSources(f.workspace, signal());
  assert.equal(first.fileCount, 2);
  await writeFile(
    join(f.root, "private", "hidden.ts"),
    "export const hidden = 3;",
  );
  assert.deepEqual(
    await captureTypeScriptProjectSources(f.workspace, signal()),
    first,
  );
  await writeFile(join(f.root, ".gitignore"), "# no longer ignored\n");
  const included = await captureTypeScriptProjectSources(f.workspace, signal());
  assert.equal(included.fileCount, 3);
  assert.notEqual(included.sha256, first.sha256);
});

test("physical source aliases and non-UTF8 compiler sources do not become semantic provenance", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const value = 1;");
  await symlink(join(f.root, "a.ts"), join(f.root, "alias.ts"));
  await assert.rejects(
    captureTypeScriptProjectSources(f.workspace, signal()),
    code("UNSAFE_LSP_WORKSPACE"),
  );
  await rm(join(f.root, "alias.ts"));
  await writeFile(join(f.root, "a.ts"), Buffer.from([0xff, 0x00]));
  await assert.rejects(
    captureTypeScriptProjectSources(f.workspace, signal()),
    code("UNSUPPORTED_FILE_ACTION"),
  );
});

test("pre-cancelled native source capture performs no missing-root filesystem observation", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    captureTypeScriptProjectSources(
      {
        id: "absent",
        root: "/not-present-moodcode-source",
        gitRoot: "",
        branch: null,
        createdAt: "",
      },
      abort.signal,
    ),
    code("CANCELLED"),
  );
});

test("project membership cap rejects an oversized real source directory before semantic dispatch", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "many"));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (cursor <= TYPESCRIPT_PROJECT_SOURCE_LIMITS.files) {
        const index = cursor++;
        await writeFile(join(f.root, "many", `${index}.ts`), "export {};");
      }
    }),
  );
  await assert.rejects(
    captureTypeScriptProjectSources(f.workspace, signal()),
    code("LSP_PROJECT_SOURCE_LIMIT"),
  );
});
