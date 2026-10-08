import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  EngineError,
  type RunConfig,
  type RunConfigInput,
  type SessionSnapshot,
  type JsonObject,
  type InputReceipt,
} from "@moodcode/contracts";
import type { ProviderMessage } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
export const FORK_KIND = "conversation.fork.v1";
export const FORK_LIMITS = Object.freeze({
  sourceBytes: 131072,
  transcriptBytes: 65536,
  recordBytes: 262144,
  messages: 64,
  runs: 16,
  pins: 512,
  handles: 32,
  depth: 8,
});
export function forkHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function forkError(code: string, message: string): never {
  throw new EngineError(code, message);
}
/** Descriptor-first validation; Original capabilities must never pass through this DATA copier. */
export function forkJson<T>(
  value: T,
  cap: number = FORK_LIMITS.recordBytes,
): T {
  const visiting = new Set<object>();
  let nodes = 0;
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 48)
      return forkError("FORK_LIMIT", "Fork data exceeds the structural bound");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (
        Buffer.byteLength(input) > cap ||
        Buffer.from(input).toString("utf8") !== input
      )
        forkError("FORK_INVALID", "Fork strings must be bounded UTF-8");
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      visiting.has(input)
    )
      return forkError("FORK_INVALID", "Fork DATA requires plain acyclic JSON");
    const array = Array.isArray(input),
      descriptors = Object.getOwnPropertyDescriptors(input),
      proto = Object.getPrototypeOf(input);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      proto !== null
    )
      forkError("FORK_INVALID", "Fork DATA has an invalid prototype");
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 20000)
        forkError("FORK_LIMIT", "Fork array length exceeds its bound");
      for (let i = 0; i < length; i++)
        if (!descriptors[String(i)])
          forkError("FORK_INVALID", "Sparse arrays are unsupported");
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^\d+$/.test(key) ||
              String(Number(key)) !== key ||
              Number(key) >= length),
        )
      )
        forkError("FORK_INVALID", "Fork arrays reject named properties");
    }
    visiting.add(input);
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === "length") continue;
      const d = descriptors[key as string];
      if (typeof key !== "string" || !d || !d.enumerable || !("value" in d))
        forkError("FORK_INVALID", "Fork DATA rejects accessors and symbols");
      Object.defineProperty(out, key, {
        value: copy(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && Object.keys(out).length !== (input as unknown[]).length)
      forkError("FORK_INVALID", "Sparse fork arrays are unsupported");
    visiting.delete(input);
    return out;
  }
  const result = copy(value, 0) as T;
  if (Buffer.byteLength(JSON.stringify(result)) > cap)
    forkError("FORK_LIMIT", "The complete fork record exceeds its byte bound");
  return result;
}
export function forkId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return forkError("FORK_INVALID", "Fork identity must be bounded text");
  return value;
}
export interface ForkSourcePin {
  table: string;
  id: string;
  sha256: string;
}
export interface FrozenHistoryManifest {
  version: 1;
  sourceSessionId: string;
  sourceWorkspaceId: string;
  throughRunId: string;
  legacySeq: number;
  nativeSeq: number;
  snapshot: SessionSnapshot;
  pins: ForkSourcePin[];
  omittedRuns: number;
  laterRunIds: string[];
  sha256: string;
}
export interface CaptureForkPreviewInput {
  sourceSessionId: string;
  throughRunId?: string;
  targetWorkspaceId?: string;
  worktreeId?: string;
  title?: string;
  prompt: string;
  config?: RunConfigInput;
  disposition?: "exact-replay" | "semantic";
}
export interface ForkPreview {
  version: 1;
  previewId: string;
  targetSessionId: string;
  targetWorkspaceId: string;
  title: string;
  prompt: string;
  config: RunConfig;
  source: FrozenHistoryManifest;
  transcript: ProviderMessage[];
  sourceBinding: KnowledgeHostBinding;
  targetBinding: KnowledgeHostBinding;
  capabilitiesSha256: string;
  catalogueSha256: string;
  profile: JsonObject | null;
  worktree: JsonObject | null;
  disposition: "exact-replay" | "semantic";
  parent: { sessionId: string; sha256: string } | null;
  depth: number;
  expiresAt: string;
  effectsRetained: true;
  readonlyFirstRun: true;
  sha256: string;
}
export interface ConversationFork {
  version: 1;
  id: string;
  sessionId: string;
  workspaceId: string;
  requestId: string;
  approvalFingerprint: string;
  preview: ForkPreview;
  input: InputReceipt;
  origin: "host-fork" | "delegated-data";
  parentForkSha256: string | null;
  createdAt: string;
  sha256: string;
}
export interface ForkCommitInput {
  preview: object;
  requestId: string;
  approved: boolean;
  approvalFingerprint: string;
  signal?: AbortSignal;
}
export interface ForkResult {
  record: ConversationFork;
  duplicate: boolean;
}
export interface ForkContextContribution {
  sha256: string;
  sourceIds: string[];
  messages: ProviderMessage[];
}
export function signedFork<T extends object>(value: T): T & { sha256: string } {
  const copy = { ...value } as T & { sha256?: string };
  delete copy.sha256;
  return { ...copy, sha256: forkHash(copy) } as T & { sha256: string };
}
