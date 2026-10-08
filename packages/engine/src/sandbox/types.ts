import {
  EngineError,
  type JsonObject,
  type RunConfigInput,
} from "@moodcode/contracts";
import { types } from "node:util";
import { createHash } from "node:crypto";
import type { ScheduleTargetPin } from "../schedules/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
export const SANDBOX_LIMITS = Object.freeze({
  paths: 32,
  records: 256,
  rowBytes: 131072,
  totalBytes: 16777216,
  events: 8192,
  profileBytes: 32768,
});
export function sandboxError(code: string): never {
  throw new EngineError(
    code,
    "OS sandbox original authority, exact restriction or native evidence is unavailable or changed",
  );
}
export function sandboxJson<T>(
  value: T,
  max: number = SANDBOX_LIMITS.rowBytes,
): T {
  let nodes = 0;
  let textBytes = 0;
  const chargeText = (text: string): void => {
    if (text.length > max) sandboxError("SANDBOX_LIMIT");
    textBytes += Buffer.byteLength(text);
    if (textBytes > max) sandboxError("SANDBOX_LIMIT");
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 16000 || depth > 24) sandboxError("SANDBOX_LIMIT");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      chargeText(v);
      if (v.includes("\0")) sandboxError("SANDBOX_INVALID");
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v || typeof v !== "object" || types.isProxy(v))
      sandboxError("SANDBOX_INVALID");
    if (
      !Array.isArray(v) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      sandboxError("SANDBOX_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Array.isArray(v)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 16000)
        sandboxError("SANDBOX_LIMIT");
      if (Reflect.ownKeys(descriptors).length !== length + 1)
        sandboxError("SANDBOX_INVALID");
      for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(descriptors, String(i)))
          sandboxError("SANDBOX_INVALID");
      }
    }
    if (
      Reflect.ownKeys(descriptors).some(
        (k) =>
          typeof k !== "string" ||
          (k !== "length" &&
            (!descriptors[k]!.enumerable ||
              !Object.hasOwn(descriptors[k]!, "value"))),
      )
    )
      sandboxError("SANDBOX_INVALID");
    const out: unknown = Array.isArray(v) ? [] : Object.create(null);
    for (const [k, d] of Object.entries(descriptors)) {
      if (k === "length" && Array.isArray(v)) continue;
      chargeText(k);
      if (["__proto__", "constructor", "prototype"].includes(k))
        sandboxError("SANDBOX_INVALID");
      (out as Record<string, unknown>)[k] = visit(d.value, depth + 1);
    }
    return Object.freeze(out);
  };
  const copy = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > max)
    sandboxError("SANDBOX_LIMIT");
  return copy as T;
}
export function sandboxObject<T>(input: T, keys: readonly string[]): T {
  const c = sandboxJson(input);
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).some((k) => !keys.includes(k))
  )
    sandboxError("SANDBOX_INVALID");
  return c;
}
export const sandboxSha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function sandboxSign<T extends object>(body: T): T & { sha256: string } {
  const { sha256: _old, ...clean } = body as T & { sha256?: string };
  return sandboxJson({ ...clean, sha256: knowledgeHash(clean) }) as T & {
    sha256: string;
  };
}
export function sandboxDigest(input: unknown): Record<string, any> {
  const r = sandboxJson(input) as Record<string, any>;
  if (!r || Array.isArray(r) || typeof r.sha256 !== "string")
    sandboxError("SANDBOX_INVALID");
  const { sha256, ...body } = r;
  if (knowledgeHash(body) !== sha256) sandboxError("SANDBOX_DIGEST");
  return r;
}
export interface SandboxPhysicalPin {
  path: string;
  kind: "directory" | "file";
  device: string;
  inode: string;
  mode: string;
  size: string;
  mtimeNs: string;
  sha256: string | null;
}
export interface SandboxCapability {
  version: 1;
  backend: "darwin-seatbelt-v1";
  supportTier: "experimental-deprecated-cli" | "unsupported";
  platform: string;
  osRelease: string;
  available: boolean;
  fileIsolation: boolean;
  networkIsolation: boolean;
  descendantIsolation: boolean;
  executable: SandboxPhysicalPin | null;
  evidenceSha256: string | null;
  code: string | null;
  sha256: string;
}
export interface SandboxLaunch {
  version: 1;
  backend: "darwin-seatbelt-v1";
  executable: string;
  profile: string;
  grantSha256: string;
  sha256: string;
}
export interface PreviewSandboxGrantInput {
  workspaceId: string;
  sessionId: string;
  config: RunConfigInput;
  readPaths: readonly string[];
  writePaths: readonly string[];
  network: "deny";
}
export interface SandboxGrant {
  version: 1;
  id: string;
  workspaceId: string;
  sessionId: string;
  root: string;
  ownerEpoch: string;
  rootBindingSha256: string;
  backend: SandboxCapability;
  target: ScheduleTargetPin;
  readPaths: readonly string[];
  writePaths: readonly string[];
  pins: readonly SandboxPhysicalPin[];
  excluded: readonly string[];
  profile: string;
  launch: SandboxLaunch;
  sha256: string;
}
export interface ApproveSandboxGrantInput {
  workspaceId: string;
  requestId: string;
  expectedRevision: number;
  preview: object;
  fingerprint: string;
  approved: boolean;
}
export interface SandboxRecord {
  version: 1;
  id: string;
  kind: "grant" | "command" | "host-command" | "mcp" | "mcp-binding";
  workspaceId: string;
  sessionId: string;
  revision: number;
  previousSha256: string | null;
  state:
    | "approved"
    | "starting"
    | "running"
    | "closed"
    | "uncertain"
    | "paused-import";
  grant: SandboxGrant;
  owner: JsonObject | null;
  groupPid: number | null;
  completion: JsonObject | null;
  requestId: string;
  requestSha256: string;
  createdAt: string;
  updatedAt: string;
  sha256: string;
}
export const sandboxRecordKind = (id: string) =>
  "sandbox.record." + knowledgeHash(id).slice(0, 40);
