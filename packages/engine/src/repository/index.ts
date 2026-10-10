import { createHash } from "node:crypto";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import { boundedJson } from "../artifacts/validation.js";
import type { TextPosition } from "../formatters/edits.js";
import type {
  LspManager,
  LspNavigationKind,
  LspNavigationSnapshot,
  LspProjectSourceSnapshot,
} from "../lsp/index.js";
import { exactPath, readExactText } from "../tools/file-actions/text.js";
import { excludedWorkspacePaths } from "../workspace/ignore.js";
import { runGit, readBranch } from "../workspace/git.js";

export const REPOSITORY_CONTEXT_LIMITS = Object.freeze({
  paths: 8,
  resultBytes: 16_384,
  sourceBytes: 4_194_304,
  snapshots: 128,
  concurrent: 8,
  timeoutMs: 15_000,
});
export interface RepositoryQuery {
  kind: LspNavigationKind;
  paths: string[];
  position?: TextPosition;
}
export interface RepositoryLanguageBinding {
  serverId: string;
  languageId: string;
  revision: string;
}
export interface RepositorySourceManifest {
  workspaceId: string;
  root: string;
  gitHead: string | null;
  branch: string | null;
  effectiveIgnoreDigest: string;
  files: { path: string; hash: string }[];
  bindings: {
    path: string;
    serverId: string;
    languageId: string;
    revision: string;
  }[];
  /** Native semantic dependencies, observed without dispatching a language-server query. */
  projectSources?: ({ serverId: string } & LspProjectSourceSnapshot)[];
}
export interface RepositorySnapshot {
  schemaVersion: 1;
  generation: string;
  manifest: RepositorySourceManifest;
  query: RepositoryQuery;
  observations: LspNavigationSnapshot[];
  unsupportedPaths: string[];
  omittedObservations: number;
  complete: boolean;
  authority: "read-only";
  evidence: "observed-file-snapshot";
  selectionReason: "explicit-query-paths-and-lsp-relations";
}
export interface RepositoryIndexPort {
  query(
    workspace: Workspace,
    query: RepositoryQuery,
    signal: AbortSignal,
    expectedPreview?: string,
  ): Promise<RepositorySnapshot>;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function repositoryQuery(value: unknown): RepositoryQuery {
  let input: JsonObject;
  try {
    input = boundedJson(value, 8192) as JsonObject;
  } catch {
    throw new EngineError(
      "INVALID_REPOSITORY_QUERY",
      "Repository query must be a bounded JSON object",
    );
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["kind", "paths", "position"].includes(key),
    ) ||
    !["symbols", "definition", "references"].includes(input.kind as string) ||
    !Array.isArray(input.paths) ||
    !input.paths.length ||
    input.paths.length > REPOSITORY_CONTEXT_LIMITS.paths
  )
    throw new EngineError(
      "INVALID_REPOSITORY_QUERY",
      "Choose a known query and up to eight exact paths",
    );
  const paths = input.paths.map(exactPath);
  if (new Set(paths).size !== paths.length)
    throw new EngineError(
      "INVALID_REPOSITORY_QUERY",
      "Repository paths must be unique",
    );
  const kind = input.kind as LspNavigationKind;
  let position: TextPosition | undefined;
  if (kind === "symbols") {
    if (input.position !== undefined)
      throw new EngineError(
        "INVALID_REPOSITORY_QUERY",
        "Symbols query does not take a position",
      );
  } else {
    const p = input.position;
    if (
      paths.length !== 1 ||
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).sort().join(",") !== "character,line" ||
      !Number.isSafeInteger(p.line) ||
      Number(p.line) < 0 ||
      Number(p.line) > 1_000_000 ||
      !Number.isSafeInteger(p.character) ||
      Number(p.character) < 0 ||
      Number(p.character) > 1_000_000
    )
      throw new EngineError(
        "INVALID_REPOSITORY_QUERY",
        "Definition/references query needs one path and a bounded UTF-16 position",
      );
    position = { line: p.line as number, character: p.character as number };
  }
  return { kind, paths, ...(position ? { position } : {}) };
}
async function gitIdentity(
  workspace: Workspace,
  signal: AbortSignal,
): Promise<{ gitHead: string | null; branch: string | null }> {
  if (!workspace.gitRoot) return { gitHead: null, branch: null };
  // One quiet probe distinguishes a commit (0) from an unborn repository (1); every other
  // Git failure still fails rather than becoming a fabricated null HEAD.
  const result = await runGit(
    workspace.root,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { signal },
  );
  if (result.code !== 0 && result.code !== 1)
    throw new EngineError(
      "REPOSITORY_GIT_UNAVAILABLE",
      "Repository HEAD could not be observed",
    );
  const gitHead = result.code === 0 ? result.stdout.toString("utf8").trim() : null;
  if (gitHead !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(gitHead))
    throw new EngineError(
      "REPOSITORY_GIT_UNAVAILABLE",
      "Invalid Git HEAD identity",
    );
  return { gitHead, branch: await readBranch(workspace.root, { signal }) };
}
/** Discardable, content-addressed observations. Cache entries never bypass a fresh source/ignore/host-binding check. */
export class RepositoryContextService implements RepositoryIndexPort {
  private snapshots = new Map<string, RepositorySnapshot>();
  private active = 0;
  constructor(
    private readonly lsp: LspManager,
    private readonly select: (path: string) => RepositoryLanguageBinding | null,
  ) {}
  async preview(
    workspace: Workspace,
    input: RepositoryQuery,
    signal: AbortSignal,
  ): Promise<{
    fingerprint: string;
    manifest: RepositorySourceManifest;
    query: RepositoryQuery;
  }> {
    const query = repositoryQuery(input);
    const excluded = await excludedWorkspacePaths(
      workspace,
      query.paths,
      signal,
    );
    if (excluded.size)
      throw new EngineError(
        "REPOSITORY_PATH_IGNORED",
        "Requested repository sources are excluded by traversal or Git ignore rules",
      );
    const manifest: RepositorySourceManifest = {
      workspaceId: workspace.id,
      root: workspace.root,
      ...(await gitIdentity(workspace, signal)),
      effectiveIgnoreDigest: hash(
        query.paths.map((path) => ({ path, ignored: excluded.has(path) })),
      ),
      files: [],
      bindings: [],
    };
    let bytes = 0;
    for (const path of query.paths) {
      const file = await readExactText(workspace, path, signal);
      bytes += Buffer.byteLength(file.content);
      if (bytes > REPOSITORY_CONTEXT_LIMITS.sourceBytes)
        throw new EngineError(
          "REPOSITORY_SOURCE_LIMIT",
          "Repository sources exceed the byte budget",
        );
      manifest.files.push({ path, hash: file.hash });
      const binding = this.select(path);
      if (binding) {
        if (
          !/^[A-Za-z0-9_.-]{1,64}$/.test(binding.serverId) ||
          !/^[A-Za-z0-9+_.-]{1,64}$/.test(binding.languageId) ||
          !/^[A-Za-z0-9_.-]{1,64}$/.test(binding.revision)
        )
          throw new EngineError(
            "INVALID_REPOSITORY_BINDING",
            "Host language routing needs bounded server, language and revision identities",
          );
        manifest.bindings.push({ path, ...binding });
      }
    }
    for (const serverId of [
      ...new Set(manifest.bindings.map((item) => item.serverId)),
    ].sort()) {
      const source = await this.lsp.projectSources(workspace, serverId, signal);
      if (source)
        (manifest.projectSources ??= []).push({ serverId, ...source });
    }
    return { fingerprint: hash({ manifest, query }), manifest, query };
  }
  async query(
    workspace: Workspace,
    input: RepositoryQuery,
    signal: AbortSignal,
    expectedPreview?: string,
  ): Promise<RepositorySnapshot> {
    if (this.active >= REPOSITORY_CONTEXT_LIMITS.concurrent)
      throw new EngineError(
        "REPOSITORY_QUERY_LIMIT",
        "Too many concurrent repository observations",
      );
    this.active++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REPOSITORY_CONTEXT_LIMITS.timeoutMs);
    const activeSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const before = await this.preview(workspace, input, activeSignal);
      if (
        expectedPreview !== undefined &&
        expectedPreview !== before.fingerprint
      )
        throw new EngineError(
          "REPOSITORY_SOURCE_STALE",
          "Prepared repository sources or host bindings changed",
        );
      const key = hash({
        workspaceId: workspace.id,
        root: workspace.root,
        query: before.query,
      });
      const priorGeneration = this.snapshots.get(key)?.generation;
      const result: RepositorySnapshot = {
        schemaVersion: 1,
        generation: "",
        manifest: before.manifest,
        query: before.query,
        observations: [],
        unsupportedPaths: [],
        omittedObservations: 0,
        complete: true,
        authority: "read-only",
        evidence: "observed-file-snapshot",
        selectionReason: "explicit-query-paths-and-lsp-relations",
      };
      for (const path of before.query.paths) {
        const binding = before.manifest.bindings.find(
          (item) => item.path === path,
        );
        if (!binding) {
          result.unsupportedPaths.push(path);
          result.complete = false;
          continue;
        }
        let observation: LspNavigationSnapshot;
        try {
          observation = await this.lsp.queryNavigation(
            workspace,
            binding.serverId,
            path,
            binding.languageId,
            before.query.kind,
            activeSignal,
            before.query.position,
          );
        } catch (error) {
          if (
            error instanceof EngineError &&
            error.code === "LSP_NAVIGATION_UNSUPPORTED"
          ) {
            result.unsupportedPaths.push(path);
            result.complete = false;
            continue;
          }
          throw error;
        }
        if (
          observation.documentHash !==
          before.manifest.files.find((item) => item.path === path)!.hash
        )
          throw new EngineError(
            "REPOSITORY_SOURCE_STALE",
            "Synchronized source changed after preview",
          );
        const candidates = observation.sources.map((item) => item.path);
        const excluded = await excludedWorkspacePaths(
          workspace,
          candidates,
          activeSignal,
        );
        if (excluded.size) {
          observation.omitted.unavailable += observation.items.filter((item) =>
            excluded.has(item.path),
          ).length;
          observation.items = observation.items.filter(
            (item) => !excluded.has(item.path),
          );
          observation.sources = observation.sources.filter(
            (item) => !excluded.has(item.path),
          );
          observation.complete = false;
        }
        result.observations.push(observation);
        if (
          Buffer.byteLength(JSON.stringify(result)) >
          REPOSITORY_CONTEXT_LIMITS.resultBytes - 512
        ) {
          result.observations.pop();
          result.omittedObservations++;
          result.complete = false;
        } else if (!observation.complete) result.complete = false;
      }
      const after = await this.preview(workspace, input, activeSignal);
      if (after.fingerprint !== before.fingerprint)
        throw new EngineError(
          "REPOSITORY_SOURCE_STALE",
          "Files, Git identity, ignore results or language routing changed during observation",
        );
      const selected = result.observations.flatMap(
        (observation) => observation.sources,
      );
      const excluded = await excludedWorkspacePaths(
        workspace,
        [...new Set(selected.map((source) => source.path))],
        activeSignal,
      );
      for (const source of selected)
        if (
          excluded.has(source.path) ||
          (await readExactText(workspace, source.path, activeSignal)).hash !==
            source.hash
        )
          throw new EngineError(
            "REPOSITORY_SOURCE_STALE",
            "A selected target or its effective ignore result changed",
          );
      result.generation = hash(result);
      if (
        Buffer.byteLength(JSON.stringify(result)) >
        REPOSITORY_CONTEXT_LIMITS.resultBytes
      )
        throw new EngineError(
          "REPOSITORY_RESULT_LIMIT",
          "Repository source metadata exceeds the result byte budget",
        );
      if (
        this.snapshots.get(key)?.generation !== priorGeneration &&
        this.snapshots.get(key)?.generation !== result.generation
      )
        throw new EngineError(
          "REPOSITORY_INDEX_CONFLICT",
          "A different observation was published concurrently; request a fresh query",
        );
      this.snapshots.delete(key);
      this.snapshots.set(key, structuredClone(result));
      if (this.snapshots.size > REPOSITORY_CONTEXT_LIMITS.snapshots)
        this.snapshots.delete(this.snapshots.keys().next().value!);
      return result;
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new EngineError(
          "REPOSITORY_TIMEOUT",
          "Repository observation exceeded its complete deadline",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      this.active--;
    }
  }
}
