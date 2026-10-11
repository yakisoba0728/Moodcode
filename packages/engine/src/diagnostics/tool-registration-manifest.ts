import { EngineError } from "@moodcode/contracts";
import type { ToolEffectClass } from "../permission/policy.js";
import { jsonTextSha256 } from "../shared/canonical.js";
import { isSha256, plainRecord } from "../shared/data.js";

/** Detached observations cannot be used as a prepared tool or producer capability. */
export interface ToolRegistrationObservation {
  readonly scopeId: string;
  readonly name: string;
  readonly registryRevision: number;
  readonly policyRevision: number;
  readonly registrationRevision: number;
  readonly registrationSha256: string;
  readonly effectClass: ToolEffectClass;
  readonly exactApproval: boolean;
  readonly schemaSha256: string;
  readonly schemaBytes: number;
  readonly descriptionSha256: string;
  readonly descriptionBytes: number;
}
export interface ToolRegistrationManifest extends ToolRegistrationObservation {
  readonly schemaVersion: 1;
  readonly projection: "tool-registration-manifest-v1";
  readonly authority: "observation-only";
  readonly manifestSha256: string;
}
const keys = [
  "scopeId",
  "name",
  "registryRevision",
  "policyRevision",
  "registrationRevision",
  "registrationSha256",
  "effectClass",
  "exactApproval",
  "schemaSha256",
  "schemaBytes",
  "descriptionSha256",
  "descriptionBytes",
];
function fail(): never {
  throw new EngineError(
    "INVALID_TOOL_REGISTRATION_MANIFEST",
    "Tool registration observations must be bounded plain metadata",
  );
}
/** Validates only detached data. It never consults a registry, policy or producer. */
export function createToolRegistrationManifest(
  input: ToolRegistrationObservation,
): ToolRegistrationManifest {
  const record = plainRecord(input, keys, [], fail);
  const data: Record<string, unknown> = {};
  for (const key of keys) data[key] = record[key];
  for (const key of ["scopeId", "name"])
    if (
      typeof data[key] !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(data[key] as string)
    )
      fail();
  for (const key of [
    "registryRevision",
    "policyRevision",
    "registrationRevision",
  ])
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) fail();
  if (
    (data.registrationRevision as number) < 1 ||
    (data.registrationRevision as number) > (data.registryRevision as number)
  )
    fail();
  for (const key of ["registrationSha256", "schemaSha256", "descriptionSha256"])
    if (!isSha256(data[key])) fail();
  if (
    !["read", "state", "write", "execute", "network", "unknown"].includes(
      data.effectClass as string,
    ) ||
    typeof data.exactApproval !== "boolean"
  )
    fail();
  if (
    !Number.isSafeInteger(data.schemaBytes) ||
    (data.schemaBytes as number) < 2 ||
    (data.schemaBytes as number) > 65_536 ||
    !Number.isSafeInteger(data.descriptionBytes) ||
    (data.descriptionBytes as number) < 0 ||
    (data.descriptionBytes as number) > 8_192
  )
    fail();
  const projection = {
    schemaVersion: 1 as const,
    projection: "tool-registration-manifest-v1" as const,
    authority: "observation-only" as const,
    ...(data as unknown as ToolRegistrationObservation),
  };
  return Object.freeze({
    ...projection,
    manifestSha256: jsonTextSha256(projection),
  });
}
