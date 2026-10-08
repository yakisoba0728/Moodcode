import { EngineError, type JsonObject } from "@moodcode/contracts";
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import type {
  VerificationReceipt,
  VerificationSource,
} from "../verification/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
export const GIT_COMMIT_LIMITS = Object.freeze({
  records: 64,
  recordBytes: 131072,
  totalBytes: 8388608,
  paths: 64,
  fileBytes: 8388608,
  treeEntries: 8192,
  outputBytes: 65536,
  timeoutMs: 60000,
  messageBytes: 8192,
});
export interface PreviewGitCommitInput {
  sessionId: string;
  requestId: string;
  runId: string;
  paths: readonly string[];
  message: string;
  selection: "staged" | "working-tree";
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface GitCommitEntry {
  path: string;
  mode: string;
  oid: string | null;
  fileSha256: string | null;
}
export interface GitRepositoryPin {
  root: string;
  gitDir: string;
  commonDir: string;
  gitDirIdentity: string;
  commonDirIdentity: string;
  head: string;
  symbolicHead: string;
  indexPath: string;
  indexSha256: string | null;
  objectFormat: "sha1" | "sha256";
  hooksSha256: string;
  configurationSha256: string;
  author: string;
  committer: string;
}
export interface GitCommitPreview {
  version: 1;
  id: string;
  requestId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  binding: KnowledgeHostBinding;
  ownerEpoch: string;
  repository: GitRepositoryPin;
  paths: readonly string[];
  selection: "staged" | "working-tree";
  entries: readonly GitCommitEntry[];
  message: string;
  expectedTree: string;
  expectedIndexProjectionSha256: string;
  verification: readonly VerificationReceipt[];
  verificationRevision: number;
  verificationDocumentSha256: string;
  source: VerificationSource;
  timeoutMs: number;
  maxOutputBytes: number;
  createdAt: string;
  sha256: string;
}
export interface CommitReviewedChangesInput {
  workspaceId: string;
  sessionId: string;
  requestId: string;
  previewSha256: string;
  expectedRevision: 1;
  decision: "allow" | "deny";
}
export interface GitCommitOutcome {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  cleanupConfirmed: boolean;
  started: boolean;
  groupPid: number | null;
  supervisorPid: number | null;
  indexAfterSha256: string | null;
  indexAfterProjectionSha256: string | null;
  selectedAfter: readonly { path: string; fileSha256: string | null }[];
  stdout: string;
  stderr: string;
  beforeHead: string;
  afterHead: string | null;
  parent: string | null;
  tree: string | null;
  message: string | null;
  errorCode: string | null;
}
export interface GitCommitReceipt {
  version: 1;
  id: string;
  revision: number;
  preview: GitCommitPreview;
  state:
    | "prepared"
    | "approved"
    | "dispatched"
    | "committed"
    | "failed"
    | "denied"
    | "cancelled"
    | "uncertain"
    | "paused-import";
  requestSha256: string | null;
  outcome: GitCommitOutcome | null;
  commitSha: string | null;
  reconciled: boolean;
  errorCode: string | null;
  importArchiveSha256: string | null;
  createdAt: string;
  updatedAt: string;
  sha256: string;
}
export interface GitCommitResult {
  kind: "settled" | "duplicate";
  receipt: GitCommitReceipt;
}
export const gitSha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function gitCommitError(
  code: string,
  message = "Git commit does not match its exact approved native evidence",
): never {
  throw new EngineError(code, message);
}
export function commitJson<T>(input: T): T {
  let nodes = 0;
  const visiting = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 12000 || depth > 20) gitCommitError("GIT_COMMIT_LIMIT");
    if (
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return v;
    if (typeof v === "string") {
      if (v.includes("\0") || Buffer.from(v).toString("utf8") !== v)
        gitCommitError("INVALID_GIT_COMMIT");
      return v;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || visiting.has(v))
      gitCommitError("INVALID_GIT_COMMIT");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      array
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      gitCommitError("INVALID_GIT_COMMIT");
    visiting.add(v);
    const ds = Object.getOwnPropertyDescriptors(v);
    const result: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const key of Reflect.ownKeys(ds)) {
      if (array && key === "length") continue;
      const d = typeof key === "string" ? ds[key] : undefined;
      if (
        !d ||
        !("value" in d) ||
        !d.enumerable ||
        (array && !/^(0|[1-9][0-9]*)$/.test(String(key)))
      )
        gitCommitError("INVALID_GIT_COMMIT");
      Object.defineProperty(result, key, {
        value: visit(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && Object.keys(result).length !== (v as unknown[]).length)
      gitCommitError("INVALID_GIT_COMMIT");
    visiting.delete(v);
    return Object.freeze(result);
  }
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > GIT_COMMIT_LIMITS.recordBytes)
    gitCommitError("GIT_COMMIT_LIMIT");
  return result as T;
}
export function signedCommit<T extends object>(
  body: T,
): T & { sha256: string } {
  const { sha256: _discard, ...rest } = body as T & { sha256?: string };
  return commitJson({ ...rest, sha256: knowledgeHash(rest) }) as T & {
    sha256: string;
  };
}
export const commitData = (value: object) => value as unknown as JsonObject;
export function commitId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 128 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    gitCommitError("INVALID_GIT_COMMIT");
  return value;
}
export function commitPath(value: unknown): string {
  const s = commitId(value);
  if (
    s.includes("\\") ||
    s.startsWith("/") ||
    s
      .split("/")
      .some(
        (v) => !v || v === "." || v === ".." || v.toLowerCase() === ".git",
      ) ||
    s.startsWith("-")
  )
    gitCommitError("GIT_COMMIT_PATH");
  return s;
}
export function commitDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    gitCommitError("INVALID_GIT_COMMIT");
  return value;
}
export function gitOid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  )
    gitCommitError("INVALID_GIT_COMMIT");
  return value;
}
