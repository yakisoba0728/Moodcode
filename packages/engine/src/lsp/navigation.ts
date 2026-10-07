import { relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EngineError,
  type JsonValue,
  type Workspace,
} from "@moodcode/contracts";
import { boundedJson } from "../artifacts/validation.js";
import {
  positionOffset,
  type TextPosition,
  type TextRange,
} from "../formatters/edits.js";
import { exactPath, readExactText } from "../tools/file-actions/text.js";
import {
  excludedTraversalPath,
  ignoredWorkspacePaths,
} from "../workspace/ignore.js";

export const LSP_NAVIGATION_LIMITS = Object.freeze({
  rawBytes: 65_536,
  nodes: 512,
  depth: 16,
  items: 64,
  files: 16,
  fileBytes: 2_097_152,
  resultBytes: 16_384,
});
export type LspNavigationKind = "symbols" | "definition" | "references";
export interface LspNavigationItem {
  path: string;
  hash: string;
  range: TextRange;
  name?: string;
  symbolKind?: number;
  depth?: number;
}
export interface LspNavigationSnapshot {
  serverId: string;
  workspaceId: string;
  path: string;
  documentVersion: number;
  documentHash: string;
  kind: LspNavigationKind;
  items: LspNavigationItem[];
  sources: { path: string; hash: string }[];
  complete: boolean;
  omitted: {
    outsideWorkspace: number;
    unavailable: number;
    ignored: number;
    limits: number;
  };
}
interface Candidate {
  uri: string;
  range: unknown;
  enclosingRange?: unknown;
  originRange?: unknown;
  name?: string;
  symbolKind?: number;
  depth?: number;
}
const fail = (): never => {
  throw new EngineError(
    "INVALID_LSP_NAVIGATION_RESULT",
    "Navigation needs bounded valid locations or document symbols",
  );
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
export function navigationRange(text: string, value: unknown): TextRange {
  const range = object(value);
  const start = object(range.start) as unknown as TextPosition;
  const end = object(range.end) as unknown as TextPosition;
  try {
    if (positionOffset(text, end) < positionOffset(text, start)) return fail();
  } catch {
    return fail();
  }
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}
export function navigationCandidates(
  value: unknown,
  kind: LspNavigationKind,
  uri: string,
): Candidate[] {
  let data: JsonValue;
  try {
    data = boundedJson(value, LSP_NAVIGATION_LIMITS.rawBytes);
  } catch {
    throw new EngineError(
      "LSP_NAVIGATION_LIMIT",
      "Navigation response exceeds the JSON byte or shape limit",
    );
  }
  if (data === null) return [];
  const values = Array.isArray(data)
    ? data
    : kind === "definition"
      ? [data]
      : fail();
  const result: Candidate[] = [];
  let nodes = 0;
  function visit(values: JsonValue[], depth: number): void {
    if (depth > LSP_NAVIGATION_LIMITS.depth)
      throw new EngineError(
        "LSP_NAVIGATION_LIMIT",
        "Symbol tree exceeds the depth limit",
      );
    for (const value of values) {
      if (++nodes > LSP_NAVIGATION_LIMITS.nodes)
        throw new EngineError(
          "LSP_NAVIGATION_LIMIT",
          "Navigation exceeds the location count limit",
        );
      const item = object(value);
      if (kind === "symbols") {
        if (
          typeof item.name !== "string" ||
          !item.name ||
          Buffer.from(item.name).toString("utf8") !== item.name ||
          Buffer.byteLength(item.name) > 256 ||
          /[\u0000-\u001f\u007f]/.test(item.name) ||
          !Number.isInteger(item.kind) ||
          Number(item.kind) < 1 ||
          Number(item.kind) > 26
        )
          return fail();
        const location =
          item.location === undefined
            ? { uri, range: item.selectionRange ?? item.range }
            : object(item.location);
        if (item.location === undefined && item.selectionRange !== undefined && item.range === undefined) return fail();
        if (typeof location.uri !== "string") return fail();
        result.push({
          uri: location.uri,
          range: location.range,
          ...(item.location === undefined && item.selectionRange !== undefined ? { enclosingRange: item.range } : {}),
          name: item.name,
          symbolKind: item.kind as number,
          depth,
        });
        if (item.children !== undefined) {
          if (!Array.isArray(item.children)) return fail();
          visit(item.children, depth + 1);
        }
      } else {
        if (item.targetUri !== undefined && kind !== "definition") return fail();
        if (item.targetUri !== undefined && (item.targetRange === undefined || item.targetSelectionRange === undefined)) return fail();
        const targetUri = item.targetUri ?? item.uri;
        if (
          typeof targetUri !== "string" ||
          Buffer.byteLength(targetUri) > 4096
        )
          return fail();
        result.push({
          uri: targetUri,
          range: item.targetSelectionRange ?? item.range,
          ...(item.targetUri !== undefined ? { enclosingRange: item.targetRange } : {}),
          ...(item.originSelectionRange !== undefined ? { originRange: item.originSelectionRange } : {}),
        });
      }
    }
  }
  visit(values, 0);
  return result;
}
function scopedPath(workspace: Workspace, uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || url.host || url.search || url.hash)
      return null;
    const path = relative(workspace.root, fileURLToPath(url));
    if (isAbsolute(path) || path === ".." || path.startsWith(".." + sep))
      return null;
    return exactPath(path.split(sep).join("/"));
  } catch {
    return null;
  }
}
/** Cross-file locations carry fresh source hashes; server URIs never grant read authority outside the root. */
export async function projectNavigation(
  base: Omit<
    LspNavigationSnapshot,
    "items" | "sources" | "complete" | "omitted"
  >,
  workspace: Workspace,
  candidates: Candidate[],
  source: { content: string; hash: string },
  signal: AbortSignal,
): Promise<LspNavigationSnapshot> {
  const observed = new Map([[base.path, source]]);
  const result: LspNavigationSnapshot = {
    ...base,
    items: [],
    sources: [{ path: base.path, hash: source.hash }],
    complete: true,
    omitted: { outsideWorkspace: 0, unavailable: 0, ignored: 0, limits: 0 },
  };
  const paths = [
    ...new Set(
      candidates
        .map((candidate) => scopedPath(workspace, candidate.uri))
        .filter((path): path is string => path !== null),
    ),
  ];
  const ignored = workspace.gitRoot
    ? await ignoredWorkspacePaths(workspace, paths, signal)
    : new Set<string>();
  let fileBytes = Buffer.byteLength(source.content);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (signal.aborted)
      throw new EngineError("CANCELLED", "Navigation cancelled");
    const path = scopedPath(workspace, candidate.uri);
    if (path === null) {
      result.omitted.outsideWorkspace++;
      continue;
    }
    if (ignored.has(path) || excludedTraversalPath(path, false)) {
      result.omitted.ignored++;
      continue;
    }
    if (result.items.length >= LSP_NAVIGATION_LIMITS.items) {
      result.omitted.limits++;
      continue;
    }
    let file = observed.get(path);
    if (!file) {
      if (
        observed.size >= LSP_NAVIGATION_LIMITS.files ||
        fileBytes >= LSP_NAVIGATION_LIMITS.fileBytes
      ) {
        result.omitted.limits++;
        continue;
      }
      try {
        file = await readExactText(workspace, path, signal);
      } catch {
        if (signal.aborted)
          throw new EngineError("CANCELLED", "Navigation cancelled");
        result.omitted.unavailable++;
        continue;
      }
      fileBytes += Buffer.byteLength(file.content);
      if (fileBytes > LSP_NAVIGATION_LIMITS.fileBytes) {
        result.omitted.limits++;
        continue;
      }
      observed.set(path, file);
    }
    const selectedRange = navigationRange(file.content, candidate.range);
    if (candidate.enclosingRange !== undefined) {
      const enclosing = navigationRange(file.content, candidate.enclosingRange);
      if (positionOffset(file.content, selectedRange.start) < positionOffset(file.content, enclosing.start) || positionOffset(file.content, selectedRange.end) > positionOffset(file.content, enclosing.end)) return fail();
    }
    if (candidate.originRange !== undefined) navigationRange(source.content, candidate.originRange);
    const item: LspNavigationItem = {
      path,
      hash: file.hash,
      range: selectedRange,
      ...(candidate.name === undefined
        ? {}
        : {
            name: candidate.name,
            symbolKind: candidate.symbolKind,
            depth: candidate.depth,
          }),
    };
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const newSource = !result.sources.some((source) => source.path === path);
    if (newSource) result.sources.push({ path, hash: file.hash });
    result.items.push(item);
    if (
      Buffer.byteLength(JSON.stringify(result)) >
      LSP_NAVIGATION_LIMITS.resultBytes - 128
    ) {
      result.items.pop();
      if (newSource) result.sources.pop();
      result.omitted.limits++;
    }
  }
  // Revalidate the entire selected source set after the last asynchronous observation.
  for (const file of result.sources)
    if ((await readExactText(workspace, file.path, signal)).hash !== file.hash)
      throw new EngineError(
        "LSP_NAVIGATION_STALE",
        "A navigation source changed during the query",
      );
  result.complete = Object.values(result.omitted).every((value) => value === 0);
  return result;
}
