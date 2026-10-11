import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { entriesBytes, entryBytes } from "../context/memory.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  immutableKnowledgeJson,
  knowledgeHash,
  validateBinding,
} from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import {
  assertNativeSignal,
  plainRecord,
  recordGuards,
} from "../shared/data.js";
import { validateProposalRevision, validateProposalSet } from "./store.js";
import { trackPending } from "./validation.js";
import type {
  ProposalBlobReference,
  ProposalFileEntry,
  ProposalRevision,
  ProposalSelection,
  ProposalSet,
} from "./types.js";
import type { ProposalSourceManifest } from "./source-capture.js";

export const PROPOSAL_OVERLAY_PREFIX =
  "[Moodcode pending proposal overlay v1]\n";
export const PROPOSAL_CONTEXT_LIMITS = Object.freeze({
  proposalIds: 8,
  slotBytes: 32768,
  profiles: 16,
  handles: 256,
});
export interface ProposalContextProfile {
  readonly id: string;
  readonly revision: string;
}
export interface ProposalContextPolicy {
  readonly proposalIds: readonly string[];
  readonly slotBytes: number;
  readonly profiles?: readonly ProposalContextProfile[];
}
export interface ProposalContextBudget {
  readonly slotBytes: number;
  readonly maxContextBytes: number;
  readonly reservedBytes: number;
  readonly requiredMessagesBytes: number;
  readonly contextWindow: number | null;
  readonly outputTokens: number;
}
export interface ProposalContextOwner {
  readonly sessionId: string;
  readonly runId: string | null;
  readonly profile: ProposalContextProfile | null;
}
export interface ProposalContextRequest {
  readonly workspace: Workspace;
  readonly policy: ProposalContextPolicy;
  readonly budget: ProposalContextBudget;
  readonly owner: ProposalContextOwner;
  readonly signal: AbortSignal;
}
export type ProposalContextOmissionReason =
  | "missing"
  | "cancelled"
  | "paused"
  | "stale"
  | "profile-not-selected"
  | "context-budget";
export interface ProposalContributionManifest {
  readonly proposalId: string;
  readonly setSha256: string;
  readonly headRevision: number;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly sourceManifestSha256: string;
  readonly bindingSha256: string;
  readonly files: readonly ProposalFileEntry[];
}
export interface PreparedProposalContribution {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly authority: "read-only";
  readonly state: "pending-unapplied";
  readonly coverage: "host-selected-proposal-ids";
  readonly workspaceId: string;
  readonly owner: ProposalContextOwner;
  readonly policySha256: string;
  readonly bindingSha256: string;
  readonly proposals: readonly ProposalContributionManifest[];
  readonly omissions: readonly {
    readonly proposalId: string;
    readonly reason: ProposalContextOmissionReason;
  }[];
  readonly complete: boolean;
  readonly messages: readonly {
    readonly role: "assistant";
    readonly content: string;
  }[];
  readonly reservations: {
    readonly envelopeBytes: number;
    readonly outputTokens: number;
    readonly slotBytes: number;
    readonly availableBytes: number;
    readonly contributedBytes: number;
  };
  readonly inputEstimate: {
    readonly tokens: null;
    readonly utf8ByteUpperBound: number;
    readonly estimated: true;
    readonly source: "utf8-byte-upper-bound";
    readonly contextWindow: number | null;
  };
}
export interface ProposalContextSourcePort {
  prepare(
    request: ProposalContextRequest,
  ): Promise<PreparedProposalContribution>;
  assertFresh(
    original: PreparedProposalContribution,
    signal: AbortSignal,
  ): Promise<void>;
  release(original: PreparedProposalContribution): void;
}
export interface ProposalOverlayContextSourcePorts {
  readonly readTx: <T>(operation: () => T) => T;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertOwnerCurrent: (
    workspaceId: string,
    owner: ProposalContextOwner,
  ) => void;
  readonly getSet: (
    workspaceId: string,
    proposalId: string,
  ) => ProposalSet | undefined;
  readonly getSelection: (
    workspaceId: string,
    proposalId: string,
  ) => ProposalSelection | undefined;
  readonly readBlobText: (reference: ProposalBlobReference) => string;
  readonly assertSourcesCurrent: (
    binding: KnowledgeHostBinding,
    manifest: ProposalSourceManifest,
    signal: AbortSignal,
  ) => Promise<void>;
}
type PayloadFile = {
  readonly path: string;
  readonly operation: ProposalFileEntry["operation"];
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly before: string | null;
  readonly after: string | null;
};
type PayloadProposal = {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly revisionSha256: string;
  readonly sourceSha256: string;
  readonly files: readonly PayloadFile[];
};
type Selected = {
  readonly selection: ProposalSelection;
  readonly data: PayloadProposal;
};
type Owned = {
  readonly request: Omit<ProposalContextRequest, "signal">;
  readonly binding: KnowledgeHostBinding;
  readonly selected: readonly Selected[];
};
function fail(code = "INVALID_PROPOSAL_CONTEXT"): never {
  throw new EngineError(
    code,
    "Proposal context requires original read-only captures, exact native revisions and bounded whole data",
  );
}
function invalid(): never {
  return fail();
}
const { id, integer: count } = recordGuards({
  json: immutableKnowledgeJson,
  fail: invalid,
});
function plain(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  plainRecord(value, required, optional, invalid);
}
function check(value: AbortSignal): void {
  if (value.aborted) fail("PROPOSAL_CONTEXT_CANCELLED");
}
function sync(value: unknown): void {
  if (value !== undefined) fail("PROPOSAL_CONTEXT_PORT_INVALID");
}
function profile(value: unknown): ProposalContextProfile {
  const r = immutableKnowledgeJson(value);
  plain(r, ["id", "revision"]);
  id(r.id);
  id(r.revision);
  return r as unknown as ProposalContextProfile;
}
export function proposalContextPolicy(value: unknown): ProposalContextPolicy {
  const p = immutableKnowledgeJson(value);
  plain(p, ["proposalIds", "slotBytes"], ["profiles"]);
  if (
    !Array.isArray(p.proposalIds) ||
    !p.proposalIds.length ||
    p.proposalIds.length > PROPOSAL_CONTEXT_LIMITS.proposalIds ||
    new Set(p.proposalIds.map(id)).size !== p.proposalIds.length ||
    count(p.slotBytes, PROPOSAL_CONTEXT_LIMITS.slotBytes) < 1
  )
    fail();
  if (p.profiles !== undefined) {
    if (
      !Array.isArray(p.profiles) ||
      !p.profiles.length ||
      p.profiles.length > PROPOSAL_CONTEXT_LIMITS.profiles
    )
      fail();
    const seen = new Set<string>();
    for (const v of p.profiles) {
      const f = profile(v),
        key = JSON.stringify(f);
      if (seen.has(key)) fail();
      seen.add(key);
    }
  }
  return p as unknown as ProposalContextPolicy;
}
function requestSnapshot(
  input: ProposalContextRequest,
): Omit<ProposalContextRequest, "signal"> {
  plain(input, ["workspace", "policy", "budget", "owner", "signal"]);
  assertNativeSignal(input.signal, invalid);
  const workspace = immutableKnowledgeJson(input.workspace);
  plain(workspace, ["id", "root", "gitRoot", "branch", "createdAt"]);
  id(workspace.id);
  if (
    typeof workspace.root !== "string" ||
    typeof workspace.gitRoot !== "string" ||
    typeof workspace.createdAt !== "string" ||
    (workspace.branch !== null && typeof workspace.branch !== "string")
  )
    fail();
  const owner = immutableKnowledgeJson(input.owner);
  plain(owner, ["sessionId", "runId", "profile"]);
  id(owner.sessionId);
  if (owner.runId !== null) id(owner.runId);
  if (owner.profile !== null) profile(owner.profile);
  const budget = immutableKnowledgeJson(input.budget);
  plain(budget, [
    "slotBytes",
    "maxContextBytes",
    "reservedBytes",
    "requiredMessagesBytes",
    "contextWindow",
    "outputTokens",
  ]);
  count(budget.slotBytes, PROPOSAL_CONTEXT_LIMITS.slotBytes);
  for (const key of [
    "maxContextBytes",
    "reservedBytes",
    "requiredMessagesBytes",
    "outputTokens",
  ])
    count(budget[key], 100_000_000);
  if (budget.contextWindow !== null) count(budget.contextWindow, 100_000_000);
  return Object.freeze({
    workspace: workspace as unknown as Workspace,
    policy: proposalContextPolicy(input.policy),
    budget: budget as unknown as ProposalContextBudget,
    owner: owner as unknown as ProposalContextOwner,
  });
}
function selection(
  input: ProposalSelection,
  workspaceId: string,
  proposalId: string,
): ProposalSelection {
  plain(input, ["set", "revision"]);
  const set = validateProposalSet(input.set),
    revision = validateProposalRevision(input.revision);
  if (
    set.workspaceId !== workspaceId ||
    set.id !== proposalId ||
    set.status !== "pending" ||
    revision.workspaceId !== workspaceId ||
    revision.proposalId !== proposalId ||
    set.revisionId !== revision.id ||
    set.revisionSha256 !== revision.sha256 ||
    set.headRevision !== revision.revision
  )
    fail("PROPOSAL_CONTEXT_STALE");
  return Object.freeze({ set, revision });
}
function payload(
  revision: ProposalRevision,
  read: (ref: ProposalBlobReference) => string,
  empty = false,
): PayloadProposal {
  const readBody = (ref: ProposalBlobReference | null): string | null => {
    if (ref === null) return null;
    if (empty) return "";
    const body = read(ref);
    if (
      typeof body !== "string" ||
      Buffer.byteLength(body) !== ref.bytes ||
      Buffer.from(body).toString("utf8") !== body ||
      sha256Hex(body) !== ref.sha256 ||
      body.includes("\0")
    )
      fail();
    return body;
  };
  return Object.freeze({
    proposalId: revision.proposalId,
    revisionId: revision.id,
    revision: revision.revision,
    revisionSha256: revision.sha256,
    sourceSha256: revision.sourceManifestSha256,
    files: Object.freeze(
      revision.files.map((file) =>
        Object.freeze({
          path: file.path,
          operation: file.operation,
          beforeSha256: file.before?.sha256 ?? null,
          afterSha256: file.after?.sha256 ?? null,
          before: readBody(file.before),
          after: readBody(file.after),
        }),
      ),
    ),
  });
}
function message(
  workspaceId: string,
  policySha256: string,
  selected: readonly PayloadProposal[],
): { readonly role: "assistant"; readonly content: string } {
  return Object.freeze({
    role: "assistant",
    content:
      PROPOSAL_OVERLAY_PREFIX +
      JSON.stringify({
        schemaVersion: 1,
        authority: "read-only",
        state: "pending-unapplied",
        workspaceId,
        policySha256,
        proposals: selected,
      }),
  });
}
function manifest(value: ProposalSelection): ProposalContributionManifest {
  const { set, revision } = value;
  return Object.freeze({
    proposalId: set.id,
    setSha256: set.sha256,
    headRevision: set.headRevision,
    revisionId: revision.id,
    revisionSha256: revision.sha256,
    sourceManifestSha256: revision.sourceManifestSha256,
    bindingSha256: knowledgeHash(revision.binding),
    files: revision.files,
  });
}
export function proposalContributionSourceIds(
  value: PreparedProposalContribution,
): string[] {
  return value.proposals.flatMap((p) => [
    `proposal:${p.proposalId}:${p.setSha256}`,
    `proposal-head:${p.proposalId}:${p.headRevision}:${p.setSha256}`,
    `proposal-revision:${p.revisionId}:${p.revisionSha256}`,
    `proposal-source:${p.sourceManifestSha256}`,
    `proposal-binding:${p.bindingSha256}`,
    ...p.files.flatMap((f) =>
      [f.before, f.after]
        .filter((ref): ref is ProposalBlobReference => ref !== null)
        .map(
          (ref) => `proposal-blob:${ref.id}:${ref.sha256}:${ref.headerSha256}`,
        ),
    ),
  ]);
}

/** Host-selected data only. Native tool reads and LSP continue to observe actual filesystem bytes. */
export class ProposalOverlayContextSource implements ProposalContextSourcePort {
  readonly #ports: ProposalOverlayContextSourcePorts;
  readonly #owned = new WeakMap<object, Owned>();
  readonly #active = new Set<object>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #close = new AbortController();
  #reserved = 0;
  constructor(ports: ProposalOverlayContextSourcePorts) {
    plain(ports, [
      "readTx",
      "checkBinding",
      "assertOwnerCurrent",
      "getSet",
      "getSelection",
      "readBlobText",
      "assertSourcesCurrent",
    ]);
    if (Object.values(ports).some((value) => typeof value !== "function"))
      fail();
    this.#ports = Object.freeze({ ...ports });
  }
  private tx<T>(callback: () => T): T {
    let entered = 0;
    const result = this.#ports.readTx(() => {
      if (++entered !== 1) fail("PROPOSAL_CONTEXT_PORT_INVALID");
      return callback();
    });
    if (
      entered !== 1 ||
      (result &&
        typeof result === "object" &&
        (types.isProxy(result) || "then" in result))
    )
      fail("PROPOSAL_CONTEXT_PORT_INVALID");
    return result;
  }
  private owner(
    request: Omit<ProposalContextRequest, "signal">,
    binding: KnowledgeHostBinding,
  ): void {
    sync(this.#ports.assertOwnerCurrent(request.workspace.id, request.owner));
    if (
      knowledgeHash(
        validateBinding(this.#ports.checkBinding(request.workspace.id)),
      ) !== knowledgeHash(binding) ||
      request.workspace.id !== binding.workspaceId ||
      request.workspace.root !== binding.root
    )
      fail("PROPOSAL_CONTEXT_STALE");
  }
  private current(
    request: Omit<ProposalContextRequest, "signal">,
    binding: KnowledgeHostBinding,
    value: ProposalSelection,
  ): void {
    this.owner(request, binding);
    const actual = this.#ports.getSelection(request.workspace.id, value.set.id);
    if (
      !actual ||
      knowledgeHash(selection(actual, request.workspace.id, value.set.id)) !==
        knowledgeHash(value)
    )
      fail("PROPOSAL_CONTEXT_STALE");
  }
  prepare(
    input: ProposalContextRequest,
  ): Promise<PreparedProposalContribution> {
    const request = requestSnapshot(input),
      combined = AbortSignal.any([input.signal, this.#close.signal]);
    check(combined);
    if (this.#active.size + this.#reserved >= PROPOSAL_CONTEXT_LIMITS.handles)
      fail("PROPOSAL_CONTEXT_LIMIT");
    this.#reserved++;
    return trackPending(this.#pending, this.prepareOwned(request, combined));
  }
  private async prepareOwned(
    request: Omit<ProposalContextRequest, "signal">,
    signal: AbortSignal,
  ): Promise<PreparedProposalContribution> {
    try {
      const binding = this.tx(() => {
          const current = validateBinding(
            this.#ports.checkBinding(request.workspace.id),
          );
          this.owner(request, current);
          return current;
        }),
        policySha256 = knowledgeHash(request.policy),
        budget = request.budget;
      const contextAvailable =
        budget.contextWindow === null
          ? budget.maxContextBytes
          : Math.min(
              budget.maxContextBytes,
              Math.max(0, budget.contextWindow - budget.outputTokens),
            );
      const availableBytes = Math.max(
        0,
        Math.min(
          request.policy.slotBytes,
          budget.slotBytes,
          contextAvailable -
            budget.reservedBytes -
            budget.requiredMessagesBytes,
        ),
      );
      const selected: Selected[] = [],
        omissions: {
          proposalId: string;
          reason: ProposalContextOmissionReason;
        }[] = [];
      const allowed =
        !request.policy.profiles ||
        (request.owner.profile !== null &&
          request.policy.profiles.some(
            (p) => knowledgeHash(p) === knowledgeHash(request.owner.profile),
          ));
      for (const proposalId of request.policy.proposalIds) {
        check(signal);
        if (!allowed) {
          omissions.push({ proposalId, reason: "profile-not-selected" });
          continue;
        }
        const candidate = this.tx(() => {
          this.owner(request, binding);
          const set = this.#ports.getSet(request.workspace.id, proposalId);
          if (!set) return "missing" as const;
          const head = validateProposalSet(set);
          if (head.status !== "pending")
            return head.status === "paused-import"
              ? ("paused" as const)
              : ("cancelled" as const);
          const raw = this.#ports.getSelection(
            request.workspace.id,
            proposalId,
          );
          if (!raw) return "stale" as const;
          const current = selection(raw, request.workspace.id, proposalId);
          if (
            knowledgeHash(current.revision.binding) !== knowledgeHash(binding)
          )
            return "stale" as const;
          const mock = payload(
            current.revision,
            this.#ports.readBlobText,
            true,
          );
          if (
            entryBytes(
              message(request.workspace.id, policySha256, [
                ...selected.map((s) => s.data),
                mock,
              ]),
            ) +
              current.revision.totalBytes >
            availableBytes
          )
            return "context-budget" as const;
          const data = payload(current.revision, this.#ports.readBlobText);
          if (
            entryBytes(
              message(request.workspace.id, policySha256, [
                ...selected.map((s) => s.data),
                data,
              ]),
            ) > availableBytes
          )
            return "context-budget" as const;
          return Object.freeze({ selection: current, data });
        });
        if (typeof candidate === "string") {
          omissions.push({ proposalId, reason: candidate });
          continue;
        }
        try {
          await this.#ports.assertSourcesCurrent(
            binding,
            candidate.selection.revision.sourceManifest,
            signal,
          );
          check(signal);
          this.tx(() => this.current(request, binding, candidate.selection));
          selected.push(candidate);
        } catch (error) {
          check(signal);
          if (
            (error instanceof EngineError &&
              [
                "PROPOSAL_SOURCE_STALE",
                "PROPOSAL_SOURCE_BINDING_CHANGED",
                "PROPOSAL_SOURCE_UNSAFE",
                "PROPOSAL_SOURCE_PREIMAGE_MISMATCH",
                "PROPOSAL_CONTEXT_STALE",
              ].includes(error.code)) ||
            (error instanceof Error &&
              "code" in error &&
              ["ENOENT", "ENOTDIR"].includes(String(error.code)))
          ) {
            omissions.push({ proposalId, reason: "stale" });
            continue;
          }
          throw error;
        }
      }
      check(signal);
      this.tx(() => {
        this.owner(request, binding);
        for (const value of selected)
          this.current(request, binding, value.selection);
      });
      const messages = selected.length
          ? [
              message(
                request.workspace.id,
                policySha256,
                selected.map((s) => s.data),
              ),
            ]
          : [],
        contributedBytes = entriesBytes(messages);
      const contribution: PreparedProposalContribution = Object.freeze({
        schemaVersion: 1,
        id: randomUUID(),
        authority: "read-only",
        state: "pending-unapplied",
        coverage: "host-selected-proposal-ids",
        workspaceId: request.workspace.id,
        owner: request.owner,
        policySha256,
        bindingSha256: knowledgeHash(binding),
        proposals: Object.freeze(selected.map((s) => manifest(s.selection))),
        omissions: Object.freeze(omissions.map((o) => Object.freeze(o))),
        complete: omissions.length === 0,
        messages: Object.freeze(messages),
        reservations: Object.freeze({
          envelopeBytes: budget.reservedBytes,
          outputTokens: budget.outputTokens,
          slotBytes: request.policy.slotBytes,
          availableBytes,
          contributedBytes,
        }),
        inputEstimate: Object.freeze({
          tokens: null,
          utf8ByteUpperBound: contributedBytes,
          estimated: true,
          source: "utf8-byte-upper-bound",
          contextWindow: budget.contextWindow,
        }),
      });
      this.#owned.set(
        contribution,
        Object.freeze({ request, binding, selected: Object.freeze(selected) }),
      );
      this.#active.add(contribution);
      return contribution;
    } finally {
      this.#reserved--;
    }
  }
  private owned(original: PreparedProposalContribution): Owned {
    if (
      !original ||
      typeof original !== "object" ||
      types.isProxy(original) ||
      !this.#active.has(original)
    )
      fail("PROPOSAL_CONTEXT_CAPTURE_INVALID");
    return (
      this.#owned.get(original) ?? fail("PROPOSAL_CONTEXT_CAPTURE_INVALID")
    );
  }
  assertFresh(
    original: PreparedProposalContribution,
    inputSignal: AbortSignal,
  ): Promise<void> {
    assertNativeSignal(inputSignal, invalid);
    const owned = this.owned(original),
      combined = AbortSignal.any([inputSignal, this.#close.signal]);
    check(combined);
    const task = (async () => {
      this.tx(() => {
        this.owner(owned.request, owned.binding);
        for (const value of owned.selected)
          this.current(owned.request, owned.binding, value.selection);
      });
      for (const value of owned.selected) {
        await this.#ports.assertSourcesCurrent(
          owned.binding,
          value.selection.revision.sourceManifest,
          combined,
        );
        check(combined);
      }
      this.owned(original);
      check(combined);
      this.tx(() => {
        this.owner(owned.request, owned.binding);
        for (const value of owned.selected)
          this.current(owned.request, owned.binding, value.selection);
      });
    })();
    return trackPending(this.#pending, task);
  }
  release(original: PreparedProposalContribution): void {
    this.owned(original);
    this.#active.delete(original);
    this.#owned.delete(original);
  }
  async close(): Promise<void> {
    this.#close.abort();
    await Promise.allSettled([...this.#pending]);
    for (const original of this.#active) this.#owned.delete(original);
    this.#active.clear();
  }
}

export interface ProposalDiffOptions {
  readonly after?: number;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly sourceFreshness?: "current" | "stale" | "unknown";
  /** Current host-read head status; independent from the selected immutable content revision. */
  readonly proposalStatus?: ProposalSet["status"] | "unknown";
}
export interface ProposalReadonlyDiff {
  readonly schemaVersion: 1;
  readonly projection: "proposal-readonly-diff-v1";
  readonly authority: "observation-only";
  readonly state: "captured-history";
  readonly proposalStatus: ProposalSet["status"] | "unknown";
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceFreshness: "current" | "stale" | "unknown";
  readonly files: readonly PayloadFile[];
  readonly omissions: readonly {
    readonly path: string;
    readonly reason: "page-budget";
  }[];
  readonly next: number | null;
  readonly bytes: number;
}
/** Exact captured before/after content; later disk edits do not rewrite immutable readonly history. Caller owns the primary read TX. */
export function buildProposalDiff(
  input: ProposalRevision,
  readBlobText: (ref: ProposalBlobReference) => string,
  options: ProposalDiffOptions = {},
): ProposalReadonlyDiff {
  const revision = validateProposalRevision(input);
  plain(
    options,
    [],
    ["after", "limit", "maxBytes", "sourceFreshness", "proposalStatus"],
  );
  if (typeof readBlobText !== "function") fail();
  const after = count(options.after ?? 0, revision.files.length),
    limit = count(options.limit ?? 64, 64),
    maxBytes = count(options.maxBytes ?? 65536, 65536),
    sourceFreshness = (options.sourceFreshness ?? "unknown") as
      "current" | "stale" | "unknown",
    proposalStatus = (options.proposalStatus ?? "unknown") as
      ProposalSet["status"] | "unknown";
  if (
    !limit ||
    maxBytes < 512 ||
    !["current", "stale", "unknown"].includes(sourceFreshness) ||
    ![
      "pending",
      "cancelled",
      "paused-import",
      "applied",
      "partial",
      "uncertain",
      "unknown",
    ].includes(proposalStatus)
  )
    fail();
  const files: PayloadFile[] = [],
    omissions: { path: string; reason: "page-budget" }[] = [];
  let cursor = after;
  const base = {
    schemaVersion: 1 as const,
    projection: "proposal-readonly-diff-v1" as const,
    authority: "observation-only" as const,
    state: "captured-history" as const,
    proposalStatus,
    proposalId: revision.proposalId,
    revisionId: revision.id,
    revisionSha256: revision.sha256,
    sourceManifestSha256: revision.sourceManifestSha256,
    sourceFreshness,
  };
  // A non-empty page ends before an omission it cannot fit; an empty page still advances.
  const omit = (path: string): boolean => {
    const omission = { path, reason: "page-budget" as const };
    if (
      files.length + omissions.length > 0 &&
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          files,
          omissions: [...omissions, omission],
          next: cursor + 1,
          bytes: 0,
        }),
      ) +
        64 >
        maxBytes
    )
      return false;
    omissions.push(omission);
    return true;
  };
  for (; cursor < revision.files.length && cursor < after + limit; cursor++) {
    const file = revision.files[cursor]!,
      mock = {
        path: file.path,
        operation: file.operation,
        beforeSha256: file.before?.sha256 ?? null,
        afterSha256: file.after?.sha256 ?? null,
        before: file.before === null ? null : "",
        after: file.after === null ? null : "",
      };
    if (
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          files: [...files, mock],
          omissions,
          next: cursor + 1,
          bytes: 0,
        }),
      ) +
        (file.before?.bytes ?? 0) +
        (file.after?.bytes ?? 0) +
        64 >
      maxBytes
    ) {
      if (!omit(file.path)) break;
      continue;
    }
    const value = payload(
      { ...revision, files: [file] } as ProposalRevision,
      readBlobText,
    ).files[0]!;
    if (
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          files: [...files, value],
          omissions,
          next: cursor + 1,
          bytes: 0,
        }),
      ) +
        64 >
      maxBytes
    ) {
      if (!omit(file.path)) break;
      continue;
    }
    files.push(value);
  }
  const unsigned = {
    ...base,
    files: Object.freeze(files),
    omissions: Object.freeze(omissions.map((o) => Object.freeze(o))),
    next: cursor < revision.files.length ? cursor : null,
  };
  let bytes = Buffer.byteLength(JSON.stringify({ ...unsigned, bytes: 0 }));
  for (let i = 0; i < 3; i++)
    bytes = Buffer.byteLength(JSON.stringify({ ...unsigned, bytes }));
  if (bytes > maxBytes) fail("PROPOSAL_DIFF_LIMIT");
  return Object.freeze({ ...unsigned, bytes });
}
