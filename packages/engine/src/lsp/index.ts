import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EngineError,
  type JsonObject,
  type JsonValue,
  type Workspace,
} from "@moodcode/contracts";
import { boundedJson } from "../artifacts/validation.js";
import { exactPath, readExactText } from "../tools/file-actions/text.js";
import {
  applyTextEdits,
  positionOffset,
  type TextRange,
} from "../formatters/edits.js";
import type { LspConnection } from "./stdio.js";
import {
  navigationCandidates,
  projectNavigation,
  type LspNavigationKind,
  type LspNavigationSnapshot,
} from "./navigation.js";
import type { TextPosition } from "../formatters/edits.js";
import type { LspProjectSourceSnapshot } from "./project-sources.js";
export * from "./navigation.js";
export * from "./typescript-native.js";
export {
  captureTypeScriptProjectSources,
  TYPESCRIPT_PROJECT_SOURCE_LIMITS,
} from "./project-sources.js";
export type { LspProjectSourceSnapshot } from "./project-sources.js";
export { StdioLspConnection } from "./stdio.js";
export type { LspConnection, StdioLspOptions } from "./stdio.js";
export interface LspDiagnostic {
  range: TextRange;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
}
export interface DiagnosticSnapshot {
  serverId: string;
  workspaceId: string;
  path: string;
  documentVersion: number;
  documentHash: string;
  diagnostics: LspDiagnostic[];
  versioned: boolean;
}
export interface FormatProposal {
  path: string;
  expectedHash: string;
  content: string;
  serverId: string;
  documentVersion: number;
}
export type LspFactory = ((
  workspace: Workspace,
  signal: AbortSignal,
) => Promise<LspConnection>) & {
  readonly projectSources?: (
    workspace: Workspace,
    signal: AbortSignal,
  ) => Promise<LspProjectSourceSnapshot>;
};
interface Document {
  path: string;
  uri: string;
  languageId: string;
  content: string;
  hash: string;
  version: number;
  diagnostics?: DiagnosticSnapshot;
}
interface Entry {
  serverId: string;
  workspace: Workspace;
  controller: AbortController;
  ready: Promise<void>;
  factorySettled?: Promise<void>;
  connection?: LspConnection;
  documents: Map<string, Document>;
  capabilities?: JsonObject;
  unsubscribe?: () => void;
  queue: Promise<void>;
  closed: boolean;
  projectSourceSha256?: string;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The producer may already have observed the same abort and rejected.
    promise.catch(() => {});
    return Promise.reject(
      new EngineError("CANCELLED", "LSP operation cancelled"),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new EngineError("CANCELLED", "LSP operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  code = "LSP_CLEANUP_UNCERTAIN",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new EngineError(
              code,
              "LSP operation did not settle before its deadline",
            ),
          ),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}
function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}
/** Host factories are explicit. Model paths cannot install, discover or launch an LSP server. */
export class LspManager {
  private factories = new Map<string, LspFactory>();
  private entries = new Map<string, Entry>();
  private closing = false;
  private navigationQueries = 0;
  private projectQueues = new Map<string, Promise<void>>();
  private pendingProjectSources = new Set<Promise<unknown>>();
  private projectSourceController = new AbortController();
  private requestTimeout: number;
  private startupTimeout: number;
  private cleanupTimeout: number;
  constructor(
    options: {
      requestTimeoutMs?: number;
      startupTimeoutMs?: number;
      cleanupTimeoutMs?: number;
    } = {},
  ) {
    this.requestTimeout = options.requestTimeoutMs ?? 5000;
    this.startupTimeout = options.startupTimeoutMs ?? 5000;
    this.cleanupTimeout = options.cleanupTimeoutMs ?? 1000;
    if (
      [this.requestTimeout, this.startupTimeout, this.cleanupTimeout].some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 60_000,
      )
    )
      throw new EngineError(
        "INVALID_LSP_CONFIG",
        "LSP deadlines must be positive bounded integers",
      );
  }
  private async notify(
    entry: Entry,
    method: string,
    params: JsonValue,
  ): Promise<void> {
    try {
      await bounded(
        entry.connection!.notify(method, params),
        this.requestTimeout,
        "LSP_TIMEOUT",
      );
    } catch (error) {
      entry.closed = true;
      entry.controller.abort();
      await bounded(entry.connection!.close(), this.cleanupTimeout).catch(
        () => {},
      );
      throw error;
    }
  }
  register(serverId: string, factory: LspFactory): void {
    if (
      this.closing ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(serverId) ||
      typeof factory !== "function" ||
      this.factories.has(serverId) ||
      this.factories.size >= 16
    )
      throw new EngineError(
        "INVALID_LSP_REGISTRATION",
        "LSP registration needs a unique bounded host server id",
      );
    this.factories.set(serverId, factory);
  }
  /** Pure source freshness read; this method never initializes an LSP server. */
  async projectSources(
    workspace: Workspace,
    serverId: string,
    signal: AbortSignal,
  ): Promise<LspProjectSourceSnapshot | null> {
    if (this.closing || signal.aborted)
      throw new EngineError("CANCELLED", "LSP source observation cancelled");
    const factory = this.factories.get(serverId);
    if (!factory)
      throw new EngineError(
        "LSP_SERVER_UNAVAILABLE",
        "LSP server is not explicitly registered",
      );
    if (!factory.projectSources) return null;
    const sourceSignal = AbortSignal.any([
      signal,
      this.projectSourceController.signal,
    ]);
    const capture = factory.projectSources;
    const pending = Promise.resolve().then(() =>
      capture(structuredClone(workspace), sourceSignal),
    );
    this.pendingProjectSources.add(pending);
    pending
      .finally(() => this.pendingProjectSources.delete(pending))
      .catch(() => {});
    const data = boundedJson(
      await abortable(pending, sourceSignal),
      1024,
    ) as unknown as LspProjectSourceSnapshot;
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "bytes,fileCount,schemaVersion,scope,sha256" ||
      data.schemaVersion !== 1 ||
      data.scope !== "workspace-typescript-files" ||
      !/^[a-f0-9]{64}$/.test(data.sha256) ||
      !Number.isSafeInteger(data.fileCount) ||
      data.fileCount < 0 ||
      data.fileCount > 4096 ||
      !Number.isSafeInteger(data.bytes) ||
      data.bytes < 0 ||
      data.bytes > 64 * 1024 * 1024
    )
      throw new EngineError(
        "INVALID_LSP_PROJECT_SOURCE",
        "Host project source metadata is invalid or exceeds its cap",
      );
    return Object.freeze(data);
  }
  private async synchronizeProject(
    workspace: Workspace,
    serverId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.factories.get(serverId)?.projectSources) return;
    const key = JSON.stringify([workspace.id, workspace.root, serverId]);
    const prior = this.projectQueues.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(async () => {
        const source = await this.projectSources(workspace, serverId, signal);
        if (!source || signal.aborted || this.closing)
          throw new EngineError(
            "CANCELLED",
            "LSP project synchronization cancelled",
          );
        const previous = this.entries.get(key);
        if (previous && previous.projectSourceSha256 !== source.sha256) {
          previous.closed = true;
          previous.controller.abort();
          previous.unsubscribe?.();
          await bounded(
            previous.ready.catch(() => {}),
            this.cleanupTimeout,
          );
          if (previous.factorySettled)
            await bounded(previous.factorySettled, this.cleanupTimeout);
          if (previous.connection)
            await bounded(previous.connection.close(), this.cleanupTimeout);
          previous.documents.clear();
          if (this.entries.get(key) === previous) this.entries.delete(key);
        }
        const current = await this.entry(workspace, serverId, signal);
        current.projectSourceSha256 = source.sha256;
      });
    this.projectQueues.set(key, operation);
    operation
      .finally(() => {
        if (this.projectQueues.get(key) === operation)
          this.projectQueues.delete(key);
      })
      .catch(() => {});
    await abortable(operation, signal);
  }
  private async entry(
    workspace: Workspace,
    serverId: string,
    signal: AbortSignal,
  ): Promise<Entry> {
    if (this.closing || signal.aborted)
      throw new EngineError("CANCELLED", "LSP host closed or caller cancelled");
    const factory = this.factories.get(serverId);
    if (!factory)
      throw new EngineError(
        "LSP_SERVER_UNAVAILABLE",
        "LSP server is not explicitly registered",
      );
    const key = JSON.stringify([workspace.id, workspace.root, serverId]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 32)
        throw new EngineError(
          "LSP_SERVER_LIMIT",
          "LSP workspace/server count exceeded",
        );
      entry = {
        serverId,
        workspace: structuredClone(workspace),
        controller: new AbortController(),
        ready: Promise.resolve(),
        documents: new Map(),
        queue: Promise.resolve(),
        closed: false,
      };
      this.entries.set(key, entry);
      const owned = entry;
      entry.ready = this.initialize(owned, factory).catch(async (error) => {
        owned.closed = true;
        owned.controller.abort();
        await owned.connection?.close();
        throw error instanceof EngineError
          ? error
          : new EngineError("LSP_START_FAILED", "LSP host factory failed");
      });
      entry.ready.catch(() => {});
    }
    await abortable(entry.ready, signal);
    if (entry.closed)
      throw new EngineError("LSP_DISCONNECTED", "LSP registration is closed");
    return entry;
  }
  private async initialize(entry: Entry, factory: LspFactory): Promise<void> {
    const root = await lstat(entry.workspace.root);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (await realpath(entry.workspace.root)) !== entry.workspace.root
    )
      throw new EngineError(
        "UNSAFE_LSP_WORKSPACE",
        "LSP root must be a canonical ordinary directory",
      );
    const pending = Promise.resolve().then(() =>
      factory(structuredClone(entry.workspace), entry.controller.signal),
    );
    entry.factorySettled = pending.then(async (connection) => {
      if (entry.closed || entry.controller.signal.aborted)
        await connection.close();
    });
    entry.factorySettled.catch(() => {});
    const connection = await bounded(
      pending,
      this.startupTimeout,
      "LSP_START_TIMEOUT",
    );
    entry.connection = connection;
    if (entry.closed || entry.controller.signal.aborted) {
      await connection.close();
      throw new EngineError("CANCELLED", "LSP startup cancelled");
    }
    entry.unsubscribe = connection.onNotification((method, params) => {
      if (method === "textDocument/publishDiagnostics")
        this.receiveDiagnostics(entry, params);
    });
    const uri = pathToFileURL(entry.workspace.root).href;
    const result = await bounded(
      abortable(
        connection.request(
          "initialize",
          {
            processId: process.pid,
            clientInfo: { name: "Moodcode" },
            rootUri: uri,
            workspaceFolders: [{ uri, name: entry.workspace.id }],
            capabilities: {
              general: { positionEncodings: ["utf-16"] },
              textDocument: {
                synchronization: { dynamicRegistration: false },
                publishDiagnostics: { versionSupport: true },
                formatting: { dynamicRegistration: false },
                documentSymbol: {
                  dynamicRegistration: false,
                  hierarchicalDocumentSymbolSupport: true,
                },
                definition: { dynamicRegistration: false, linkSupport: true },
                references: { dynamicRegistration: false },
              },
              workspace: { applyEdit: false },
            },
            trace: "off",
          },
          entry.controller.signal,
          this.requestTimeout,
        ),
        entry.controller.signal,
      ),
      this.requestTimeout,
      "LSP_TIMEOUT",
    );
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !result.capabilities ||
      typeof result.capabilities !== "object" ||
      Array.isArray(result.capabilities)
    )
      throw new EngineError(
        "INVALID_LSP_CAPABILITIES",
        "LSP initialize result needs server capabilities",
      );
    const caps = result.capabilities as JsonObject;
    if (
      caps.positionEncoding !== undefined &&
      caps.positionEncoding !== "utf-16"
    )
      throw new EngineError(
        "LSP_ENCODING_UNSUPPORTED",
        "This LSP port supports UTF-16 positions only",
      );
    entry.capabilities = caps;
    await this.notify(entry, "initialized", {});
  }
  private sync(entry: Entry): { kind: number; save: JsonValue | undefined } {
    const sync = entry.capabilities?.textDocumentSync;
    const kind =
      typeof sync === "number"
        ? sync
        : sync && typeof sync === "object" && !Array.isArray(sync)
          ? sync.change
          : undefined;
    const openClose =
      typeof sync === "number"
        ? sync !== 0
        : sync && typeof sync === "object" && !Array.isArray(sync)
          ? sync.openClose === true
          : false;
    if ((kind !== 1 && kind !== 2) || !openClose)
      throw new EngineError(
        "LSP_SYNC_UNSUPPORTED",
        "LSP server must support open/close and full or incremental document synchronization",
      );
    return {
      kind,
      save:
        typeof sync === "object" && sync && !Array.isArray(sync)
          ? sync.save
          : undefined,
    };
  }
  async updateFile(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    signal: AbortSignal,
  ): Promise<{ version: number; hash: string }> {
    path = exactPath(path);
    if (!/^[A-Za-z0-9+_.-]{1,64}$/.test(languageId))
      throw new EngineError(
        "INVALID_LSP_LANGUAGE",
        "LSP language id must be bounded",
      );
    const entry = await this.entry(workspace, serverId, signal);
    let result!: { version: number; hash: string };
    const operation = entry.queue.then(async () => {
      if (entry.closed || signal.aborted)
        throw new EngineError("CANCELLED", "LSP update unavailable");
      const sync = this.sync(entry);
      const observed = await readExactText(entry.workspace, path, signal);
      const prior = entry.documents.get(path);
      if (prior?.hash === observed.hash && prior.languageId === languageId) {
        result = { version: prior.version, hash: prior.hash };
        return;
      }
      if (prior && prior.languageId !== languageId)
        throw new EngineError(
          "LSP_DOCUMENT_LANGUAGE_CHANGED",
          "Close the document before changing its language",
        );
      if (
        Buffer.byteLength(observed.content) > 512 * 1024 ||
        (!prior && entry.documents.size >= 128) ||
        [...entry.documents.values()].reduce(
          (sum, doc) => sum + Buffer.byteLength(doc.content),
          0,
        ) -
          Buffer.byteLength(prior?.content ?? "") +
          Buffer.byteLength(observed.content) >
          8 * 1024 * 1024
      )
        throw new EngineError(
          "LSP_DOCUMENT_LIMIT",
          "LSP documents exceed count or byte budgets",
        );
      const doc: Document = {
        path,
        uri: pathToFileURL(join(entry.workspace.root, path)).href,
        languageId,
        content: observed.content,
        hash: observed.hash,
        version: (prior?.version ?? 0) + 1,
      };
      entry.documents.set(path, doc);
      try {
        if (!prior)
          await this.notify(entry, "textDocument/didOpen", {
            textDocument: {
              uri: doc.uri,
              languageId,
              version: doc.version,
              text: doc.content,
            },
          });
        else
          await this.notify(entry, "textDocument/didChange", {
            textDocument: { uri: doc.uri, version: doc.version },
            contentChanges: [
              sync.kind === 2
                ? {
                    range: {
                      start: { line: 0, character: 0 },
                      end: endPosition(prior.content),
                    },
                    text: doc.content,
                  }
                : { text: doc.content },
            ],
          });
        result = { version: doc.version, hash: doc.hash };
      } catch (error) {
        entry.closed = true;
        entry.controller.abort();
        await entry.connection!.close();
        throw error;
      }
    });
    entry.queue = operation.catch(() => {});
    await abortable(operation, signal);
    return result;
  }
  private receiveDiagnostics(entry: Entry, params: JsonValue): void {
    if (
      entry.closed ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof params.uri !== "string" ||
      !Array.isArray(params.diagnostics) ||
      params.diagnostics.length > 128
    )
      return;
    const doc = [...entry.documents.values()].find((d) => d.uri === params.uri);
    if (
      !doc ||
      (params.version !== undefined && params.version !== doc.version) ||
      (params.version === undefined && doc.version > 1)
    )
      return;
    try {
      const diagnostics = boundedJson(
        params.diagnostics,
        64 * 1024,
      ) as unknown as LspDiagnostic[];
      for (const item of diagnostics) {
        if (
          !item ||
          typeof item.message !== "string" ||
          Buffer.byteLength(item.message) > 4096 ||
          !item.range ||
          positionOffset(doc.content, item.range.end) <
            positionOffset(doc.content, item.range.start) ||
          (item.severity !== undefined && ![1, 2, 3, 4].includes(item.severity))
        )
          return;
      }
      const sanitized = diagnostics.map((d) => ({
        range: d.range,
        message: d.message,
        ...(d.severity === undefined ? {} : { severity: d.severity }),
        ...(typeof d.code === "string" || typeof d.code === "number"
          ? { code: d.code }
          : {}),
        ...(typeof d.source === "string"
          ? { source: d.source.slice(0, 128) }
          : {}),
      }));
      doc.diagnostics = {
        serverId: entry.serverId,
        workspaceId: entry.workspace.id,
        path: doc.path,
        documentVersion: doc.version,
        documentHash: doc.hash,
        diagnostics: sanitized,
        versioned: params.version !== undefined,
      };
    } catch {}
  }
  diagnostics(
    workspace: Workspace,
    serverId: string,
    path: string,
  ): DiagnosticSnapshot | null {
    const entry = this.entries.get(
      JSON.stringify([workspace.id, workspace.root, serverId]),
    );
    return entry &&
      !entry.closed &&
      entry.documents.get(exactPath(path))?.diagnostics
      ? structuredClone(entry.documents.get(path)!.diagnostics!)
      : null;
  }
  async formatting(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    signal: AbortSignal,
    options: { tabSize?: number; insertSpaces?: boolean } = {},
  ): Promise<FormatProposal> {
    if (
      !Number.isSafeInteger(options.tabSize ?? 2) ||
      (options.tabSize ?? 2) < 1 ||
      (options.tabSize ?? 2) > 16 ||
      (options.insertSpaces !== undefined &&
        typeof options.insertSpaces !== "boolean")
    )
      throw new EngineError(
        "INVALID_FORMAT_OPTIONS",
        "Formatting options must be bounded",
      );
    await this.synchronizeProject(workspace, serverId, signal);
    await this.updateFile(workspace, serverId, path, languageId, signal);
    const entry = await this.entry(workspace, serverId, signal);
    if (!entry.capabilities?.documentFormattingProvider)
      throw new EngineError(
        "LSP_FORMAT_UNSUPPORTED",
        "LSP server did not advertise document formatting",
      );
    const doc = entry.documents.get(path)!;
    const version = doc.version;
    const hash = doc.hash;
    const edits = await bounded(
      abortable(
        entry.connection!.request(
          "textDocument/formatting",
          {
            textDocument: { uri: doc.uri },
            options: {
              tabSize: options.tabSize ?? 2,
              insertSpaces: options.insertSpaces ?? true,
            },
          },
          signal,
          this.requestTimeout,
        ),
        signal,
      ),
      this.requestTimeout,
      "LSP_TIMEOUT",
    );
    const current = await readExactText(entry.workspace, path, signal);
    if (
      entry.closed ||
      entry.documents.get(path)?.version !== version ||
      current.hash !== hash
    )
      throw new EngineError(
        "FORMAT_PREIMAGE_STALE",
        "File or synchronized document changed during formatting",
      );
    return {
      path,
      expectedHash: hash,
      content: applyTextEdits(doc.content, edits),
      serverId,
      documentVersion: version,
    };
  }
  async queryNavigation(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    kind: LspNavigationKind,
    signal: AbortSignal,
    position?: TextPosition,
  ): Promise<LspNavigationSnapshot> {
    path = exactPath(path);
    if (
      !["symbols", "definition", "references"].includes(kind) ||
      (kind === "symbols" && position !== undefined) ||
      (kind !== "symbols" && !position)
    )
      throw new EngineError(
        "INVALID_LSP_NAVIGATION",
        "Navigation requires a known query and an exact UTF-16 position when applicable",
      );
    if (this.navigationQueries >= 16)
      throw new EngineError(
        "LSP_NAVIGATION_LIMIT",
        "Too many concurrent navigation queries",
      );
    this.navigationQueries++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(60_000, this.startupTimeout + this.requestTimeout),
    );
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    try {
      await this.synchronizeProject(workspace, serverId, operationSignal);
      await this.updateFile(
        workspace,
        serverId,
        path,
        languageId,
        operationSignal,
      );
      const entry = await this.entry(workspace, serverId, operationSignal);
      const capability =
        entry.capabilities?.[
          kind === "symbols"
            ? "documentSymbolProvider"
            : kind === "definition"
              ? "definitionProvider"
              : "referencesProvider"
        ];
      if (
        capability !== true &&
        !(
          capability &&
          typeof capability === "object" &&
          !Array.isArray(capability)
        )
      )
        throw new EngineError(
          "LSP_NAVIGATION_UNSUPPORTED",
          "The host server did not advertise this navigation capability",
        );
      const doc = entry.documents.get(path)!;
      const version = doc.version,
        hash = doc.hash;
      const source = { content: doc.content, hash };
      if (position) positionOffset(source.content, position);
      const activeSignal = AbortSignal.any([
        operationSignal,
        entry.controller.signal,
      ]);
      const raw = await bounded(
        abortable(
          entry.connection!.request(
            kind === "symbols"
              ? "textDocument/documentSymbol"
              : kind === "definition"
                ? "textDocument/definition"
                : "textDocument/references",
            {
              textDocument: { uri: doc.uri },
              ...(position
                ? {
                    position: {
                      line: position.line,
                      character: position.character,
                    },
                  }
                : {}),
              ...(kind === "references"
                ? { context: { includeDeclaration: true } }
                : {}),
            },
            activeSignal,
            this.requestTimeout,
          ),
          activeSignal,
        ),
        this.requestTimeout,
        "LSP_TIMEOUT",
      );
      const result = await projectNavigation(
        {
          serverId,
          workspaceId: workspace.id,
          path,
          documentVersion: version,
          documentHash: hash,
          kind,
        },
        entry.workspace,
        navigationCandidates(raw, kind, doc.uri),
        source,
        activeSignal,
      );
      if (
        entry.closed ||
        entry.documents.get(path)?.version !== version ||
        entry.documents.get(path)?.hash !== hash
      )
        throw new EngineError(
          "LSP_NAVIGATION_STALE",
          "The synchronized document changed during navigation",
        );
      return result;
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new EngineError(
          "LSP_TIMEOUT",
          "Navigation exceeded its complete observation deadline",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      this.navigationQueries--;
    }
  }
  querySymbols(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    signal: AbortSignal,
  ): Promise<LspNavigationSnapshot> {
    return this.queryNavigation(
      workspace,
      serverId,
      path,
      languageId,
      "symbols",
      signal,
    );
  }
  queryDefinitions(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    position: TextPosition,
    signal: AbortSignal,
  ): Promise<LspNavigationSnapshot> {
    return this.queryNavigation(
      workspace,
      serverId,
      path,
      languageId,
      "definition",
      signal,
      position,
    );
  }
  queryReferences(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    position: TextPosition,
    signal: AbortSignal,
  ): Promise<LspNavigationSnapshot> {
    return this.queryNavigation(
      workspace,
      serverId,
      path,
      languageId,
      "references",
      signal,
      position,
    );
  }
  async fileChanged(
    workspace: Workspace,
    serverId: string,
    path: string,
    languageId: string,
    change: "created" | "changed" | "deleted",
    signal: AbortSignal,
  ): Promise<void> {
    path = exactPath(path);
    const entry = await this.entry(workspace, serverId, signal);
    if (change === "deleted")
      await this.closeDocument(workspace, serverId, path, signal);
    else await this.updateFile(workspace, serverId, path, languageId, signal);
    await this.notify(entry, "workspace/didChangeWatchedFiles", {
      changes: [
        {
          uri: pathToFileURL(join(workspace.root, path)).href,
          type: change === "created" ? 1 : change === "changed" ? 2 : 3,
        },
      ],
    });
  }
  async closeDocument(
    workspace: Workspace,
    serverId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = await this.entry(workspace, serverId, signal);
    const operation = entry.queue.then(async () => {
      const doc = entry.documents.get(exactPath(path));
      if (!doc) return;
      await this.notify(entry, "textDocument/didClose", {
        textDocument: { uri: doc.uri },
      });
      entry.documents.delete(path);
    });
    entry.queue = operation.catch(() => {});
    await abortable(operation, signal);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.projectSourceController.abort();
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      entry.closed = true;
      entry.controller.abort();
      entry.unsubscribe?.();
    }
    const sourceDrain = Promise.allSettled(
      [...this.pendingProjectSources, ...this.projectQueues.values()].map(
        (pending) =>
          bounded(
            pending.catch(() => {}),
            this.cleanupTimeout,
          ),
      ),
    );
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        await bounded(
          entry.ready.catch(() => {}),
          this.cleanupTimeout,
        );
        if (entry.factorySettled)
          await bounded(
            entry.factorySettled.catch(() => {}),
            this.cleanupTimeout,
          );
        if (entry.connection) {
          const signal = new AbortController().signal;
          try {
            await entry.connection.request(
              "shutdown",
              null,
              signal,
              Math.min(250, this.requestTimeout),
            );
            await this.notify(entry, "exit", null);
          } catch {}
          await bounded(entry.connection.close(), this.cleanupTimeout);
        }
        entry.documents.clear();
      }),
    );
    const sourceResults = await sourceDrain;
    this.entries.clear();
    if (
      results.some((r) => r.status === "rejected") ||
      sourceResults.some((r) => r.status === "rejected")
    )
      throw new EngineError(
        "LSP_CLEANUP_UNCERTAIN",
        "One or more owned LSP factories or connections did not confirm teardown",
      );
  }
}
