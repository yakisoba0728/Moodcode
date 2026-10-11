import { rejectDuplicateJsonKeys } from "../code-mode/source-json.js";
import type {
  AcpV1Id,
  AcpV1InitializeParams,
  AcpV1InitializeResult,
  AcpV1Message,
  AcpV1NegotiatedCapabilities,
  AcpV1NewSessionParams,
  AcpV1NewSessionResult,
  AcpV1LoadSessionParams,
  AcpV1LoadSessionResult,
  AcpV1PromptParams,
  AcpV1PromptResult,
  AcpV1ReadTextFileParams,
  AcpV1ReadTextFileResult,
  AcpV1SessionUpdate,
} from "./types.js";
import {
  AGENT_BACKEND_LIMITS,
  agentBackendAbsolutePath,
  agentBackendError,
  agentBackendIdentifier,
  agentBackendInteger,
  agentBackendJson,
  agentBackendObject,
  agentBackendSigned,
  agentBackendText,
} from "./validation.js";

export const ACP_PROTOCOL_VERSION = 1 as const;
function validateAcpV1Id(value: unknown): AcpV1Id {
  if (typeof value === "number")
    return agentBackendInteger(value, Number.MAX_SAFE_INTEGER, 0);
  return agentBackendIdentifier(value);
}
function metadata(value: unknown): void {
  if (value === undefined) return;
  const result = agentBackendJson(value, AGENT_BACKEND_LIMITS.metadataBytes);
  if (!result || typeof result !== "object" || Array.isArray(result))
    agentBackendError("ACP_INVALID_MESSAGE");
}
function bools(input: unknown, names: readonly string[]): void {
  const value = agentBackendObject(input, [], names);
  if (Object.values(value).some((item) => typeof item !== "boolean"))
    agentBackendError("ACP_INVALID_MESSAGE");
}
function info(input: unknown): void {
  const value = agentBackendObject(
    input,
    ["name", "version"],
    ["title", "_meta"],
  );
  agentBackendIdentifier(value.name);
  agentBackendIdentifier(value.version);
  if (value.title !== undefined) agentBackendText(value.title, 256);
  metadata(value._meta);
}
function unsupported(method: string): never {
  return agentBackendError(
    method === "fs/write_text_file" || method.startsWith("terminal/")
      ? "ACP_EFFECT_UNSUPPORTED"
      : "ACP_METHOD_UNSUPPORTED",
  );
}
function content(input: unknown, cap: number): void {
  const value = agentBackendObject(
    input,
    ["type", "text"],
    ["annotations", "_meta"],
  );
  if (value.type !== "text") agentBackendError("ACP_CONTENT_UNSUPPORTED");
  agentBackendText(value.text, cap, true);
  metadata(value.annotations);
  metadata(value._meta);
}
export function validateAcpV1InitializeParams(
  input: unknown,
): AcpV1InitializeParams {
  const value = agentBackendObject(
    input,
    ["protocolVersion", "clientCapabilities"],
    ["clientInfo", "_meta"],
  );
  if (value.protocolVersion !== ACP_PROTOCOL_VERSION)
    agentBackendError("ACP_VERSION_UNSUPPORTED");
  const caps = agentBackendObject(value.clientCapabilities, ["fs", "terminal"]);
  const fs = agentBackendObject(caps.fs, ["readTextFile", "writeTextFile"]);
  if (
    typeof fs.readTextFile !== "boolean" ||
    typeof fs.writeTextFile !== "boolean" ||
    typeof caps.terminal !== "boolean"
  )
    agentBackendError("ACP_EFFECT_UNSUPPORTED");
  if (value.clientInfo !== undefined) info(value.clientInfo);
  metadata(value._meta);
  return value as unknown as AcpV1InitializeParams;
}
function validateAcpV1InitializeResult(input: unknown): AcpV1InitializeResult {
  const value = agentBackendObject(
    input,
    ["protocolVersion", "agentCapabilities"],
    ["agentInfo", "authMethods", "_meta"],
  );
  if (value.protocolVersion !== ACP_PROTOCOL_VERSION)
    agentBackendError("ACP_VERSION_UNSUPPORTED");
  const caps = agentBackendObject(
    value.agentCapabilities,
    [],
    [
      "loadSession",
      "promptCapabilities",
      "mcpCapabilities",
      "sessionCapabilities",
      "_meta",
    ],
  );
  if (caps.loadSession !== undefined && typeof caps.loadSession !== "boolean")
    agentBackendError("ACP_INVALID_MESSAGE");
  if (caps.promptCapabilities !== undefined)
    bools(caps.promptCapabilities, ["image", "audio", "embeddedContext"]);
  if (caps.mcpCapabilities !== undefined)
    bools(caps.mcpCapabilities, ["http", "sse"]);
  metadata(caps.sessionCapabilities);
  metadata(caps._meta);
  metadata(value._meta);
  if (value.agentInfo !== undefined) info(value.agentInfo);
  if (value.authMethods !== undefined) {
    if (
      !Array.isArray(value.authMethods) ||
      value.authMethods.length > AGENT_BACKEND_LIMITS.authMethods
    )
      agentBackendError("AGENT_BACKEND_LIMIT");
    const ids = new Set<string>();
    for (const method of value.authMethods) {
      const item = agentBackendObject(
        method,
        ["id", "name"],
        ["description", "_meta"],
      );
      const id = agentBackendIdentifier(item.id);
      if (ids.has(id)) agentBackendError("ACP_INVALID_MESSAGE");
      ids.add(id);
      agentBackendIdentifier(item.name);
      if (item.description !== undefined)
        agentBackendText(item.description, 2048, true);
      metadata(item._meta);
    }
  }
  return value as unknown as AcpV1InitializeResult;
}
export function negotiateAcpV1Capabilities(
  input: unknown,
  host: {
    readonly readTextFile?: boolean;
    readonly writeTextFile?: boolean;
    readonly terminal?: boolean;
    readonly loadSession?: boolean;
    readonly contextOwner?: "engine" | "agent";
  } = {},
): AcpV1NegotiatedCapabilities {
  const result = validateAcpV1InitializeResult(input);
  const local = agentBackendObject(
    host,
    [],
    [
      "readTextFile",
      "writeTextFile",
      "terminal",
      "loadSession",
      "contextOwner",
    ],
  );
  if (
    local.readTextFile !== undefined &&
    typeof local.readTextFile !== "boolean"
  )
    agentBackendError("ACP_INVALID_MESSAGE");
  if (
    Object.entries(local).some(([key, value]) =>
      key === "contextOwner"
        ? value !== "engine" && value !== "agent"
        : typeof value !== "boolean",
    )
  )
    agentBackendError("ACP_INVALID_MESSAGE");
  if (result.authMethods?.length) agentBackendError("ACP_AUTH_UNSUPPORTED");
  const body = {
    protocol: "acp" as const,
    protocolVersion: 1 as const,
    contextOwner: (local.contextOwner ?? "engine") as "engine" | "agent",
    text: true as const,
    readTextFile: local.readTextFile === true,
    writeTextFile: local.writeTextFile === true,
    terminal: local.terminal === true,
    loadSession:
      local.loadSession === true &&
      result.agentCapabilities.loadSession === true,
  };
  return agentBackendSigned(body, AGENT_BACKEND_LIMITS.frameBytes);
}
function validateAcpV1NewSessionParams(input: unknown): AcpV1NewSessionParams {
  const value = agentBackendObject(input, ["cwd", "mcpServers"], ["_meta"]);
  agentBackendAbsolutePath(value.cwd);
  if (!Array.isArray(value.mcpServers) || value.mcpServers.length !== 0)
    agentBackendError("ACP_MCP_UNSUPPORTED");
  metadata(value._meta);
  return value as unknown as AcpV1NewSessionParams;
}
function validateAcpV1PromptParams(input: unknown): AcpV1PromptParams {
  const value = agentBackendObject(input, ["sessionId", "prompt"], ["_meta"]);
  agentBackendIdentifier(value.sessionId);
  if (
    !Array.isArray(value.prompt) ||
    value.prompt.length === 0 ||
    value.prompt.length > AGENT_BACKEND_LIMITS.promptBlocks
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  for (const item of value.prompt)
    content(item, AGENT_BACKEND_LIMITS.contentBytes);
  if (
    Buffer.byteLength(JSON.stringify(value.prompt)) >
    AGENT_BACKEND_LIMITS.contentBytes
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  metadata(value._meta);
  return value as unknown as AcpV1PromptParams;
}
export function validateAcpV1ReadTextFileParams(
  input: unknown,
): AcpV1ReadTextFileParams {
  const value = agentBackendObject(
    input,
    ["sessionId", "path"],
    ["line", "limit", "_meta"],
  );
  agentBackendIdentifier(value.sessionId);
  agentBackendAbsolutePath(value.path);
  if (value.line !== undefined && value.line !== null)
    agentBackendInteger(value.line, Number.MAX_SAFE_INTEGER, 1);
  if (value.limit !== undefined && value.limit !== null)
    agentBackendInteger(value.limit, AGENT_BACKEND_LIMITS.readLines, 1);
  const line = value.line ?? 1,
    limit = value.limit ?? AGENT_BACKEND_LIMITS.readLines;
  if ((line as number) > Number.MAX_SAFE_INTEGER - (limit as number) + 1)
    agentBackendError("AGENT_BACKEND_LIMIT");
  metadata(value._meta);
  return value as unknown as AcpV1ReadTextFileParams;
}
/** Exact wire effects only; terminal env and remote server grants remain unsupported. */
export function validateAcpV1WriteTextFileParams(
  input: unknown,
): import("./types.js").AcpV1WriteTextFileParams {
  const value = agentBackendObject(
    input,
    ["sessionId", "path", "content"],
    ["_meta"],
  );
  agentBackendIdentifier(value.sessionId);
  agentBackendAbsolutePath(value.path);
  agentBackendText(value.content, 16384, true);
  metadata(value._meta);
  return value as unknown as import("./types.js").AcpV1WriteTextFileParams;
}
export function validateAcpV1TerminalCreateParams(
  input: unknown,
): import("./types.js").AcpV1TerminalCreateParams {
  const value = agentBackendObject(
    input,
    ["sessionId", "command"],
    ["args", "cwd", "outputByteLimit", "env", "_meta"],
  );
  agentBackendIdentifier(value.sessionId);
  agentBackendText(value.command, 8192);
  if ((value.command as string).includes("\0"))
    agentBackendError("ACP_INVALID_MESSAGE");
  if (value.cwd !== undefined) agentBackendAbsolutePath(value.cwd);
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 64)
      agentBackendError("AGENT_BACKEND_LIMIT");
    for (const arg of value.args) agentBackendText(arg, 2048, true);
  }
  if (
    value.env !== undefined &&
    (!Array.isArray(value.env) || value.env.length)
  )
    agentBackendError("ACP_ENV_UNSUPPORTED");
  if (value.outputByteLimit !== undefined)
    agentBackendInteger(value.outputByteLimit, 16384, 1);
  metadata(value._meta);
  return value as unknown as import("./types.js").AcpV1TerminalCreateParams;
}
export function validateAcpV1PermissionParams(
  input: unknown,
): import("./types.js").AcpV1PermissionParams {
  const value = agentBackendObject(
    input,
    ["sessionId", "toolCall", "options"],
    ["_meta"],
  );
  agentBackendIdentifier(value.sessionId);
  const call = agentBackendObject(
    value.toolCall,
    ["toolCallId", "rawInput"],
    ["title", "name", "kind", "status", "locations", "content", "_meta"],
  );
  agentBackendIdentifier(call.toolCallId);
  const raw = agentBackendObject(call.rawInput, ["method", "params"]);
  if (raw.method !== "fs/write_text_file" && raw.method !== "terminal/create")
    agentBackendError("ACP_PERMISSION_UNSUPPORTED");
  const params =
    raw.method === "fs/write_text_file"
      ? validateAcpV1WriteTextFileParams(raw.params)
      : validateAcpV1TerminalCreateParams(raw.params);
  if (params.sessionId !== value.sessionId)
    agentBackendError("BACKEND_REMOTE_SESSION_INVALID");
  if (
    !Array.isArray(value.options) ||
    value.options.length < 1 ||
    value.options.length > 8
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  const ids = new Set<string>();
  for (const option of value.options) {
    const o = agentBackendObject(
      option,
      ["optionId", "name", "kind"],
      ["_meta"],
    );
    const id = agentBackendIdentifier(o.optionId);
    if (
      ids.has(id) ||
      !["allow_once", "allow_always", "reject_once", "reject_always"].includes(
        o.kind as string,
      )
    )
      agentBackendError("ACP_INVALID_MESSAGE");
    ids.add(id);
    agentBackendText(o.name, 256);
    metadata(o._meta);
  }
  metadata(value._meta);
  return value as unknown as import("./types.js").AcpV1PermissionParams;
}
export function validateAcpV1SessionUpdate(input: unknown): AcpV1SessionUpdate {
  const value = agentBackendObject(input, ["sessionId", "update"], ["_meta"]);
  agentBackendIdentifier(value.sessionId);
  metadata(value._meta);
  if (
    !value.update ||
    typeof value.update !== "object" ||
    Array.isArray(value.update)
  )
    agentBackendError("ACP_INVALID_MESSAGE");
  const kind = (value.update as Record<string, unknown>).sessionUpdate;
  if (
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "user_message_chunk"
  ) {
    const update = agentBackendObject(
      value.update,
      ["sessionUpdate", "content"],
      ["messageId", "_meta"],
    );
    content(update.content, AGENT_BACKEND_LIMITS.chunkBytes);
    if (update.messageId !== undefined && update.messageId !== null)
      agentBackendIdentifier(update.messageId);
    metadata(update._meta);
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    const update = agentBackendObject(
      value.update,
      kind === "tool_call"
        ? ["sessionUpdate", "toolCallId", "title"]
        : ["sessionUpdate", "toolCallId"],
      [
        "title",
        "name",
        "kind",
        "status",
        "content",
        "locations",
        "rawInput",
        "rawOutput",
        "_meta",
      ],
    );
    agentBackendIdentifier(update.toolCallId);
    if (update.title !== undefined) agentBackendText(update.title, 2048, true);
    if (update.name !== undefined && update.name !== null)
      agentBackendIdentifier(update.name);
    if (
      update.kind !== undefined &&
      ![
        "read",
        "edit",
        "delete",
        "move",
        "search",
        "execute",
        "think",
        "fetch",
        "switch_mode",
        "other",
      ].includes(update.kind as string)
    )
      agentBackendError("ACP_INVALID_MESSAGE");
    if (
      update.status !== undefined &&
      !["pending", "in_progress", "completed", "failed"].includes(
        update.status as string,
      )
    )
      agentBackendError("ACP_INVALID_MESSAGE");
    if (
      Buffer.byteLength(JSON.stringify(update)) >
      AGENT_BACKEND_LIMITS.contentBytes
    )
      agentBackendError("AGENT_BACKEND_LIMIT");
    if (
      (update.content !== undefined && !Array.isArray(update.content)) ||
      (update.locations !== undefined && !Array.isArray(update.locations))
    )
      agentBackendError("ACP_INVALID_MESSAGE");
    metadata(update._meta);
  } else agentBackendError("ACP_UPDATE_UNSUPPORTED");
  return value as unknown as AcpV1SessionUpdate;
}
export function validateAcpV1Request(
  method: "initialize",
  input: unknown,
): AcpV1InitializeParams;
export function validateAcpV1Request(
  method: "session/new",
  input: unknown,
): AcpV1NewSessionParams;
export function validateAcpV1Request(
  method: "session/load",
  input: unknown,
): AcpV1LoadSessionParams;
export function validateAcpV1Request(
  method: "session/prompt",
  input: unknown,
): AcpV1PromptParams;
export function validateAcpV1Request(
  method: "fs/read_text_file",
  input: unknown,
): AcpV1ReadTextFileParams;
export function validateAcpV1Request(
  method: "session/update",
  input: unknown,
): AcpV1SessionUpdate;
export function validateAcpV1Request(method: string, input: unknown): object;
export function validateAcpV1Request(method: string, input: unknown): object {
  switch (method) {
    case "initialize":
      return validateAcpV1InitializeParams(input);
    case "session/new":
      return validateAcpV1NewSessionParams(input);
    case "session/load": {
      const value = agentBackendObject(
        input,
        ["sessionId", "cwd", "mcpServers"],
        ["_meta"],
      );
      agentBackendIdentifier(value.sessionId);
      validateAcpV1NewSessionParams({
        cwd: value.cwd,
        mcpServers: value.mcpServers,
        ...(value._meta === undefined ? {} : { _meta: value._meta }),
      });
      return value;
    }
    case "session/prompt":
      return validateAcpV1PromptParams(input);
    case "fs/read_text_file":
      return validateAcpV1ReadTextFileParams(input);
    case "fs/write_text_file":
      return validateAcpV1WriteTextFileParams(input);
    case "terminal/create":
      return validateAcpV1TerminalCreateParams(input);
    case "session/request_permission":
      return validateAcpV1PermissionParams(input);
    case "terminal/output":
    case "terminal/wait_for_exit":
    case "terminal/kill":
    case "terminal/release": {
      const value = agentBackendObject(
        input,
        ["sessionId", "terminalId"],
        ["_meta"],
      );
      agentBackendIdentifier(value.sessionId);
      agentBackendIdentifier(value.terminalId);
      metadata(value._meta);
      return value;
    }
    case "session/update":
      return validateAcpV1SessionUpdate(input);
    case "session/cancel": {
      const value = agentBackendObject(input, ["sessionId"], ["_meta"]);
      agentBackendIdentifier(value.sessionId);
      metadata(value._meta);
      return value;
    }
    default:
      return unsupported(method);
  }
}
export function validateAcpV1Result(
  method: "initialize",
  input: unknown,
): AcpV1InitializeResult;
export function validateAcpV1Result(
  method: "session/new",
  input: unknown,
): AcpV1NewSessionResult;
export function validateAcpV1Result(
  method: "session/load",
  input: unknown,
): AcpV1LoadSessionResult;
export function validateAcpV1Result(
  method: "session/prompt",
  input: unknown,
): AcpV1PromptResult;
export function validateAcpV1Result(
  method: "fs/read_text_file",
  input: unknown,
): AcpV1ReadTextFileResult;
export function validateAcpV1Result(method: string, input: unknown): object;
export function validateAcpV1Result(method: string, input: unknown): object {
  switch (method) {
    case "initialize":
      return validateAcpV1InitializeResult(input);
    case "session/new": {
      const value = agentBackendObject(input, ["sessionId"], ["_meta"]);
      agentBackendIdentifier(value.sessionId);
      metadata(value._meta);
      return value;
    }
    case "session/load": {
      const value = agentBackendObject(input, [], ["_meta"]);
      metadata(value._meta);
      return value;
    }
    case "session/prompt": {
      const value = agentBackendObject(input, ["stopReason"], ["_meta"]);
      if (
        ![
          "end_turn",
          "max_tokens",
          "max_turn_requests",
          "refusal",
          "cancelled",
        ].includes(value.stopReason as string)
      )
        agentBackendError("ACP_COMPLETION_INVALID");
      metadata(value._meta);
      return value;
    }
    case "fs/read_text_file": {
      const value = agentBackendObject(input, ["content"], ["_meta"]);
      agentBackendText(value.content, AGENT_BACKEND_LIMITS.contentBytes, true);
      metadata(value._meta);
      return value;
    }
    case "fs/write_text_file":
    case "terminal/kill":
    case "terminal/release": {
      const value = agentBackendObject(input, [], ["_meta"]);
      metadata(value._meta);
      return value;
    }
    case "terminal/create": {
      const value = agentBackendObject(input, ["terminalId"], ["_meta"]);
      agentBackendIdentifier(value.terminalId);
      metadata(value._meta);
      return value;
    }
    case "terminal/output": {
      const value = agentBackendObject(
        input,
        ["output", "truncated"],
        ["exitStatus", "_meta"],
      );
      agentBackendText(value.output, 16384, true);
      if (typeof value.truncated !== "boolean")
        agentBackendError("ACP_INVALID_MESSAGE");
      if (value.exitStatus !== undefined)
        validateAcpV1Result("terminal/wait_for_exit", value.exitStatus);
      metadata(value._meta);
      return value;
    }
    case "terminal/wait_for_exit": {
      const value = agentBackendObject(
        input,
        [],
        ["exitCode", "signal", "_meta"],
      );
      if (value.exitCode !== undefined && value.exitCode !== null)
        agentBackendInteger(value.exitCode, 2147483647, 0);
      if (value.signal !== undefined && value.signal !== null)
        agentBackendText(value.signal, 64);
      if (value.exitCode === undefined && value.signal === undefined)
        agentBackendError("ACP_INVALID_MESSAGE");
      metadata(value._meta);
      return value;
    }
    case "session/request_permission": {
      const value = agentBackendObject(input, ["outcome"], ["_meta"]),
        outcome = agentBackendObject(value.outcome, ["outcome"], ["optionId"]);
      if (outcome.outcome === "selected") {
        agentBackendIdentifier(outcome.optionId);
      } else if (
        outcome.outcome !== "cancelled" ||
        outcome.optionId !== undefined
      )
        agentBackendError("ACP_INVALID_MESSAGE");
      metadata(value._meta);
      return value;
    }
    default:
      return unsupported(method);
  }
}

export function validateAcpV1Message(input: unknown): AcpV1Message {
  const value = agentBackendObject(
    input,
    ["jsonrpc"],
    ["id", "method", "params", "result", "error"],
  );
  if (value.jsonrpc !== "2.0") agentBackendError("ACP_INVALID_MESSAGE");
  if (Object.hasOwn(value, "method")) {
    agentBackendObject(value, ["jsonrpc", "method"], ["id", "params"]);
    agentBackendIdentifier(value.method);
    if (Object.hasOwn(value, "id")) validateAcpV1Id(value.id);
    if (
      value.params !== undefined &&
      (!value.params ||
        typeof value.params !== "object" ||
        Array.isArray(value.params))
    )
      agentBackendError("ACP_INVALID_MESSAGE");
  } else {
    if (
      !Object.hasOwn(value, "id") ||
      Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
    )
      agentBackendError("ACP_INVALID_MESSAGE");
    if (Object.hasOwn(value, "error")) {
      agentBackendObject(value, ["jsonrpc", "id", "error"]);
      if (value.id !== null) validateAcpV1Id(value.id);
      const error = agentBackendObject(
        value.error,
        ["code", "message"],
        ["data"],
      );
      agentBackendInteger(
        error.code,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      );
      agentBackendText(error.message, 2048, true);
    } else {
      agentBackendObject(value, ["jsonrpc", "id", "result"]);
      validateAcpV1Id(value.id);
    }
  }
  return value as unknown as AcpV1Message;
}
export function parseAcpV1Message(input: string | Uint8Array): AcpV1Message {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof Uint8Array) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return agentBackendError("ACP_INVALID_UTF8");
    }
  } else return agentBackendError("ACP_INVALID_MESSAGE");
  if (
    Buffer.byteLength(text) > AGENT_BACKEND_LIMITS.frameBytes ||
    Buffer.from(text).toString("utf8") !== text
  )
    agentBackendError("AGENT_BACKEND_LIMIT");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (text.includes("\n") || text.includes("\r"))
    agentBackendError("ACP_INVALID_FRAME");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return agentBackendError("ACP_INVALID_MESSAGE");
  }
  rejectDuplicateJsonKeys(text, {
    maxDepth: 12,
    maxNodes: 4096,
    fail: (kind) =>
      agentBackendError(
        {
          limit: "AGENT_BACKEND_LIMIT",
          duplicate: "ACP_DUPLICATE_KEY",
          invalid: "ACP_INVALID_MESSAGE",
        }[kind],
      ),
  });
  return validateAcpV1Message(parsed);
}
export function encodeAcpV1Message(input: unknown): string {
  const result = JSON.stringify(validateAcpV1Message(input)) + "\n";
  if (Buffer.byteLength(result) > AGENT_BACKEND_LIMITS.frameBytes)
    agentBackendError("AGENT_BACKEND_LIMIT");
  return result;
}
