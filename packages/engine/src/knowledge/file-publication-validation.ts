import {
  exactKnowledgePath,
  identifier,
  integer,
  knowledgeError,
  knowledgeHash,
  sameKnowledge,
  sha256,
  stamp,
  validateBinding,
} from "./validation.js";
import { plainJson, type PlainJsonFault } from "../shared/data.js";
import { workspaceWritePath } from "../workspace/index.js";
import type {
  FilePhysicalObservation,
  FilePublicationCheckpoint,
  KnowledgeFileTarget,
  PrepareKnowledgeFilePublication,
} from "./file-publication-types.js";

export const KNOWLEDGE_FILE_PUBLICATION_LIMITS = Object.freeze({
  rowBytes: 65536,
  checkpointBytes: 1048576,
  bodyBytes: 16384,
  beforeBytes: 131072,
  pageBytes: 1048576,
  pageRows: 32,
  parents: 32,
  owners: 128,
});
function jsonFault(fault: PlainJsonFault): never {
  switch (fault) {
    case "structure":
      return knowledgeError(
        "KNOWLEDGE_FILE_LIMIT",
        "File publication JSON structure is too large",
      );
    case "bytes":
    case "text":
      return knowledgeError(
        "KNOWLEDGE_FILE_LIMIT",
        "File publication text must be bounded UTF-8",
      );
    case "items":
    case "holes":
      return knowledgeError(
        "KNOWLEDGE_FILE_LIMIT",
        "File publication arrays must be dense and bounded",
      );
    case "element":
      return knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Sparse file publication array",
      );
    case "prototype":
      return knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "File publication rejects custom prototypes",
      );
    case "symbol":
    case "accessor":
      return knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "File publication rejects accessors and symbols",
      );
    case "property":
      return knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "File publication rejects hidden or prototype properties",
      );
    default:
      return knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "File publication requires detached plain JSON",
      );
  }
}
/** Copy descriptors before invoking any SQL/host port. No executable properties or aliases survive. */
export function filePublicationJson<T>(
  input: T,
  maxBytes: number = KNOWLEDGE_FILE_PUBLICATION_LIMITS.rowBytes,
): T {
  const result = plainJson(input, {
    maxBytes,
    maxNodes: 8192,
    maxDepth: 24,
    maxItems: 256,
    accounting: "text",
    wellFormed: true,
    rejectKeys: ["__proto__"],
    freeze: true,
    fail: jsonFault,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    knowledgeError(
      "KNOWLEDGE_FILE_LIMIT",
      "Serialized file publication exceeds its byte bound",
    );
  return result;
}
export function fileFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "File publication requires a plain object",
    );
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "File publication fields differ from the contract",
    );
}
export function fileDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Expected exact SHA-256",
    );
  return value;
}
function decimal(value: unknown, signed = false): void {
  if (
    typeof value !== "string" ||
    !(signed ? /^-?\d{1,32}$/u : /^\d{1,32}$/u).test(value)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Physical file metadata must be bounded decimal text",
    );
}
export function filePath(value: unknown): string {
  const path = exactKnowledgePath(value);
  if (
    workspaceWritePath(
      path,
      "INVALID_KNOWLEDGE_FILE_PATH",
      "File publication path is unsafe or exceeds its cap",
    ).length > 32
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PATH",
      "File publication path is unsafe or exceeds its cap",
    );
  return path;
}
export function fileText(value: unknown, cap: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > cap ||
    value.includes("\0") ||
    Buffer.from(value).toString("utf8") !== value
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "File content must be bounded plain UTF-8 text",
    );
  return value;
}
export function validateFilePhysicalObservation(
  input: unknown,
): FilePhysicalObservation {
  const v = filePublicationJson(input);
  fileFields(v, [
    "binding",
    "path",
    "present",
    "sha256",
    "bytes",
    "device",
    "inode",
    "mode",
    "mtimeNs",
    "ctimeNs",
    "parentPins",
    "missingParents",
  ]);
  const binding = validateBinding(v.binding),
    path = filePath(v.path);
  integer(v.bytes, KNOWLEDGE_FILE_PUBLICATION_LIMITS.beforeBytes);
  if (
    typeof v.present !== "boolean" ||
    !Array.isArray(v.parentPins) ||
    v.parentPins.length < 1 ||
    v.parentPins.length > 32 ||
    !Array.isArray(v.missingParents) ||
    v.missingParents.length > 31
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Invalid physical file observation",
    );
  if (v.present) {
    fileDigest(v.sha256);
    decimal(v.device);
    decimal(v.inode);
    integer(v.mode, 0o177777);
    decimal(v.mtimeNs, true);
    decimal(v.ctimeNs, true);
    if (v.missingParents.length)
      knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "A present file cannot have missing parents",
      );
  } else if (
    v.bytes !== 0 ||
    [v.sha256, v.device, v.inode, v.mode, v.mtimeNs, v.ctimeNs].some(
      (item) => item !== null,
    )
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Absent file observations cannot invent physical metadata",
    );
  const parents = [
    ".",
    ...path
      .split("/")
      .slice(0, -1)
      .map((_, index, pieces) => pieces.slice(0, index + 1).join("/")),
  ];
  for (const [index, pin] of v.parentPins.entries()) {
    fileFields(pin, ["path", "device", "inode", "mode", "mtimeNs", "ctimeNs"]);
    if (pin.path !== parents[index])
      knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Parent observations must follow the exact canonical path",
      );
    decimal(pin.device);
    decimal(pin.inode);
    integer(pin.mode, 0o177777);
    decimal(pin.mtimeNs, true);
    decimal(pin.ctimeNs, true);
  }
  const parentCount = v.parentPins.length;
  if (
    parentCount + v.missingParents.length !== parents.length ||
    v.missingParents.some(
      (item, index) => item !== parents[parentCount + index],
    )
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Missing parents must be an exact suffix of the target path",
    );
  const first = v.parentPins[0] as Record<string, unknown>;
  if (first.device !== binding.rootDevice || first.inode !== binding.rootInode)
    knowledgeError(
      "KNOWLEDGE_BINDING_MISMATCH",
      "Physical parent root differs from its workspace binding",
    );
  return v as unknown as FilePhysicalObservation;
}
/** Native head identity: parents keep device/inode/mode but not timestamps, which unrelated sibling entries change. */
export function sameFileHead(
  a: FilePhysicalObservation,
  b: FilePhysicalObservation,
): boolean {
  const stable = (value: FilePhysicalObservation) => ({
    ...value,
    parentPins: value.parentPins.map(({ path, device, inode, mode }) => ({
      path,
      device,
      inode,
      mode,
    })),
  });
  return sameKnowledge(stable(a), stable(b));
}
export function validateKnowledgeFileTarget(
  input: unknown,
): KnowledgeFileTarget {
  const v = filePublicationJson(input);
  fileFields(v, [
    "workspaceId",
    "path",
    "revision",
    "observationId",
    "observationSha256",
    "observation",
  ]);
  identifier(v.workspaceId);
  filePath(v.path);
  integer(v.revision);
  fileDigest(v.observationSha256);
  const o = validateFilePhysicalObservation(v.observation);
  if (
    v.workspaceId !== o.binding.workspaceId ||
    v.path !== o.path ||
    v.observationSha256 !== knowledgeHash(o) ||
    (v.revision === 0) !== (v.observationId === null) ||
    (v.revision === 0 && o.present)
  )
    knowledgeError(
      "KNOWLEDGE_FILE_TARGET_INVALID",
      "Target does not match its actual physical observation and native revision",
    );
  if (v.observationId !== null) identifier(v.observationId);
  return v as unknown as KnowledgeFileTarget;
}
export function validateFilePublicationCheckpoint(
  input: unknown,
): FilePublicationCheckpoint {
  const v = filePublicationJson(input);
  fileFields(v, [
    "createdParents",
    "createdFiles",
    "removedFiles",
    "replacedFiles",
    "partial",
  ]);
  for (const key of [
    "createdParents",
    "createdFiles",
    "removedFiles",
    "replacedFiles",
  ] as const) {
    const values = v[key];
    if (
      !Array.isArray(values) ||
      values.length > 64 ||
      new Set(values).size !== values.length
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Effect checkpoint paths must be unique bounded arrays",
      );
    values.forEach(filePath);
  }
  if (typeof v.partial !== "boolean")
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Checkpoint partial flag must be explicit",
    );
  return v as unknown as FilePublicationCheckpoint;
}
export function validatePrepareKnowledgeFilePublication(
  input: unknown,
): PrepareKnowledgeFilePublication {
  const v = filePublicationJson(
    input,
    KNOWLEDGE_FILE_PUBLICATION_LIMITS.checkpointBytes,
  );
  fileFields(v, [
    "workspaceId",
    "requestId",
    "operation",
    "binding",
    "path",
    "expectedTarget",
    "provenance",
    "existingPublicationId",
    "existingPublicationSha256",
    "body",
    "bodySha256",
    "beforeContent",
    "expiresAt",
    "deadline",
  ]);
  identifier(v.workspaceId);
  identifier(v.requestId);
  const binding = validateBinding(v.binding),
    target = validateKnowledgeFileTarget(v.expectedTarget);
  filePath(v.path);
  stamp(v.expiresAt);
  integer(v.deadline, 8_640_000_000_000_000);
  fileFields(v.provenance, [
    "candidateId",
    "candidateSha256",
    "generationId",
    "generationSha256",
    "attemptId",
    "attemptSha256",
    "planId",
    "planSha256",
    "trustRevisionId",
    "trustRevisionSha256",
  ]);
  for (const [key, value] of Object.entries(v.provenance))
    key.endsWith("Sha256") ? fileDigest(value) : identifier(value);
  if (
    binding.workspaceId !== v.workspaceId ||
    target.workspaceId !== v.workspaceId ||
    target.path !== v.path ||
    !sameKnowledge(binding, target.observation.binding)
  )
    knowledgeError(
      "KNOWLEDGE_FILE_SCOPE_MISMATCH",
      "File publication scope/binding disagrees",
    );
  if (target.observation.present) {
    fileText(v.beforeContent, KNOWLEDGE_FILE_PUBLICATION_LIMITS.beforeBytes);
    if (
      sha256(v.beforeContent as string) !== target.observation.sha256 ||
      Buffer.byteLength(v.beforeContent as string) !== target.observation.bytes
    )
      knowledgeError(
        "KNOWLEDGE_FILE_TARGET_INVALID",
        "Captured before content does not match its actual preimage",
      );
  } else if (v.beforeContent !== null)
    knowledgeError(
      "KNOWLEDGE_FILE_TARGET_INVALID",
      "Absent target cannot carry a before body",
    );
  if (v.operation === "publish") {
    fileText(v.body, KNOWLEDGE_FILE_PUBLICATION_LIMITS.bodyBytes);
    fileDigest(v.bodySha256);
    if (
      sha256(v.body as string) !== v.bodySha256 ||
      v.existingPublicationId !== null ||
      v.existingPublicationSha256 !== null
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Publish requires its exact candidate body",
      );
  } else if (v.operation === "revoke") {
    identifier(v.existingPublicationId);
    fileDigest(v.existingPublicationSha256);
    if (v.body !== null || v.bodySha256 !== null || !target.observation.present)
      knowledgeError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Revocation requires an actual present published target and null postimage",
      );
  } else
    knowledgeError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Unknown file publication operation",
    );
  return v as unknown as PrepareKnowledgeFilePublication;
}
