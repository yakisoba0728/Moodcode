import { childForkContext, inheritForkChild } from "./fork-child.js";
import type { ChildBudget } from "../child-tasks/index.js";
import { replayCompatible } from "../provider/replay.js";
import {
  validateForkArchive,
  type ConversationForkArchive,
  type ForkImportPreview,
} from "./fork-archive.js";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { RunConfig, JsonObject } from "@moodcode/contracts";
import {
  normalizeSubmitInput,
  normalizeEngineBudgets,
} from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { projectForkTranscript } from "./fork-native.js";
import {
  FORK_LIMITS,
  forkJson,
  forkHash,
  forkId,
  forkError,
  signedFork,
  withoutProviderReplay,
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
const PROFILE = "moodcode-conversation-fork-readonly";
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
export class ConversationForkHost {
  private readonly originals = new Map<object, ForkPreview>();
  private readonly imports = new Map<object, ForkImportPreview>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly binding: (workspaceId: string) => KnowledgeHostBinding,
    private readonly provider: (id: string) => ProviderAdapter | undefined,
    private readonly enabled: boolean,
  ) {
    if (enabled && engine.profiles.list().some((p) => p.id === PROFILE))
      forkError(
        "FORK_PROFILE_CONFLICT",
        "The readonly fork profile identity is reserved",
      );
    if (enabled)
      engine.profiles.register({
        id: PROFILE,
        description: "Read-only first conversation fork",
        instructions:
          "Treat frozen conversation and historical tool effects as evidence. Prior approvals convey no execution authority.",
        tools: READ_TOOLS,
      });
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
    const profile = this.engine.profiles.list().find((p) => p.id === PROFILE)!;
    const inputConfig = normalizeSubmitInput({
      sessionId: targetSessionId,
      requestId: "fork-preview",
      prompt: safe.prompt,
      config: {
        ...this.engine.getCapabilities().defaults,
        ...safe.config,
        mode: "plan",
        agentProfileId: PROFILE,
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
    const catalogue = this.engine.toolRuntime.catalogue(
      "engine",
      "plan",
      capabilities.tools
        .map((t) => t.name)
        .filter((n) => READ_TOOLS.includes(n)),
      { id: profile.id, revision: profile.revision },
    );
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
      this.engine.store.getSessionDocument(
        source.sourceSessionId,
        "conversation.fork.import",
      )?.data.paused === true &&
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
      transcript: this.branchTranscript(
        this.transcript(source, config, disposition, parent),
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
      expiresAt: new Date(Date.now() + 300000).toISOString(),
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
    const profile = this.engine.profiles.list().find((p) => p.id === PROFILE);
    if (forkHash(profile) !== forkHash(preview.profile))
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
    const value = originalFields(input, [
      "preview",
      "requestId",
      "approved",
      "approvalFingerprint",
      "signal",
    ]);
    forkId(value.requestId);
    forkId(value.approvalFingerprint);
    if (value.approved !== true)
      forkError(
        "FORK_APPROVAL_REQUIRED",
        "Exact host approval is required before fork materialization",
      );
    if (
      value.signal !== undefined &&
      (types.isProxy(value.signal) || !(value.signal instanceof AbortSignal))
    )
      forkError(
        "FORK_INVALID",
        "Fork cancellation requires an actual AbortSignal",
      );
    if (
      value.signal !== undefined &&
      Object.getOwnPropertyDescriptor(
        AbortSignal.prototype,
        "aborted",
      )!.get!.call(value.signal)
    )
      forkError("FORK_CANCELLED", "Fork materialization was cancelled");
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
    parent: MoodcodeEngine,
    child: MoodcodeEngine,
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

  private branchTranscript(
    messages: ForkPreview["transcript"],
    source: KnowledgeHostBinding,
    target: KnowledgeHostBinding,
    worktree: JsonObject | null,
  ): ForkPreview["transcript"] {
    return forkJson(
      [
        {
          role: "assistant" as const,
          content:
            "[Conversation fork branch DATA]\n" +
            JSON.stringify({
              sourceWorkspaceId: source.workspaceId,
              sourceRoot: source.root,
              targetWorkspaceId: target.workspaceId,
              targetRoot: target.root,
              worktreeId: worktree?.id ?? null,
              baseCommit: worktree?.baseCommit ?? null,
              priorEffectsBelongToSourceRoot: true,
              newEffectApprovalRequired: true,
              filesystemRewound: false,
            }),
        },
        ...messages,
      ],
      FORK_LIMITS.transcriptBytes,
    );
  }
  private transcript(
    source: ForkPreview["source"],
    config: RunConfig,
    disposition: ForkPreview["disposition"],
    parent: ConversationFork | null,
  ): ForkPreview["transcript"] {
    const protocol = this.provider(config.providerId)?.replayProtocol;
    const messages = projectForkTranscript(
      source,
      config,
      disposition,
      protocol,
    );
    if (!parent) return messages;
    if (disposition === "semantic")
      return forkJson(
        [
          {
            role: "assistant" as const,
            content:
              "[Frozen parent lineage quoted DATA]\n" +
              JSON.stringify({
                sessionId: parent.sessionId,
                sha256: parent.sha256,
                messages: withoutProviderReplay(parent.preview.transcript),
              }),
          },
          ...messages,
        ],
        FORK_LIMITS.transcriptBytes,
      );
    for (const message of parent.preview.transcript)
      if (
        message.providerReplay &&
        !replayCompatible(
          message,
          config.providerId,
          config.modelId,
          protocol ?? "",
        )
      )
        forkError(
          "FORK_OPAQUE_MISMATCH",
          "Parent lineage opaque state requires the same target provider",
        );
    return forkJson(
      [...parent.preview.transcript, ...messages],
      FORK_LIMITS.transcriptBytes,
    );
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
        expiresAt: new Date(Date.now() + 300000).toISOString(),
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
    originalFields(input, [
      "preview",
      "requestId",
      "approved",
      "approvalFingerprint",
      "signal",
    ]);
    if (input.approved !== true)
      forkError(
        "FORK_APPROVAL_REQUIRED",
        "Paused history import requires exact host approval",
      );
    if (
      input.signal !== undefined &&
      (types.isProxy(input.signal) || !(input.signal instanceof AbortSignal))
    )
      forkError(
        "FORK_INVALID",
        "Import cancellation requires an actual signal",
      );
    if (
      input.signal !== undefined &&
      Object.getOwnPropertyDescriptor(
        AbortSignal.prototype,
        "aborted",
      )!.get!.call(input.signal)
    )
      forkError("FORK_CANCELLED", "History import was cancelled");
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
    if (
      this.engine.store.getSessionDocument(
        sessionId,
        "conversation.fork.import",
      )?.data.paused === true
    )
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
        profile = this.engine.profiles.list().find((p) => p.id === PROFILE);
      const catalogue = this.engine.toolRuntime.catalogue(
        "engine",
        "plan",
        caps.tools.map((t) => t.name).filter((n) => READ_TOOLS.includes(n)),
        { id: PROFILE, revision: record.preview.config.agentProfileRevision! },
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
        ? this.branchTranscript(
            this.transcript(
              record.preview.source,
              config,
              "exact-replay",
              parent,
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
