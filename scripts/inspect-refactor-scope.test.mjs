import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  inspectRefactorScope,
  parseInventoryArgs,
  runInventoryCli,
} from "./inspect-refactor-scope.mjs";
import { physicalLines, readSource } from "./refactor-inventory/scope.mjs";

const inspector = fileURLToPath(
  new URL("./inspect-refactor-scope.mjs", import.meta.url),
);
const environment = {
  PATH: process.env.PATH ?? "",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

function command(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
}

function repository(t, entries) {
  const root = mkdtempSync(join(tmpdir(), "moodcode-refactor-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  command(root, ["init", "--quiet"]);
  for (const [path, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  command(root, ["add", "--all"]);
  return root;
}

function measure(root, args = []) {
  return inspectRefactorScope(
    parseInventoryArgs([
      "--root",
      root,
      "--stable",
      "--detail",
      "full",
      ...args,
    ]),
  );
}

function source(report, path) {
  const file = report.files.find((item) => item.path === path);
  assert.ok(file, `Missing source: ${path}`);
  return file;
}

test("help and invalid options do no inspection or compiler loading", async () => {
  let inspections = 0;
  const inspect = () => {
    inspections++;
    throw new Error("unexpected inspection");
  };
  const output = () => {};
  assert.equal(
    await runInventoryCli(["--help", "--root", "/missing-repository"], {
      inspect,
      output,
    }),
    0,
  );
  for (const args of [
    ["--live"],
    ["--top", "0"],
    ["--top", "1.0"],
    ["--top", "101"],
    ["--max-files", "20001"],
    ["--max-total-bytes", "268435457"],
    ["--timeout-ms", "99"],
    ["--timeout-ms", "120001"],
    ["--detail", "unused"],
    ["--root"],
    ["--stable", "--stable"],
    ["--top", "10", "--top", "10"],
    ["--help", "--live"],
  ])
    assert.equal(
      await runInventoryCli(args, { inspect, output, error() {} }),
      2,
    );
  assert.equal(inspections, 0);
  const result = spawnSync(
    process.execPath,
    [inspector, "--help", "--root", "/missing-repository"],
    {
      env: environment,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /without scanning or loading the compiler/u);
  assert.deepEqual(
    parseInventoryArgs(["--top", "100", "--duplicate-min-nodes", "10000"]).top,
    100,
  );
});

test("physical lines count blanks/comments and CRLF without a phantom trailing line", () => {
  for (const [text, expected] of [
    ["", 0],
    ["\n", 1],
    ["a", 1],
    ["a\n", 1],
    ["a\n\n", 2],
    ["// comment\r\n\r\nvalue", 3],
    ["a\rb\r", 2],
    ["a\u2028b", 2],
  ])
    assert.equal(physicalLines(text), expected);
});

test("standalone help rejects compiler/provider dependencies, child processes and credential environment access", (t) => {
  const root = repository(t, {}),
    guard = join(root, "guard.mjs");
  const allowed = [
    inspector,
    ...["scope", "report", "process"].map((name) =>
      join(dirname(inspector), "refactor-inventory", `${name}.mjs`),
    ),
  ].map((path) => pathToFileURL(path).href);
  writeFileSync(
    guard,
    `
import child from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])
  child[name]=()=>{throw new Error('Help started a child process');};
syncBuiltinESMExports();
process.env=new Proxy(process.env,{get(target,key){
  if(typeof key==='string'&&/^(HOME|CODEX_HOME|OPENAI_API_KEY|ANTHROPIC_API_KEY|MOODCODE_API_KEY|.*_TOKEN)$/.test(key))
    throw new Error('Help read account environment');
  return Reflect.get(target,key);
}});
const allowed=new Set(${JSON.stringify(allowed)});
registerHooks({resolve(specifier,context,next){
  const result=next(specifier,context);
  if(!result.url.startsWith('node:')&&!allowed.has(result.url))
    throw new Error('Unexpected help dependency');
  return result;
}});
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", guard, inspector, "--help", "--root", "/missing-repository"],
    {
      env: { ...environment, OPENAI_API_KEY: "unused-fixture-sentinel" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/u);
});

test("provider/config/runtime source is parsed without executing any top-level code", async (t) => {
  const root = repository(t, {
    "packages/engine/src/provider/index.ts":
      "throw new Error('Provider runtime executed');\nexport const provider = 1;\n",
    "packages/engine/src/config/index.ts":
      "throw new Error('Account config reader executed');\nexport const config = 1;\n",
    "scripts/live.mjs":
      "throw new Error('Live script executed');\nexport const live = 1;\n",
  });
  const report = await measure(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.syntax.measured, 3);
  assert.equal(report.coverage.syntax.failed, 0);
});

test("hand-counted nested functions retain inclusive spans and exclusive syntax decisions", async (t) => {
  const path = "packages/engine/src/metric.ts";
  const text = [
    "// heading",
    "",
    "export function outer(flag: boolean) {",
    "  const nested = () => {",
    "    if (flag) return 1;",
    "    return 0;",
    "  };",
    "  if (flag && nested()) return 2;",
    "  return flag ? 3 : 4;",
    "}",
    "",
    "outer(false);",
    "",
  ].join("\r\n");
  const root = repository(t, { [path]: text });
  const report = await measure(root);
  assert.equal(report.complete, true);
  assert.equal(report.refactorAcceptance, false);
  assert.equal(report.executionStatus, "completed");
  assert.equal(report.source.head, null); // An index without commits is still source-qualified.
  assert.equal(report.source.stable, true);
  assert.equal(report.runtime.observations, null);
  assert.match(report.runtime.typescript, /^7\./u);
  assert.equal(source(report, path).physicalLines, 12);
  assert.equal(
    source(report, path).sha256,
    createHash("sha256").update(text).digest("hex"),
  );
  const { functions, calls, exports, decisions, topLevelBranches } = source(
    report,
    path,
  ).syntax;
  assert.equal(functions.length, 2);
  assert.deepEqual(
    functions.map(({ name, start, end, lines, complexity, branches }) => ({
      name,
      start,
      end,
      lines,
      complexity,
      branches,
    })),
    [
      {
        name: "outer",
        start: 3,
        end: 10,
        lines: 8,
        complexity: 4,
        branches: { "&&": 1, conditional: 1, if: 1 },
      },
      {
        name: "nested",
        start: 4,
        end: 7,
        lines: 4,
        complexity: 2,
        branches: { if: 1 },
      },
    ],
  );
  assert.equal(decisions, 4);
  assert.deepEqual(topLevelBranches, {});
  assert.deepEqual(
    calls.map(({ target, line }) => ({ target, line })),
    [
      { target: "nested", line: 8 },
      { target: "outer", line: 12 },
    ],
  );
  assert.deepEqual(
    exports.map(({ name, line }) => ({ name, line })),
    [{ name: "outer", line: 3 }],
  );
  assert.deepEqual(report.totals.owned, {
    files: 1,
    measuredFiles: 1,
    physicalLines: 12,
    bytes: Buffer.byteLength(text),
    functions: 2,
    imports: 0,
    exports: 1,
    calls: 2,
  });
});

test("loops, cases, catch, logical assignment and JSX count AST branches; words in strings do not", async (t) => {
  const root = repository(t, {
    "packages/engine/src/branches.ts": `export function branches(value: number, values: number[]) {
  const text = "if && || ?? catch ? case";
  if (value) value ||= 1; else value &&= 2;
  value ??= 3;
  for (const item of values) value += item;
  for (const key in values) value += +key;
  for (let index = 0; index < 1; index++) value++;
  while (value < 4) value++;
  do { value--; } while (value > 4);
  try { value = value || 1; } catch { value = value ?? 2; } finally { value++; }
  switch (value) { case 1: return text; case 2: return "two"; default: return value ? "yes" : "no"; }
}
if (true) branches(0, []);
`,
    "apps/desktop/src/renderer/Screen.tsx": `export const Screen = (flag: boolean) => <div>{flag ? "if" : "else"}</div>;\n`,
  });
  const report = await measure(root);
  const file = source(report, "packages/engine/src/branches.ts");
  assert.equal(file.syntax.functions[0].complexity, 16);
  assert.deepEqual(file.syntax.functions[0].branches, {
    "??": 1,
    "??=": 1,
    "&&=": 1,
    "||": 1,
    "||=": 1,
    case: 2,
    catch: 1,
    conditional: 1,
    do: 1,
    for: 1,
    "for-in": 1,
    "for-of": 1,
    if: 1,
    while: 1,
  });
  assert.deepEqual(file.syntax.topLevelBranches, { if: 1 });
  assert.equal(file.syntax.decisions, 16);
  assert.equal(
    source(report, "apps/desktop/src/renderer/Screen.tsx").syntax.functions[0]
      .complexity,
    2,
  );
});

test("constructors, accessors, methods and arrow/expression bodies are executable; signatures are not", async (t) => {
  const root = repository(t, {
    "packages/engine/src/functions.ts": `export class Holder {
  constructor(private value: number) { this.value = value; }
  get current() { return this.value; }
  set current(value: number) { this.value = value; }
  method(value?: number) { return value ?? this.value; }
}
const arrow = (value: number) => value ? 1 : 0;
const expression = function named(value: number) { return value; };
function overloaded(value: number): number;
function overloaded(value: string): string;
function overloaded(value: string | number) { return value; }
declare function signature(value: number): number;
new Holder(2);
`,
  });
  const report = await measure(root);
  const file = source(report, "packages/engine/src/functions.ts");
  assert.deepEqual(
    file.syntax.functions.map(({ name, kind, start, lines, complexity }) => ({
      name,
      kind,
      start,
      lines,
      complexity,
    })),
    [
      {
        name: "constructor",
        kind: "constructor",
        start: 2,
        lines: 1,
        complexity: 1,
      },
      { name: "current", kind: "getter", start: 3, lines: 1, complexity: 1 },
      { name: "current", kind: "setter", start: 4, lines: 1, complexity: 1 },
      { name: "method", kind: "method", start: 5, lines: 1, complexity: 2 },
      { name: "arrow", kind: "arrow", start: 7, lines: 1, complexity: 2 },
      {
        name: "named",
        kind: "function-expression",
        start: 8,
        lines: 1,
        complexity: 1,
      },
      {
        name: "overloaded",
        kind: "function",
        start: 11,
        lines: 1,
        complexity: 1,
      },
    ],
  );
  assert.equal(file.syntax.calls.at(-1).kind, "new");
  assert.equal(file.syntax.calls.at(-1).target, "Holder");
});

test("ownership exclusions, test/fixture priority and ancillary analysis are separate", async (t) => {
  const entries = {
    "packages/engine/src/index.ts": "export const value = 1;\n",
    "packages/engine/src/fixtures/helper.ts": "export const fixture = 1;\n",
    "packages/engine/src/fixtures/helper.test.ts": "export const test = 1;\n",
    "packages/engine/src/child.fixture.ts": "export const child = 1;\n",
    "apps/desktop/src/worker/fixtures.ts": "export const fixture = 1;\n",
    "scripts/check.mjs": "export const check = 1;\n",
    ".github/scripts/check.test.mjs": "export const test = 1;\n",
    "docs/coding-agent-engine-review/check.py": "# analysis\nprint('one')\n",
    "packages/engine/dist/copied.ts": "this is not valid TypeScript",
    "packages/engine/src/vendor/copied.ts": "this is not valid TypeScript",
    "packages/engine/src/generated/copied.ts": "this is not valid TypeScript",
    "packages/engine/src/output.generated.ts": "this is not valid TypeScript",
    "packages/engine/src/.env.secret.ts": "secret fixture sentinel",
    "packages/engine/package.json":
      "{ invalid account-like configuration sentinel",
    "packages/engine/tsconfig.json":
      "{ invalid account-like configuration sentinel",
    "clones/untrusted/src/copied.ts": "this is not valid TypeScript",
    "other-project/src/copied.ts": "this is not valid TypeScript",
  };
  const root = repository(t, entries);
  writeFileSync(
    join(root, "packages/engine/src/untracked.ts"),
    "this is untracked and invalid",
  );
  const report = await measure(root);
  assert.equal(report.totals.owned.files, 7);
  assert.equal(report.totals.owned.physicalLines, 7);
  assert.equal(report.totals.byAreaAndRole["engine/test"].files, 1);
  assert.equal(report.totals.byAreaAndRole["engine/fixture"].files, 2);
  assert.equal(
    report.totals.ancillaryByAreaAndRole["analysis/analysis"].lines,
    2,
  );
  assert.equal(report.coverage.syntax.failed, 0);
  assert.equal(
    report.files.some((file) =>
      /copied|secret|package\.json|tsconfig|untracked/u.test(file.path),
    ),
    false,
  );
  assert.deepEqual(report.exclusions.byReason, {
    "account-or-environment-configuration": 1,
    "dependency-clone-or-generated-directory": 4,
    "generated-source-name": 1,
    "non-source-extension": 2,
    "outside-owned-roots": 1,
  });
});

test("unreadable, binary, invalid and unsupported tracked sources stay visible and prevent completeness", async (t) => {
  const root = repository(t, {
    "packages/engine/src/missing.ts": "export const value = 1;\n",
    "packages/engine/src/binary.ts": Buffer.from([0xff, 0xfe]),
    "packages/engine/src/broken.ts": "export function broken( {\n",
    "packages/engine/src/utility.py": "print('one')\n",
    "apps/desktop/src/theme.css": "body { color: red; }\n",
  });
  rmSync(join(root, "packages/engine/src/missing.ts"));
  const report = await measure(root);
  assert.equal(report.complete, false);
  assert.equal(report.executionStatus, "completed-with-measurement-failures");
  assert.deepEqual(report.coverage.physical, {
    attempted: 5,
    measured: 3,
    failed: 2,
  });
  assert.deepEqual(report.coverage.syntax, {
    attempted: 5,
    measured: 0,
    unsupported: 2,
    failed: 3,
  });
  assert.equal(report.coverage.failures.length, 5);
  assert.equal(
    source(report, "packages/engine/src/missing.ts").physicalReason,
    "ENOENT",
  );
  assert.equal(
    source(report, "packages/engine/src/binary.ts").physicalReason,
    "ERR_ENCODING_INVALID_ENCODED_DATA",
  );
  assert.equal(
    source(report, "packages/engine/src/broken.ts").syntax.reason,
    "parse-diagnostics",
  );
  assert.ok(
    source(report, "packages/engine/src/broken.ts").syntax.diagnosticCount > 0,
  );
  assert.equal(
    source(report, "packages/engine/src/broken.ts").syntax.functions,
    undefined,
  );
});

test("known physical-only CSS/HTML/YAML coverage gaps are explicit, not operational failures", async (t) => {
  const root = repository(t, {
    "apps/desktop/theme.css": "body {}\n",
    "apps/desktop/index.html": "<main>one</main>\n",
    ".github/workflows/check.yml": "name: one\n",
  });
  let output = "";
  assert.equal(
    await runInventoryCli(["--root", root, "--stable"], {
      output(value) {
        output += value;
      },
    }),
    1,
  );
  const report = JSON.parse(output);
  assert.equal(report.executionStatus, "completed");
  assert.equal(
    report.state,
    "measured-with-unsupported-syntax; manual review outstanding",
  );
  assert.equal(report.complete, false);
  assert.deepEqual(report.coverage.syntax, {
    attempted: 3,
    measured: 0,
    unsupported: 3,
    failed: 0,
  });
  assert.deepEqual(report.coverage.physical, {
    attempted: 3,
    measured: 3,
    failed: 0,
  });
});

test(
  "symlinks and a symlinked source ancestor cannot read an external sentinel",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = repository(t, {
      "packages/engine/src/regular.ts": "export const value = 1;\n",
    });
    const outside = mkdtempSync(join(tmpdir(), "moodcode-refactor-external-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(
      join(outside, "sentinel.ts"),
      "external sentinel never inventoried",
    );
    symlinkSync(
      join(outside, "sentinel.ts"),
      join(root, "packages/engine/src/linked.ts"),
    );
    symlinkSync(
      outside,
      join(root, "packages/engine/src/linked-directory"),
      "dir",
    );
    command(root, ["add", "packages/engine/src/linked.ts"]);
    const report = await measure(root);
    assert.equal(report.coverage.physical.failed, 1);
    assert.equal(
      source(report, "packages/engine/src/linked.ts").physicalReason,
      "non-regular-index-entry",
    );
    assert.equal(
      source(report, "packages/engine/src/linked.ts").sha256,
      undefined,
    );
    assert.throws(
      () =>
        readSource(
          root,
          "packages/engine/src/linked-directory/sentinel.ts",
          4096,
        ),
      /symlink-or-non-directory-ancestor/u,
    );
    assert.throws(
      () => readSource(root, "../sentinel.ts", 4096),
      /unsafe-path/u,
    );
  },
);

test("file/count/aggregate/output bounds produce quantified failures", async (t) => {
  const root = repository(t, {
    "packages/engine/src/a.ts": "export const one = 1;\n",
    "packages/engine/src/b.ts": "export const two = 2;\n",
  });
  const count = await measure(root, ["--max-files", "1"]);
  assert.equal(count.coverage.physical.measured, 1);
  assert.equal(count.coverage.physical.failed, 1);
  assert.equal(count.coverage.boundsExceeded, true);
  assert.equal(
    source(count, "packages/engine/src/b.ts").physicalReason,
    "max-files",
  );
  const bytes = await measure(root, ["--max-file-bytes", "1"]);
  assert.equal(bytes.coverage.physical.failed, 2);
  assert.equal(
    source(bytes, "packages/engine/src/a.ts").physicalReason,
    "max-file-bytes",
  );
  const aggregate = await measure(root, ["--max-total-bytes", "22"]);
  assert.equal(aggregate.coverage.physical.measured, 1);
  assert.equal(
    source(aggregate, "packages/engine/src/b.ts").physicalReason,
    "max-total-bytes",
  );
  let output = "";
  assert.equal(
    await runInventoryCli(["--max-report-bytes", "1024"], {
      inspect: async () => ({ complete: true, padding: "x".repeat(2048) }),
      output(value) {
        output += value;
      },
    }),
    1,
  );
  assert.equal(JSON.parse(output).failure, "max-report-bytes");
  assert.equal(JSON.parse(output).executionStatus, "failed");
});

test("exact body duplicates ignore trivia but preserve literals, identifiers and nontrivial bounds", async (t) => {
  const root = repository(t, {
    "packages/engine/src/duplicates.ts": `export function first(value: number) {
  const limit = 2;
  const label = "safe";
  const fallback = "none";
  if (value === 0) return fallback;
  if (value > limit) return label;
  for (let index = 0; index < limit; index++) value += index;
  return String(value);
}
export function second(value: number) {
  // Different comments do not change executable syntax.
  const limit = 2;
  const label = "safe";
  const fallback = "none";
  if (value === 0) return fallback;
  if (value > limit) return label;
  for (let index = 0; index < limit; index++) value += index;
  return String(value);
}
export function differentLiteral(value: number) {
  const limit = 2;
  const label = "other";
  const fallback = "none";
  if (value === 0) return fallback;
  if (value > limit) return label;
  for (let index = 0; index < limit; index++) value += index;
  return String(value);
}
export function differentIdentifier(input: number) {
  const limit = 2;
  const label = "safe";
  const fallback = "none";
  if (input === 0) return fallback;
  if (input > limit) return label;
  for (let index = 0; index < limit; index++) input += index;
  return String(input);
}
export function tinyOne() { return 1; }
export function tinyTwo() { return 1; }
`,
  });
  const report = await measure(root);
  assert.equal(report.candidates.duplication.totalGroups, 1);
  assert.deepEqual(
    report.candidates.duplication.groups[0].occurrences.map(
      (item) => item.name,
    ),
    ["first", "second"],
  );
  assert.match(report.candidates.duplication.groups[0].state, /unverified/u);
  const functions = source(report, "packages/engine/src/duplicates.ts").syntax
    .functions;
  assert.notEqual(
    functions[0].fingerprint.sha256,
    functions[2].fingerprint.sha256,
  );
  assert.notEqual(
    functions[0].fingerprint.sha256,
    functions[3].fingerprint.sha256,
  );
  const highThreshold = await measure(root, ["--duplicate-min-nodes", "10000"]);
  assert.equal(highThreshold.candidates.duplication.totalGroups, 0);
});

test("import/export/call sites resolve tracked source spellings but never certify unused code", async (t) => {
  const root = repository(t, {
    "packages/engine/src/producer.ts":
      "export function used() { return 1; }\nexport function callback() { return 2; }\n",
    "packages/engine/src/consumer.ts": `import { used as alias, callback } from "./producer.js";
const callbacks = [callback];
alias();
const path = "./producer.js";
import(path);
export { alias as exposed };
export type Kind = number;
`,
    "packages/engine/src/index.ts": "export * from './producer.js';\n",
    "packages/contracts/src/index.ts":
      "export interface Contract { id: string }\n",
    "apps/engine-harness/src/index.ts":
      "import type { Contract } from '@moodcode/contracts';\nimport { used } from '@moodcode/engine';\nused();\n",
    "scripts/consumer.cjs":
      "const loaded = require('../packages/engine/src/producer.js');\nexports.get = loaded.used;\n",
  });
  const report = await measure(root);
  const edge = report.graph.edges.find(
    (item) => item.from.endsWith("consumer.ts") && item.kind === "import",
  );
  assert.equal(edge.target, "packages/engine/src/producer.ts");
  assert.equal(edge.bindings[0].local, "alias");
  assert.equal(report.graph.computedModuleSites, 1);
  assert.equal(report.graph.symbolResolution, false);
  assert.ok(
    report.graph.edges.some(
      (item) => item.resolution === "workspace-entry" && item.typeOnly,
    ),
  );
  const candidate = report.candidates.longestFunctions.find(
    (item) => item.name === "used",
  );
  assert.deepEqual(candidate.namedImportConsumers, [
    {
      path: "packages/engine/src/consumer.ts",
      importLine: 1,
      local: "alias",
      matchedCalls: 1,
      callLines: [3],
    },
  ]);
  const callback = report.candidates.noMatchedCall.find(
    (item) => item.name === "callback",
  );
  assert.ok(callback);
  assert.match(callback.state, /no defect or unused-code conclusion/u);
  assert.equal(callback.namedImportConsumers[0].matchedCalls, 0);
  assert.ok(
    report.candidates.manualGates.some((item) => /callbacks/u.test(item)),
  );
  assert.ok(
    report.candidates.manualGates.some((item) =>
      /DB transactions, archives/u.test(item),
    ),
  );
  assert.equal(
    source(report, "scripts/consumer.cjs").syntax.exports[0].name,
    "get",
  );
});

test("stable JSON and source pins respond to working-tree content independently of the index", async (t) => {
  const path = "packages/engine/src/space 한글.ts";
  const root = repository(t, { [path]: "export const value = 1;\n" });
  const before = await measure(root),
    repeated = await measure(root);
  assert.deepEqual(repeated, before);
  writeFileSync(join(root, path), "export const value = 2;\n");
  const changed = await measure(root);
  assert.equal(before.source.indexSha256, changed.source.indexSha256);
  assert.notEqual(before.source.fingerprint, changed.source.fingerprint);
  assert.notEqual(source(before, path).sha256, source(changed, path).sha256);
  assert.equal(changed.source.stable, true);
  assert.equal(
    source(changed, path).index[0].oid,
    source(before, path).index[0].oid,
  );
  for (const [path, expected] of Object.entries(changed.runtime.toolPins)) {
    const actual = createHash("sha256")
      .update(readFileSync(join(dirname(dirname(inspector)), path)))
      .digest("hex");
    assert.equal(expected, actual);
  }
});

test("a source or index mutation during asynchronous inspection invalidates the capture", async (t) => {
  const path = "packages/engine/src/mutation.ts";
  const before = "export function before() { return 1; }\n";
  const root = repository(t, { [path]: before });
  // measure captures synchronously before it awaits the compiler worker.
  const pending = measure(root);
  writeFileSync(join(root, path), "export function after() { return 2; }\n");
  command(root, ["add", path]);
  const report = await pending;
  assert.equal(report.complete, false);
  assert.equal(report.source.stable, false);
  assert.deepEqual(report.source.workingTreeChangedPaths, [path]);
  assert.notEqual(report.source.indexSha256, report.source.afterIndexSha256);
  assert.equal(
    source(report, path).sha256,
    createHash("sha256").update(before).digest("hex"),
  );
  assert.equal(source(report, path).syntax.functions[0].name, "before");
  assert.equal(report.executionStatus, "completed-with-measurement-failures");
});
