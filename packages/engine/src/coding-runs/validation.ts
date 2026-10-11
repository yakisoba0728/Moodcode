import { join } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { plainRecord } from "../shared/data.js";
import { readStableFile } from "../shared/fs.js";
import {
  workflowError,
  workflowJson,
  workflowIdentifier,
  validateWorkflowSpec,
} from "../workflows/spec.js";
import type { CodingBatchInput, CodingSourcePin } from "./types.js";
export const NATIVE_RECORD_BYTES = 262144;
export const CODING_STAGES = ["edit", "validate", "review"] as const;
const LIMIT_CAPS = {
  concurrency: 4,
  maxDurationMs: 300000,
  maxSourceBytes: 1048576,
  maxEvidenceBytes: NATIVE_RECORD_BYTES,
  maxExportBytes: 2097152,
  maxTokens: 100000000,
  maxCostMicros: 1000000000,
  costPerRequestMicros: Number.MAX_SAFE_INTEGER,
} as const;
const inputRecord = (value: unknown, required: readonly string[]) =>
  plainRecord(value, required, [], () =>
    workflowError("INVALID_WORKFLOW_INPUT"),
  );
export function batchFail(code = "CODING_BATCH_INVALID"): never {
  throw new EngineError(
    code,
    "Coding batches require current original host authority, native isolated execution, verification and exact selection approval",
  );
}
export function signBatch<T extends object>(value: T): T & { sha256: string } {
  const { sha256: ignored, ...body } = value as T & { sha256?: string };
  return workflowJson({ ...body, sha256: knowledgeHash(body) }) as T & {
    sha256: string;
  };
}
export function validateBatch(input: CodingBatchInput): CodingBatchInput {
  inputRecord(input, [
    "workspaceId",
    "rootSessionId",
    "parentRunId",
    "groupId",
    "cases",
    "limits",
  ]);
  const v = workflowJson(input);
  for (const k of [
    "workspaceId",
    "rootSessionId",
    "parentRunId",
    "groupId",
  ] as const)
    workflowIdentifier(v[k]);
  if (
    !Array.isArray(v.cases) ||
    v.cases.length < 1 ||
    v.cases.length > 4 ||
    new Set(v.cases.map((c) => c.id)).size !== v.cases.length
  )
    batchFail("CODING_BATCH_LIMIT");
  inputRecord(v.limits, Object.keys(LIMIT_CAPS));
  for (const [key, max] of Object.entries(LIMIT_CAPS)) {
    const n = v.limits[key as keyof typeof LIMIT_CAPS];
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      batchFail("CODING_BATCH_LIMIT");
  }
  const roots = new Set<string>();
  for (const c of v.cases) {
    inputRecord(c, ["id", "spec", "stageWorktrees", "sourcePaths"]);
    workflowIdentifier(c.id);
    const spec = validateWorkflowSpec(c.spec);
    if (
      spec.stages.length !== 3 ||
      spec.stages.some((s, i) => s.id !== CODING_STAGES[i]) ||
      spec.stages[0]!.role !== "editor" ||
      spec.stages[1]!.role !== "validator" ||
      spec.stages[2]!.role !== "advisory-reviewer" ||
      spec.resultStageId !== "review" ||
      knowledgeHash(spec.stages[1]!.dependsOn) !== knowledgeHash(["edit"]) ||
      knowledgeHash(spec.stages[2]!.dependsOn) !==
        knowledgeHash(["validate"]) ||
      spec.stages.some((s) => s.join !== "all")
    )
      batchFail("CODING_CASE_UNSUPPORTED");
    if (
      knowledgeHash([...c.sourcePaths].sort()) !==
      knowledgeHash([...spec.stages[1]!.verification!.sourcePaths].sort())
    )
      batchFail("CODING_SOURCE_MANIFEST_MISMATCH");
    if (
      !Array.isArray(c.sourcePaths) ||
      !c.sourcePaths.length ||
      c.sourcePaths.length > 32 ||
      c.sourcePaths.some(
        (p: string) =>
          typeof p !== "string" ||
          !p ||
          p.startsWith("/") ||
          p.split("/").some((x) => !x || x === "." || x === ".."),
      )
    )
      batchFail("CODING_SOURCE_INVALID");
    if (
      Object.keys(c.stageWorktrees).sort().join(",") !==
        "edit,review,validate" ||
      c.stageWorktrees.edit !== c.stageWorktrees.validate ||
      c.stageWorktrees.review === c.stageWorktrees.edit ||
      roots.has(c.stageWorktrees.edit!) ||
      roots.has(c.stageWorktrees.review!)
    )
      batchFail("CODING_WORKTREE_ISOLATION");
    roots.add(c.stageWorktrees.edit!);
    roots.add(c.stageWorktrees.review!);
  }
  return v;
}
function pinCodingSource(
  path: string,
  maxBytes = 1048576,
): CodingSourcePin {
  const stale = (): never => batchFail("CODING_SOURCE_STALE");
  const { stats, bytes, sha256 } = readStableFile(path, {
    maxBytes,
    stable: ["size", "mtime", "ctime"],
    requireSingleLink: true,
    onChanged: stale,
    onLimit: stale,
  });
  return {
    path,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: bytes,
    sha256,
  };
}
export function assertCodingSources(pins: readonly CodingSourcePin[]): void {
  for (const pin of pins)
    if (knowledgeHash(pinCodingSource(pin.path)) !== knowledgeHash(pin))
      batchFail("CODING_SOURCE_STALE");
}
export function caseSources(
  root: string,
  input: CodingBatchInput,
): CodingSourcePin[] {
  return [...new Set(input.cases.flatMap((c) => c.sourcePaths))]
    .sort()
    .map((p) => pinCodingSource(join(root, p), input.limits.maxSourceBytes));
}
