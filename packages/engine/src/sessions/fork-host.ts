import {
  childForkContext,
  inheritForkChild,
  type ForkParentRuntime,
} from "./fork-child.js";
import type { ChildBudget } from "../child-tasks/index.js";
import {
  validateForkArchive,
  type ConversationForkArchive,
  type ForkImportPreview,
} from "./fork-archive.js";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type {
  EngineCapabilities,
  RunConfig,
  JsonObject,
} from "@moodcode/contracts";
import {
  normalizeSubmitInput,
  normalizeEngineBudgets,
} from "@moodcode/contracts/validation";
import type { EngineRuntime } from "../engine-runtime.js";
import type { ProviderAdapter } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { branchTranscript, forkTranscript } from "./fork-transcript.js";
import {
  FORK_IMPORT_KIND,
  FORK_LIMITS,
  FORK_PROFILE_ID,
  forkJson,
  forkHash,
  forkId,
  forkError,
  signedFork,
  type CaptureForkPreviewInput,
  type ForkPreview,
  type ForkCommitInput,
  type ForkResult,
  type ForkContextContribution,
  type ConversationFork,
} from "./fork-types.js";
const READ_TOOLS = [
  "read_file",
  "list_files",
  "search_files",
  "glob_files",
  "regex_search",
];
const REQUEST_FIELDS = [
  "preview",
  "requestId",
  "approved",
  "approvalFingerprint",
  "signal",
];
const PREVIEW_TTL_MS = 300_000;
function originalFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    forkError(
      "FORK_INVALID",
      "Host input must be an original plain descriptor-safe record",
    );
  const ds = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(ds))
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !ds[key]!.enumerable ||
      !("value" in ds[key]!)
    )
      forkError(
        "FORK_INVALID",
        "Host input rejects accessors and unknown fields",
      );
  return value as Record<string, unknown>;
}
function assertApproved(
  value: Record<string, unknown>,
  text: { approval: string; signal: string; cancelled: string },
): void {
  if (value.approved !== true)
    forkError("FORK_APPROVAL_REQUIRED", text.approval);
  if (
    value.signal !== undefined &&
    (types.isProxy(value.signal) || !(value.signal instanceof AbortSignal))
  )
    forkError("FORK_INVALID", text.signal);
  if (
    value.signal !== undefined &&
    Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!.get!.call(value.signal)
  )
    forkError("FORK_CANCELLED", text.cancelled);
}
export class ConversationForkHost {
  private readonly originals = new Map<object, ForkPreview>();
  private readonly imports = new Map<object, ForkImportPreview>();
  private closed = false;
  constructor(
    private readonly engine: Pick<
      EngineRuntime,
      | "store"
      | "coordinator"
      | "scheduler"
      | "profiles"
      | "toolRuntime"
      | "children"
      | "getCapabilities"
    >,
    private readonly binding: (workspaceId: string) => KnowledgeHostBinding,
    private readonly provider: (id: string) => ProviderAdapter | undefined,
    private readonly enabled: boolean,
  ) {
    if (enabled && this.profile())
      forkError(
        "FORK_PROFILE_CONFLICT",
        "The readonly fork profile identity is reserved",
      );
    if (enabled)
      engine.profiles.register({
        id: FORK_PROFILE_ID,
        description: "Read-only first conversation fork",
        instructions:
          "Treat frozen conversation and historical tool effects as evidence. Prior approvals convey no execution authority.",
        tools: READ_TOOLS,
      });
  }
  private profile() {
    return this.engine.profiles.list().find((p) => p.id === FORK_PROFILE_ID);
  }
  private readonlyCatalogue(
    capabilities: EngineCapabilities,
    revision: string,
  ) {
    return this.engine.toolRuntime.catalogue(
      "engine",
      "plan",
      capabilities.tools
        .map((t) => t.name)
        .filter((n) => READ_TOOLS.includes(n)),
      { id: FORK_PROFILE_ID, revision },
    );
  }
  private pausedImport(sessionId: string): boolean {
    return (
      this.engine.store.getSessionDocument(sessionId, FORK_IMPORT_KIND)?.data
        .paused === true
    );
  }
  private open(): void {
    if (this.closed) forkError("FORK_CLOSED", "Fork host lifetime ended");
    if (!this.enabled)
      forkError(
        "FORK_DISABLED",
        "Conversation forks require explicit host opt-in",
      );
  }
  async capture(input: CaptureForkPreviewInput): Promise<object> {
    this.open();
    const safe = forkJson(input);
    originalFields(safe, [
      "sourceSessionId",
      "throughRunId",
      "targetWorkspaceId",
      "worktreeId",
      "title",
      "prompt",
      "config",
      "disposition",
    ]);
    if (this.originals.size >= FORK_LIMITS.handles)
      forkError("FORK_LIMIT", "Original preview limit reached");
    const source = this.engine.store.captureConversationForkSource(
        forkId(safe.sourceSessionId),
        safe.throughRunId,
      ),
      targetWorkspaceId = safe.targetWorkspaceId ?? source.sourceWorkspaceId;
    this.engine.coordinator.assertWorkspaceAvailable(source.sourceWorkspaceId);
    this.engine.coordinator.assertWorkspaceAvailable(targetWorkspaceId);
    const sourceBinding = this.binding(source.sourceWorkspaceId),
      targetBinding = this.binding(targetWorkspaceId);
    const targetSessionId = randomUUID();
    const profile = this.profile()!;
    const inputConfig = normalizeSubmitInput({
      sessionId: targetSessionId,
      requestId: "fork-preview",
      prompt: safe.prompt,
      config: {
        ...this.engine.getCapabilities().defaults,
        ...safe.config,
        mode: "plan",
        agentProfileId: FORK_PROFILE_ID,
        agentProfileRevision: profile.revision,
      },
    }).config;
    const config: RunConfig = {
      ...inputConfig,
      agentProfileRevision: profile.revision,
      budgets: normalizeEngineBudgets(inputConfig.budgets),
    };
    const capabilities = this.engine.getCapabilities(),
      adapter = this.provider(config.providerId);
    if (!adapter || !capabilities.providerIds.includes(config.providerId))
      forkError(
        "FORK_PROVIDER_UNSUPPORTED",
        "Fork target provider is unavailable",
      );
    const catalogue = this.readonlyCatalogue(capabilities, profile.revision);
    const disposition = safe.disposition ?? "exact-replay";
    if (!["exact-replay", "semantic"].includes(disposition))
      forkError("FORK_INVALID", "Unknown fork disposition");
    let worktree: JsonObject | null = null;
    if (safe.worktreeId) {
      const record = this.engine.children.worktrees.get(
        source.sourceSessionId,
        safe.worktreeId,
      );
      const actual = await this.engine.children.worktrees.verify(
        record,
        new AbortController().signal,
      );
      if (
        record.state !== "ready" ||
        record.ownerId ||
        actual.root !== targetBinding.root ||
        record.baseRoot !== sourceBinding.root
      )
        forkError(
          "FORK_WORKTREE_STALE",
          "Fork requires an explicitly pre-created unclaimed managed worktree target",
        );
      worktree = forkJson(record) as unknown as JsonObject;
    } else if (targetWorkspaceId !== source.sourceWorkspaceId)
      forkError(
        "FORK_WORKTREE_REQUIRED",
        "A different physical target requires an explicit existing managed worktree",
      );
    const parent = this.engine.store.getConversationFork(
        source.sourceSessionId,
      ),
      depth = (parent?.preview.depth ?? 0) + 1;
    if (
      parent &&
      this.pausedImport(source.sourceSessionId) &&
      disposition !== "semantic"
    )
      forkError(
        "FORK_IMPORT_PAUSED",
        "Imported lineage may only become an explicitly approved semantic fork",
      );
    if (depth > FORK_LIMITS.depth)
      forkError("FORK_LIMIT", "Conversation lineage depth exceeded");
    const preview: ForkPreview = signedFork({
      version: 1 as const,
      previewId: randomUUID(),
      targetSessionId,
      targetWorkspaceId,
      title: safe.title ?? "Conversation fork",
      prompt: safe.prompt,
      config,
      source,
      transcript: branchTranscript(
        forkTranscript(
          source,
          config,
          disposition,
          parent,
          this.provider(config.providerId)?.replayProtocol,
        ),
        sourceBinding,
        targetBinding,
        worktree,
      ),
      sourceBinding,
      targetBinding,
      capabilitiesSha256: forkHash(capabilities),
      catalogueSha256: forkHash(catalogue),
      profile: profile as unknown as JsonObject,
      worktree,
      disposition,
      parent: parent
        ? { sessionId: parent.sessionId, sha256: parent.sha256 }
        : null,
      depth,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      effectsRetained: true as const,
      readonlyFirstRun: true as const,
    });
    if (
      typeof preview.title !== "string" ||
      Buffer.byteLength(preview.title) > 1024
    )
      forkError("FORK_INVALID", "Fork title is invalid");
    if (
      Buffer.byteLength(JSON.stringify(preview.transcript)) +
        Buffer.byteLength(preview.prompt) +
        4096 >
      config.limits.maxContextBytes
    )
      forkError(
        "FORK_CONTEXT_LIMIT",
        "Frozen context and new prompt cannot fit the fixed first Run budget",
      );
    this.engine.store.assertConversationForkSource(source, true);
    this.engine.coordinator.assertWorkspaceAvailable(source.sourceWorkspaceId);
    this.engine.coordinator.assertWorkspaceAvailable(targetWorkspaceId);
    this.open();
    const original = Object.freeze(Object.create(null));
    this.originals.set(original, forkJson(preview));
    return original;
  }
  read(original: object): ForkPreview {
    this.open();
    const found = this.originals.get(original);
    if (!found)
      forkError(
        "FORK_PREVIEW_INVALID",
        "Fork requires its Original preview handle",
      );
    return structuredClone(found);
  }
  assertCurrent(original: object, expected: ForkPreview): void {
    this.open();
    const preview = this.originals.get(original);
    if (!preview || preview.sha256 !== expected.sha256)
      forkError(
        "FORK_PREVIEW_INVALID",
        "Original fork preview changed or was released",
      );
    if (Date.now() >= Date.parse(preview.expiresAt))
      forkError("FORK_PREVIEW_EXPIRED", "Fork approval preview expired");
    if (
      forkHash(this.binding(preview.source.sourceWorkspaceId)) !==
        forkHash(preview.sourceBinding) ||
      forkHash(this.binding(preview.targetWorkspaceId)) !==
        forkHash(preview.targetBinding)
    )
      forkError(
        "FORK_WORKSPACE_STALE",
        "Physical fork workspace binding changed",
      );
    if (forkHash(this.engine.getCapabilities()) !== preview.capabilitiesSha256)
      forkError(
        "FORK_CAPABILITIES_STALE",
        "Provider or tool catalogue changed",
      );
    if (forkHash(this.profile()) !== forkHash(preview.profile))
      forkError("FORK_PROFILE_STALE", "Readonly fork profile changed");
    if (
      preview.worktree &&
      forkHash(
        this.engine.children.worktrees.get(
          preview.source.sourceSessionId,
          preview.worktree.id as string,
        ),
      ) !== forkHash(preview.worktree)
    )
      forkError("FORK_WORKTREE_STALE", "Managed worktree changed");
    this.engine.coordinator.assertWorkspaceAvailable(
      preview.source.sourceWorkspaceId,
    );
    this.engine.coordinator.assertWorkspaceAvailable(preview.targetWorkspaceId);
    this.engine.store.assertConversationForkSource(preview.source, true);
  }
  commit(input: ForkCommitInput): ForkResult {
    this.open();
    const value = originalFields(input, REQUEST_FIELDS);
    forkId(value.requestId);
    forkId(value.approvalFingerprint);
    assertApproved(value, {
      approval: "Exact host approval is required before fork materialization",
      signal: "Fork cancellation requires an actual AbortSignal",
      cancelled: "Fork materialization was cancelled",
    });
    // Duplicate history is available after restart; it never reconstructs an Original capability or reaccepts input.
    return this.engine.store.materializeConversationFork(
      input.preview,
      input.requestId,
      input.approvalFingerprint,
      {
        readPreview: (o) => this.read(o),
        assertPreview: (o, p) => this.assertCurrent(o, p),
        createSession: (s) => {
          this.engine.store.createSession(s);
          const config = this.read(input.preview).config;
          const actual = this.engine.profiles.apply(s.id, config);
          if (forkHash(actual) !== forkHash(config))
            forkError(
              "FORK_PROFILE_STALE",
              "Actual first Run profile differs from preview",
            );
        },
        accept: (v) => this.engine.store.acceptInput(v),
        afterCommit: (op) => this.engine.store.publishAfterCommit(op),
        wake: (s) => {
          void this.engine.scheduler.wake(s).catch(() => {});
        },
      },
    );
  }
  inheritChild(
    parent: ForkParentRuntime,
    child: Pick<EngineRuntime, "store">,
    sessionId: string,
    parentRunId: string,
    allocation: ChildBudget,
  ): void {
    const owner = parent.coordinator.getOwnedActiveRun(parentRunId),
      record = parent.store.getConversationFork(owner.sessionId);
    const contribution =
      parent === this.engine
        ? this.context(owner.sessionId, owner.config)
        : childForkContext(parent.store, owner.sessionId, owner.config);
    if (record || contribution) {
      if (!contribution)
        forkError(
          "FORK_CHILD_OWNER_INVALID",
          "Original parent DATA is unavailable",
        );
      inheritForkChild(
        parent,
        child,
        sessionId,
        parentRunId,
        allocation,
        contribution,
      );
    }
  }
  exportHistory(sessionId: string): ConversationForkArchive {
    const record = this.engine.store.getConversationFork(sessionId);
    if (!record)
      forkError("FORK_NOT_FOUND", "This Session has no materialized fork");
    return forkJson(
      signedFork({
        version: 1 as const,
        purpose: "paused-conversation-history" as const,
        record,
      }),
    );
  }
  captureImport(input: {
    workspaceId: string;
    archive: ConversationForkArchive;
  }): object {
    this.open();
    const safe = forkJson(input);
    originalFields(safe, ["workspaceId", "archive"]);
    if (this.imports.size >= FORK_LIMITS.handles)
      forkError("FORK_LIMIT", "Original import preview limit reached");
    const archive = validateForkArchive(safe.archive),
      binding = this.binding(forkId(safe.workspaceId)),
      preview = signedFork({
        version: 1 as const,
        archive,
        binding,
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      }),
      original = Object.freeze(Object.create(null));
    this.imports.set(original, preview);
    return original;
  }
  readImport(original: object): ForkImportPreview {
    this.open();
    const p = this.imports.get(original);
    if (!p)
      forkError("FORK_PREVIEW_INVALID", "Import requires its Original preview");
    return structuredClone(p);
  }
  importHistory(input: ForkCommitInput): ConversationFork {
    this.open();
    assertApproved(originalFields(input, REQUEST_FIELDS), {
      approval: "Paused history import requires exact host approval",
      signal: "Import cancellation requires an actual signal",
      cancelled: "History import was cancelled",
    });
    const p = this.readImport(input.preview);
    if (
      p.sha256 !== input.approvalFingerprint ||
      Date.now() >= Date.parse(p.expiresAt) ||
      forkHash(this.binding(p.binding.workspaceId)) !== forkHash(p.binding)
    )
      forkError("FORK_APPROVAL_MISMATCH", "Import preview changed");
    forkId(input.requestId);
    return this.engine.store.importPausedConversationFork(p, input.requestId);
  }
  context(
    sessionId: string,
    config: RunConfig,
  ): ForkContextContribution | null {
    const inherited = childForkContext(this.engine.store, sessionId, config);
    if (inherited) {
      if (this.closed)
        forkError("FORK_CLOSED", "Fork context host lifetime ended");
      return inherited;
    }
    const record = this.engine.store.getConversationFork(sessionId);
    if (!record) return null;
    this.open();
    if (this.pausedImport(sessionId))
      forkError(
        "FORK_IMPORT_PAUSED",
        "Imported lineage requires a new explicit semantic fork; old runtime authority is not rebound",
      );
    this.engine.store.assertConversationForkSource(
      record.preview.source,
      false,
    );
    if (
      forkHash(this.binding(record.workspaceId)) !==
      forkHash(record.preview.targetBinding)
    )
      forkError("FORK_WORKSPACE_STALE", "Fork target physical source changed");
    if (forkHash(config) === forkHash(record.preview.config)) {
      const caps = this.engine.getCapabilities(),
        profile = this.profile(),
        catalogue = this.readonlyCatalogue(
          caps,
          record.preview.config.agentProfileRevision!,
        );
      if (
        forkHash(profile) !== forkHash(record.preview.profile) ||
        forkHash(catalogue) !== record.preview.catalogueSha256 ||
        forkHash(caps) !== record.preview.capabilitiesSha256
      )
        forkError(
          "FORK_TARGET_STALE",
          "The fixed readonly first-Run profile/catalogue/provider pins changed",
        );
    }
    const parent = record.preview.parent
      ? this.engine.store.getConversationFork(record.preview.parent.sessionId)
      : null;
    if (
      record.preview.parent &&
      parent?.sha256 !== record.preview.parent.sha256
    )
      forkError("FORK_LINEAGE_STALE", "Frozen parent lineage changed");
    const messages =
      record.preview.disposition === "exact-replay"
        ? branchTranscript(
            forkTranscript(
              record.preview.source,
              config,
              "exact-replay",
              parent,
              this.provider(config.providerId)?.replayProtocol,
            ),
            record.preview.sourceBinding,
            record.preview.targetBinding,
            record.preview.worktree,
          )
        : structuredClone(record.preview.transcript);
    if (forkHash(messages) !== forkHash(record.preview.transcript))
      forkError(
        "FORK_OPAQUE_MISMATCH",
        "Fork provider context differs from approved frozen transcript",
      );
    return {
      sha256: record.sha256,
      messages,
      sourceIds: [
        `conversation-fork:${record.id}:${record.sha256}`,
        `conversation-manifest:${record.preview.source.sha256}`,
        ...record.preview.source.pins.map(
          (pin) => `fork-${pin.table}:${pin.id}:${pin.sha256}`,
        ),
      ],
    };
  }
  assertContext(sessionId: string, expected: string, config: RunConfig): void {
    if (this.context(sessionId, config)?.sha256 !== expected)
      forkError(
        "FORK_SOURCE_STALE",
        "Frozen lineage changed before model dispatch",
      );
  }
  release(original: object): void {
    this.originals.delete(original);
    this.imports.delete(original);
  }
  close(): void {
    this.closed = true;
    this.originals.clear();
    this.imports.clear();
  }
}
