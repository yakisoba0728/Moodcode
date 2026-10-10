import { isAbsolute, resolve } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { normalizeSubmitInput } from "@moodcode/contracts/validation";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type {
  AgentBackendCredentialReference,
  AgentBackendLaunch,
  AgentBackendSessionLoad,
  AgentBackendSpec,
  AgentBackendTargetPin,
} from "./types.js";

export const AGENT_BACKEND_LIMITS = Object.freeze({
  specBytes: 32768,
  frameBytes: 65536,
  contentBytes: 32768,
  chunkBytes: 16384,
  metadataBytes: 8192,
  args: 64,
  argumentBytes: 4096,
  sources: 32,
  environmentReferences: 16,
  tools: 128,
  promptBlocks: 32,
  readLines: 2000,
  requestIdBytes: 256,
  authMethods: 16,
});
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ALLOCATION_KEYS = [
  "maxTurns",
  "maxToolCalls",
  "maxOutputBytes",
  "maxDurationMs",
] as const;
export function agentBackendError(code = "INVALID_AGENT_BACKEND"): never {
  throw new EngineError(
    code,
    "Agent backends require bounded ACP v1 data and ORIGINAL host execution proofs",
  );
}
/** Reject proxies, accessors, custom serializers and cyclic/oversized JSON without evaluating them. */
export function agentBackendJson<T>(
  input: T,
  cap: number = AGENT_BACKEND_LIMITS.frameBytes,
): T {
  try {
    const result = immutableKnowledgeJson(input);
    if (Buffer.byteLength(JSON.stringify(result)) > cap)
      agentBackendError("AGENT_BACKEND_LIMIT");
    return result;
  } catch (error) {
    if (
      error instanceof EngineError &&
      (error.code.startsWith("AGENT_BACKEND_") || error.code.startsWith("ACP_"))
    )
      throw error;
    return agentBackendError(
      error instanceof EngineError && error.code === "KNOWLEDGE_LIMIT"
        ? "AGENT_BACKEND_LIMIT"
        : "INVALID_AGENT_BACKEND",
    );
  }
}
export function agentBackendObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = agentBackendJson(input);
  if (!result || typeof result !== "object" || Array.isArray(result))
    agentBackendError();
  const value = result as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    agentBackendError();
  return value;
}
export function agentBackendText(
  input: unknown,
  cap = 256,
  empty = false,
): string {
  if (
    typeof input !== "string" ||
    (!empty && !input) ||
    input.includes("\0") ||
    Buffer.byteLength(input) > cap ||
    Buffer.from(input).toString("utf8") !== input
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  return input;
}
export function agentBackendIdentifier(input: unknown): string {
  const result = agentBackendText(input);
  if (CONTROL.test(result)) agentBackendError();
  return result;
}
export function agentBackendSha(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input))
    agentBackendError();
  return input;
}
export function agentBackendInteger(
  input: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  return input;
}
export function agentBackendAbsolutePath(input: unknown): string {
  const value = agentBackendText(input, 4096);
  if (!isAbsolute(value) || resolve(value) !== value || CONTROL.test(value))
    agentBackendError("AGENT_BACKEND_PATH_INVALID");
  return value;
}
function audienceText(input: unknown, code?: string): string {
  const value = agentBackendText(input, 2048);
  if (CONTROL.test(value)) agentBackendError(code);
  return value;
}
function credential(input: unknown): AgentBackendCredentialReference {
  const value = agentBackendObject(input, ["id", "audience"]);
  const id = agentBackendIdentifier(value.id),
    audience = audienceText(value.audience, "AGENT_BACKEND_CREDENTIAL_INVALID");
  if (!/^host:[A-Za-z0-9_.-]{1,128}$/u.test(id))
    agentBackendError("AGENT_BACKEND_CREDENTIAL_INVALID");
  return { id, audience };
}
export function validateAgentBackendTarget(
  input: unknown,
): AgentBackendTargetPin {
  const value = agentBackendObject(input, [
    "workspaceId",
    "sessionId",
    "workspaceBindingSha256",
    "capabilitiesSha256",
    "catalogueSha256",
    "profile",
    "config",
    "runConfigSha256",
    "tools",
    "allocation",
  ]);
  const config = agentBackendObject(
    value.config,
    ["providerId", "modelId", "mode", "limits", "budgets"],
    ["reasoningEffort", "agentProfileId", "agentProfileRevision"],
  );
  let normalized: AgentBackendTargetPin["config"];
  try {
    normalized = normalizeSubmitInput({
      sessionId: value.sessionId,
      requestId: "backend-validation",
      prompt: "validate",
      config,
    }).config as AgentBackendTargetPin["config"];
  } catch {
    return agentBackendError("AGENT_BACKEND_CONFIG_INVALID");
  }
  if (
    !normalized.budgets ||
    knowledgeHash(normalized) !== knowledgeHash(config) ||
    agentBackendSha(value.runConfigSha256) !== knowledgeHash(normalized)
  )
    agentBackendError("AGENT_BACKEND_CONFIG_INCOMPLETE");
  let profile: AgentBackendTargetPin["profile"] = null;
  if (value.profile !== null) {
    const pin = agentBackendObject(value.profile, ["id", "revision"]);
    profile = {
      id: agentBackendIdentifier(pin.id),
      revision: agentBackendSha(pin.revision),
    };
  }
  if (
    profile
      ? normalized.agentProfileId !== profile.id ||
        normalized.agentProfileRevision !== profile.revision
      : normalized.agentProfileId !== undefined ||
        normalized.agentProfileRevision !== undefined
  )
    agentBackendError("AGENT_BACKEND_PROFILE_MISMATCH");
  if (
    !Array.isArray(value.tools) ||
    value.tools.length > AGENT_BACKEND_LIMITS.tools
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  const tools = value.tools.map(agentBackendIdentifier).sort();
  if (new Set(tools).size !== tools.length) agentBackendError();
  const allocation = agentBackendObject(value.allocation, ALLOCATION_KEYS);
  const limits = normalized.limits;
  for (const key of ALLOCATION_KEYS)
    if (
      agentBackendInteger(allocation[key], Number.MAX_SAFE_INTEGER, 1) !==
      limits[key]
    )
      agentBackendError("AGENT_BACKEND_ALLOCATION_MISMATCH");
  return agentBackendJson({
    workspaceId: agentBackendIdentifier(value.workspaceId),
    sessionId: agentBackendIdentifier(value.sessionId),
    workspaceBindingSha256: agentBackendSha(value.workspaceBindingSha256),
    capabilitiesSha256: agentBackendSha(value.capabilitiesSha256),
    catalogueSha256: agentBackendSha(value.catalogueSha256),
    profile,
    config: normalized,
    runConfigSha256: knowledgeHash(normalized),
    tools,
    allocation: Object.fromEntries(
      ALLOCATION_KEYS.map((key) => [key, limits[key]]),
    ) as AgentBackendTargetPin["allocation"],
  });
}
export function validateAgentBackendLaunch(input: unknown): AgentBackendLaunch {
  const launch = agentBackendObject(input, [
    "kind",
    "command",
    "args",
    "cwd",
    "sourceFiles",
    "envReferences",
  ]);
  if (launch.kind !== "stdio")
    agentBackendError("AGENT_BACKEND_TRANSPORT_UNSUPPORTED");
  if (
    !Array.isArray(launch.args) ||
    launch.args.length > AGENT_BACKEND_LIMITS.args ||
    !Array.isArray(launch.sourceFiles) ||
    launch.sourceFiles.length > AGENT_BACKEND_LIMITS.sources ||
    !Array.isArray(launch.envReferences) ||
    launch.envReferences.length > AGENT_BACKEND_LIMITS.environmentReferences
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  const args = launch.args.map((item) =>
    agentBackendText(item, AGENT_BACKEND_LIMITS.argumentBytes, true),
  );
  const sourceFiles = launch.sourceFiles.map(agentBackendAbsolutePath).sort();
  if (new Set(sourceFiles).size !== sourceFiles.length) agentBackendError();
  const envReferences = launch.envReferences
    .map((item) => {
      const entry = agentBackendObject(item, ["name", "reference"]),
        name = agentBackendIdentifier(entry.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name))
        agentBackendError("AGENT_BACKEND_CREDENTIAL_INVALID");
      return { name, reference: credential(entry.reference) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (
    new Set(envReferences.map((item) => item.name)).size !==
    envReferences.length
  )
    agentBackendError();
  return agentBackendJson({
    kind: "stdio",
    command: agentBackendAbsolutePath(launch.command),
    args,
    cwd: agentBackendAbsolutePath(launch.cwd),
    sourceFiles,
    envReferences,
  });
}
export function validateAgentBackendSpec(input: unknown): AgentBackendSpec {
  const value = agentBackendObject(
    agentBackendJson(input, AGENT_BACKEND_LIMITS.specBytes),
    [
      "schemaVersion",
      "id",
      "description",
      "protocol",
      "protocolVersion",
      "contextOwner",
      "launch",
      "credentialReference",
      "endpointAudience",
      "target",
    ],
    ["sha256", "sessionLoad"],
  );
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== "acp" ||
    value.protocolVersion !== 1
  )
    agentBackendError("ACP_VERSION_UNSUPPORTED");
  if (value.contextOwner !== "engine" && value.contextOwner !== "agent")
    agentBackendError("AGENT_BACKEND_CONTEXT_UNSUPPORTED");
  let sessionLoad: AgentBackendSessionLoad | undefined;
  if (value.contextOwner === "agent") {
    const selected = agentBackendObject(value.sessionLoad, [
      "sourceBackendId",
      "sourceBackendRevisionId",
      "sourceRequestId",
      "sourceRequestRevisionId",
      "sourceRequestSha256",
      "sourceConnectionId",
      "sourceConnectionRevisionId",
      "sourceConnectionSha256",
      "remoteSessionId",
    ]);
    sessionLoad = agentBackendJson({
      sourceBackendId: agentBackendIdentifier(selected.sourceBackendId),
      sourceBackendRevisionId: agentBackendIdentifier(
        selected.sourceBackendRevisionId,
      ),
      sourceRequestId: agentBackendIdentifier(selected.sourceRequestId),
      sourceRequestRevisionId: agentBackendIdentifier(
        selected.sourceRequestRevisionId,
      ),
      sourceRequestSha256: agentBackendSha(selected.sourceRequestSha256),
      sourceConnectionId: agentBackendIdentifier(selected.sourceConnectionId),
      sourceConnectionRevisionId: agentBackendIdentifier(
        selected.sourceConnectionRevisionId,
      ),
      sourceConnectionSha256: agentBackendSha(selected.sourceConnectionSha256),
      remoteSessionId: agentBackendIdentifier(selected.remoteSessionId),
    });
    if (sessionLoad.sourceBackendId === value.id)
      agentBackendError("AGENT_BACKEND_LOAD_ALIAS_REQUIRED");
  } else if (value.sessionLoad !== undefined)
    agentBackendError("AGENT_BACKEND_CONTEXT_UNSUPPORTED");
  const launch = validateAgentBackendLaunch(value.launch);
  const endpointAudience = audienceText(value.endpointAudience);
  const credentialReference =
    value.credentialReference === null
      ? null
      : credential(value.credentialReference);
  if (
    (credentialReference &&
      credentialReference.audience !== endpointAudience) ||
    launch.envReferences.some(
      (item) => item.reference.audience !== endpointAudience,
    )
  )
    agentBackendError("AGENT_BACKEND_CREDENTIAL_AUDIENCE_MISMATCH");
  const body = {
    schemaVersion: 1 as const,
    id: agentBackendIdentifier(value.id),
    description: agentBackendText(value.description, 2048, true),
    protocol: "acp" as const,
    protocolVersion: 1 as const,
    contextOwner: value.contextOwner as "engine" | "agent",
    ...(sessionLoad ? { sessionLoad } : {}),
    launch,
    credentialReference,
    endpointAudience,
    target: validateAgentBackendTarget(value.target),
  };
  if (body.target.config.providerId !== `acp:${body.id}`)
    agentBackendError("AGENT_BACKEND_PROVIDER_MISMATCH");
  const sha256 = knowledgeHash(body);
  if (value.sha256 !== undefined && agentBackendSha(value.sha256) !== sha256)
    agentBackendError("AGENT_BACKEND_HASH_MISMATCH");
  return agentBackendJson({ ...body, sha256 }, AGENT_BACKEND_LIMITS.specBytes);
}
