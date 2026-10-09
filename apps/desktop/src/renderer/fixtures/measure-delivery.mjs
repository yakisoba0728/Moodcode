import { build } from "vite";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const output = process.argv[2],
  revision = process.argv[3],
  repository = resolve(".");
if (!output)
  throw new Error(
    "Provide the graph report output path and optional baseline revision.",
  );
const outDir = await mkdtemp(join(tmpdir(), "moodcode-renderer-graph-"));
const originals = new Map();
if (revision) {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", revision, "apps/desktop/src/renderer"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const file of files.filter((file) => /\.(?:tsx?|css)$/u.test(file)))
    originals.set(
      resolve(file),
      execFileSync("git", ["show", `${revision}:${file}`], {
        encoding: "utf8",
      }),
    );
}
let chunks;
await build({
  configFile: resolve("apps/desktop/vite.config.mjs"),
  build: { outDir },
  plugins: [
    {
      name: "baseline-renderer-sources",
      enforce: "pre",
      transform(_code, id) {
        return originals.get(id);
      },
    },
    {
      name: "renderer-delivery-graph",
      generateBundle(_options, bundle) {
        chunks = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .map((item) => ({
            file: item.fileName,
            entry: item.isEntry,
            imports: item.imports,
            dynamicImports: item.dynamicImports,
            modules: Object.keys(item.modules).map((id) =>
              id.replace(repository + "/", ""),
            ),
          }));
      },
    },
  ],
});
for (const chunk of chunks)
  chunk.bytes = (await readFile(join(outDir, chunk.file))).length;
const initial = new Set();
function visit(file) {
  if (initial.has(file)) return;
  initial.add(file);
  for (const dependency of chunks.find((chunk) => chunk.file === file)
    ?.imports ?? [])
    visit(dependency);
}
for (const chunk of chunks.filter((chunk) => chunk.entry)) visit(chunk.file);
const report = {
  baselineRevision: revision ?? null,
  outDir,
  chunks,
  initialFiles: [...initial],
  initialJSBytes: chunks
    .filter((chunk) => initial.has(chunk.file))
    .reduce((bytes, chunk) => bytes + chunk.bytes, 0),
  totalJSBytes: chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0),
  largestChunkBytes: Math.max(...chunks.map((chunk) => chunk.bytes)),
};
await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    initialJSBytes: report.initialJSBytes,
    totalJSBytes: report.totalJSBytes,
    largestChunkBytes: report.largestChunkBytes,
    initialFiles: report.initialFiles,
  }),
);
