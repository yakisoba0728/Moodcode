import { readFileSync } from "node:fs";
import ts from "typescript";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { inspectAst } from "./ast.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const started = performance.now(),
  deadline = started + input.timeoutMs;
function checkDeadline() {
  if (performance.now() > deadline) throw new Error("ast-deadline");
}
// This project is synthetic and never reads the user's tsconfig/package/account files.
const cwd =
  process.platform === "win32"
    ? "C:/refactor-inventory"
    : "/refactor-inventory";
const config = `${cwd}/tsconfig.json`,
  virtual = Object.create(null);
virtual[config] = JSON.stringify({
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    jsx: "preserve",
  },
  files: input.sources.map((source) => source.path),
});
for (const source of input.sources)
  virtual[`${cwd}/${source.path}`] = source.text;
const fs = createVirtualFileSystem(virtual);
const read = fs.readFile,
  entries = fs.getAccessibleEntries;
// undefined means fall back to the real FS in TS 7; close both fallbacks explicitly.
fs.readFile = (path) => read(path) ?? null;
fs.getAccessibleEntries = (path) =>
  entries(path) ?? { files: [], directories: [] };
const api = new API({ cwd, fs });
const records = [];
try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const project = snapshot.getProject(config);
  if (!project) throw new Error("synthetic-project-missing");
  for (const source of input.sources) {
    checkDeadline();
    try {
      const path = `${cwd}/${source.path}`;
      const file = project.program.getSourceFile(path);
      if (!file || file.text !== source.text)
        throw new Error("captured-source-mismatch");
      const diagnostics = project.program.getSyntacticDiagnostics(path);
      if (diagnostics.length) {
        records.push({
          path: source.path,
          status: "failed",
          reason: "parse-diagnostics",
          diagnosticCount: diagnostics.length,
          diagnostics: diagnostics.slice(0, 20).map((item) => ({
            code: item.code,
            start: item.start ?? null,
            length: item.length ?? null,
          })),
        });
      } else
        records.push({
          path: source.path,
          status: "measured",
          ...inspectAst(file, source.path, checkDeadline),
        });
    } catch (error) {
      records.push({
        path: source.path,
        status: "failed",
        reason: String(error.message).slice(0, 160),
      });
    }
  }
  snapshot.dispose();
} finally {
  api.close();
}
process.stdout.write(
  JSON.stringify({
    typescript: ts.version,
    records,
    observations: {
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      memory: process.memoryUsage(),
      scope: "inventory-worker-only; excludes native compiler peak memory",
    },
  }),
);
