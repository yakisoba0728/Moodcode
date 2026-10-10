import { rejectDuplicateCodeKeys } from "./source-json.js";
import {
  EngineError,
  type JsonValue,
} from "@moodcode/contracts";
import { sandboxJson, sandboxSign } from "../sandbox/types.js";
export const CODE_MODE_LIMITS = Object.freeze({
  sourceBytes: 16384,
  nodes: 512,
  depth: 12,
  steps: 4096,
  calls: 16,
  rowBytes: 65536,
  resultBytes: 32768,
  records: 128,
  totalBytes: 8388608,
});
export const CODE_MODE_TOOLS = Object.freeze([
  "read_file",
  "list_files",
  "search_files",
  "apply_patch",
  "run_command",
  "verify_changes",
] as const);
export type CodeExpression =
  | { op: "literal"; value: JsonValue }
  | { op: "var"; name: string }
  | { op: "get"; value: CodeExpression; key: string | number }
  | { op: "array"; items: readonly CodeExpression[] }
  | { op: "object"; properties: Readonly<Record<string, CodeExpression>> }
  | {
      op: "concat" | "add" | "equal";
      left: CodeExpression;
      right: CodeExpression;
    };
export type CodeStatement =
  | { op: "let"; name: string; value: CodeExpression }
  | {
      op: "call";
      id: string;
      tool: string;
      input: CodeExpression;
      result: string;
    }
  | {
      op: "if";
      condition: CodeExpression;
      then: readonly CodeStatement[];
      else: readonly CodeStatement[];
    }
  | {
      op: "repeat";
      count: number;
      index: string;
      body: readonly CodeStatement[];
    }
  | { op: "return"; value: CodeExpression };
export interface CodeProgram {
  version: 1;
  statements: readonly CodeStatement[];
}
export interface CodeModeAllocation {
  maxSteps: number;
  maxNestedCalls: number;
  maxResultBytes: number;
  maxDurationMs: number;
}
export function codeModeError(code = "CODE_MODE_INVALID"): never {
  throw new EngineError(
    code,
    "The restricted code-mode source, native owner, runtime or receipt is unavailable or changed",
  );
}
export function codeJson<T>(
  value: T,
  cap: number = CODE_MODE_LIMITS.rowBytes,
): T {
  return sandboxJson(value, cap);
}
export const codeSign = sandboxSign;
const field = (
  value: unknown,
  keys: readonly string[],
): Record<string, any> => {
  const x = value as Record<string, any>;
  if (
    !x ||
    typeof x !== "object" ||
    Array.isArray(x) ||
    Object.keys(x).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(x, k))
  )
    codeModeError();
  return x;
};
function codeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[-A-Za-z0-9_]{1,64}$/.test(value))
    codeModeError();
  return value;
}
export function validateCodeAllocation(value: unknown): CodeModeAllocation {
  const x = field(codeJson(value), [
    "maxSteps",
    "maxNestedCalls",
    "maxResultBytes",
    "maxDurationMs",
  ]);
  for (const [key, max] of Object.entries({
    maxSteps: 4096,
    maxNestedCalls: 16,
    maxResultBytes: 32768,
    maxDurationMs: 30000,
  }))
    if (!Number.isSafeInteger(x[key]) || x[key] < 1 || x[key] > max)
      codeModeError("CODE_MODE_LIMIT");
  return x as unknown as CodeModeAllocation;
}
export function parseCodeProgram(source: unknown): CodeProgram {
  if (
    typeof source !== "string" ||
    source.length > CODE_MODE_LIMITS.sourceBytes ||
    Buffer.byteLength(source) > CODE_MODE_LIMITS.sourceBytes
  )
    codeModeError("CODE_MODE_LIMIT");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    codeModeError();
  }
  rejectDuplicateCodeKeys(source);
  const program = codeJson(value, CODE_MODE_LIMITS.sourceBytes);
  let nodes = 0;
  const charge = (depth: number) => {
    if (++nodes > CODE_MODE_LIMITS.nodes || depth > CODE_MODE_LIMITS.depth)
      codeModeError("CODE_MODE_LIMIT");
  };
  const expression = (v: unknown, depth: number): void => {
    charge(depth);
    const x = v as Record<string, any>;
    switch (x?.op) {
      case "literal":
        field(x, ["op", "value"]);
        break;
      case "var":
        field(x, ["op", "name"]);
        codeIdentifier(x.name);
        break;
      case "get":
        field(x, ["op", "value", "key"]);
        expression(x.value, depth + 1);
        if (typeof x.key === "number") {
          if (!Number.isSafeInteger(x.key) || x.key < 0 || x.key > 1024)
            codeModeError();
        } else {
          codeIdentifier(x.key);
          if (["__proto__", "prototype", "constructor"].includes(x.key))
            codeModeError();
        }
        break;
      case "array":
        field(x, ["op", "items"]);
        if (!Array.isArray(x.items) || x.items.length > 64)
          codeModeError("CODE_MODE_LIMIT");
        x.items.forEach((v) => expression(v, depth + 1));
        break;
      case "object":
        field(x, ["op", "properties"]);
        if (
          !x.properties ||
          typeof x.properties !== "object" ||
          Array.isArray(x.properties) ||
          Object.keys(x.properties).length > 64
        )
          codeModeError();
        for (const [k, v] of Object.entries(x.properties)) {
          codeIdentifier(k);
          expression(v, depth + 1);
        }
        break;
      case "concat":
      case "add":
      case "equal":
        field(x, ["op", "left", "right"]);
        expression(x.left, depth + 1);
        expression(x.right, depth + 1);
        break;
      default:
        codeModeError("CODE_MODE_LANGUAGE_UNSUPPORTED");
    }
  };
  const statements = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || list.length > 64)
      codeModeError("CODE_MODE_LIMIT");
    for (const v of list) {
      charge(depth);
      const x = v as Record<string, any>;
      switch (x?.op) {
        case "let":
          field(x, ["op", "name", "value"]);
          codeIdentifier(x.name);
          expression(x.value, depth + 1);
          break;
        case "call":
          field(x, ["op", "id", "tool", "input", "result"]);
          codeIdentifier(x.id);
          codeIdentifier(x.tool);
          codeIdentifier(x.result);
          if (!(CODE_MODE_TOOLS as readonly string[]).includes(x.tool))
            codeModeError("CODE_MODE_TOOL_UNSUPPORTED");
          expression(x.input, depth + 1);
          break;
        case "if":
          field(x, ["op", "condition", "then", "else"]);
          expression(x.condition, depth + 1);
          statements(x.then, depth + 1);
          statements(x.else, depth + 1);
          break;
        case "repeat":
          field(x, ["op", "count", "index", "body"]);
          if (!Number.isSafeInteger(x.count) || x.count < 0 || x.count > 64)
            codeModeError("CODE_MODE_LIMIT");
          codeIdentifier(x.index);
          statements(x.body, depth + 1);
          break;
        case "return":
          field(x, ["op", "value"]);
          expression(x.value, depth + 1);
          break;
        default:
          codeModeError("CODE_MODE_LANGUAGE_UNSUPPORTED");
      }
    }
  };
  const root = field(program, ["version", "statements"]);
  if (root.version !== 1) codeModeError("CODE_MODE_LANGUAGE_UNSUPPORTED");
  statements(root.statements, 0);
  return program as CodeProgram;
}
export interface CodeModeRuntimeCapability {
  version: 1;
  registrationId: string;
  language: "moodcode-json-v1";
  backend: "darwin-seatbelt-v1";
  available: boolean;
  fileIsolation: boolean;
  networkIsolation: boolean;
  processIsolation: boolean;
  platform: string;
  osRelease: string;
  profileSha256: string;
  executableSha256: string;
  workerSha256: string;
  trustedSourceSha256: string;
  evidenceSha256: string | null;
  code: string | null;
  sha256: string;
}
