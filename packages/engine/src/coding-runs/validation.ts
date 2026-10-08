import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { workflowHostRecord } from "../workflows/host.js";
import {
  workflowJson,
  workflowIdentifier,
  validateWorkflowSpec,
} from "../workflows/spec.js";
import type { CodingBatchInput, CodingSourcePin } from "./types.js";
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
  workflowHostRecord(input, [
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
  workflowHostRecord(v.limits, [
    "concurrency",
    "maxDurationMs",
    "maxSourceBytes",
    "maxEvidenceBytes",
    "maxExportBytes",
    "maxTokens",
    "maxCostMicros",
    "costPerRequestMicros",
  ]);
  for (const [key, n] of Object.entries(v.limits))
    if (!Number.isSafeInteger(n) || n < 1) batchFail("CODING_BATCH_LIMIT");
  if (
    v.limits.concurrency > 4 ||
    v.limits.maxDurationMs > 300000 ||
    v.limits.maxSourceBytes > 1048576 ||
    v.limits.maxEvidenceBytes > 1048576 ||
    v.limits.maxExportBytes > 2097152 ||
    v.limits.maxTokens > 100000000 ||
    v.limits.maxCostMicros > 1000000000
  )
    batchFail("CODING_BATCH_LIMIT");
  const roots = new Set<string>();
  for (const c of v.cases) {
    workflowHostRecord(c, ["id", "spec", "stageWorktrees", "sourcePaths"]);
    workflowIdentifier(c.id);
    const spec = validateWorkflowSpec(c.spec);
    if (
      spec.stages.length !== 3 ||
      spec.stages[0]!.id !== "edit" ||
      spec.stages[0]!.role !== "editor" ||
      spec.stages[1]!.id !== "validate" ||
      spec.stages[1]!.role !== "validator" ||
      spec.stages[2]!.id !== "review" ||
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
export function pinCodingSource(
  path: string,
  maxBytes = 1048576,
): CodingSourcePin {
  let fd: number | undefined;
  try {
    const first = lstatSync(path, { bigint: true });
    if (
      !first.isFile() ||
      first.isSymbolicLink() ||
      first.nlink !== 1n ||
      first.size > BigInt(maxBytes) ||
      realpathSync(path) !== path
    )
      batchFail("CODING_SOURCE_STALE");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true }),
      h = createHash("sha256"),
      buf = Buffer.alloc(16384);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      size += n;
      if (size > maxBytes) batchFail("CODING_SOURCE_STALE");
      h.update(buf.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    if (
      before.dev !== first.dev ||
      before.ino !== first.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs
    )
      batchFail("CODING_SOURCE_STALE");
    return {
      path,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      size,
      sha256: h.digest("hex"),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
