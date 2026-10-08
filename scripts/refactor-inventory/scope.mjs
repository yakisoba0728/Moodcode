import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

export const OWN_ROOTS = [
  "packages/engine/",
  "packages/contracts/",
  "packages/windows-job/",
  "apps/engine-harness/",
  "apps/desktop/",
  "scripts/",
  ".github/",
];
export const AST_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SOURCE_EXTENSIONS = new Set([
  ...AST_EXTENSIONS,
  ".css",
  ".html",
  ".yaml",
  ".yml",
  ".py",
  ".sh",
  ".rs",
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".go",
  ".sql",
  ".vue",
  ".svelte",
  ".swift",
  ".kt",
  ".java",
  ".rb",
  ".ps1",
  ".bat",
  ".cmd",
  ".lua",
]);
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "release",
  "coverage",
  ".git",
  ".moodcode",
  "clones",
  "clone",
  "dependencies",
  "vendor",
  "generated",
  ".next",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function physicalLines(text) {
  if (!text.length) return 0;
  const breaks = text.match(/\r\n|[\r\n\u2028\u2029]/gu)?.length ?? 0;
  return breaks + (/[\r\n\u2028\u2029]$/u.test(text) ? 0 : 1);
}

/** Path classification never opens configuration, data, secrets, or other repos. */
export function classifyPath(path) {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    return { scope: "excluded", reason: "unsafe-path" };
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) {
    return {
      scope: "excluded",
      reason: "dependency-clone-or-generated-directory",
    };
  }
  if (parts.some((part) => /^\.env(?:\.|$)/u.test(part))) {
    return {
      scope: "excluded",
      reason: "account-or-environment-configuration",
    };
  }
  const extension = extname(path).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) {
    return { scope: "excluded", reason: "non-source-extension" };
  }
  if (/\.(?:generated|gen)\.[^/]+$/u.test(path)) {
    return { scope: "excluded", reason: "generated-source-name" };
  }
  if (
    path.startsWith("docs/coding-agent-engine-review/") &&
    extension === ".py"
  ) {
    return {
      scope: "ancillary-analysis",
      area: "analysis",
      role: "analysis",
      extension,
    };
  }
  const root = OWN_ROOTS.find((candidate) => path.startsWith(candidate));
  if (!root) return { scope: "excluded", reason: "outside-owned-roots" };
  const area = {
    "packages/engine/": "engine",
    "packages/contracts/": "contracts",
    "packages/windows-job/": "windows-job",
    "apps/engine-harness/": "harness",
    "apps/desktop/": "desktop",
    "scripts/": "scripts",
    ".github/": "ci",
  }[root];
  const name = parts.at(-1);
  let role;
  if (/(?:^|[.-])(?:test|spec)\.[^.]+$/u.test(name)) role = "test";
  else if (
    parts.some((part) => part === "fixtures" || part === "__fixtures__") ||
    /(?:^|[.-])fixtures?\.[^.]+$/u.test(name)
  )
    role = "fixture";
  else role = area === "scripts" || area === "ci" ? "tooling" : "product";
  return { scope: "owned", area, role, extension };
}

/** Read one bounded regular source file; never follow a source symlink. */
export function readSource(root, path, maxBytes) {
  const fullPath = join(root, path);
  const within = relative(root, fullPath);
  if (!within || within === ".." || within.startsWith(`..${sep}`)) {
    throw new Error("unsafe-path");
  }
  let ancestor = dirname(fullPath);
  while (ancestor !== root) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("symlink-or-non-directory-ancestor");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("unsafe-path");
    ancestor = parent;
  }
  const pathStat = lstatSync(fullPath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error("symlink-or-non-regular-source");
  }
  if (pathStat.size > maxBytes) throw new Error("max-file-bytes");
  const fd = openSync(
    fullPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes)
      throw new Error("max-file-bytes");
    // The extra byte detects growth without unbounded readFile allocation.
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0,
      count;
    while ((count = readSync(fd, buffer, bytes, buffer.length - bytes, null))) {
      bytes += count;
      if (bytes === buffer.length) break;
    }
    const after = fstatSync(fd),
      afterPath = lstatSync(fullPath);
    if (
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino ||
      afterPath.isSymbolicLink() ||
      afterPath.ino !== after.ino ||
      afterPath.dev !== after.dev ||
      pathStat.ino !== before.ino
    )
      throw new Error("source-changed-during-read");
    const content = buffer.subarray(0, bytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (text.includes("\0")) throw new Error("binary-source");
    return {
      text,
      bytes,
      physicalLines: physicalLines(text),
      sha256: sha256(content),
    };
  } finally {
    closeSync(fd);
  }
}
