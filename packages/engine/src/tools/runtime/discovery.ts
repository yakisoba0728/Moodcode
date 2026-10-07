import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';

export const TOOL_DISCOVERY_LIMITS = Object.freeze({
  defaultSelectedTools: 8, maxSelectedTools: 32, maxVisibleTools: 256,
  defaultSchemaBytes: 128 * 1024, maxSchemaBytes: 1024 * 1024,
  maxQueryBytes: 256, maxResults: 8, maxCandidates: 4096, maxMetadataBytes: 512 * 1024,
});
export interface ToolDiscoveryPolicy {
  kind: 'bounded-tool-discovery'; version: 1;
  alwaysVisibleToolNames?: readonly string[];
  maxSelectedTools?: number; maxSchemaBytes?: number;
}
export interface ResolvedToolDiscoveryPolicy extends ToolDiscoveryPolicy { maxSelectedTools: number; maxSchemaBytes: number }
export interface ToolDiscoveryMetadata {
  name: string; description: string; schemaSha256: string; definitionSha256: string;
  schemaBytes: number; definitionBytes: number;
}
export interface ToolDiscoveryCatalogue {
  scopeId: string; revision: number; policyVersion: number; mode: 'plan' | 'build';
  tools: readonly ToolDiscoveryMetadata[];
}
export interface ToolDiscoveryMaterializeLimits { maxTools: number; maxBytes: number }
export const DEFAULT_TOOL_DISCOVERY_POLICY: Readonly<ResolvedToolDiscoveryPolicy> = Object.freeze({
  kind: 'bounded-tool-discovery', version: 1,
  maxSelectedTools: TOOL_DISCOVERY_LIMITS.defaultSelectedTools,
  maxSchemaBytes: TOOL_DISCOVERY_LIMITS.defaultSchemaBytes,
});
function fail(code: string): never { throw new EngineError(code, 'Tool discovery requires bounded, unchanged data and a current catalogue'); }
function plain(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(code);
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !('value' in field)) fail(code);
    output[key] = field.value;
  }
  return output;
}
function integer(value: unknown, maximum: number, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(code);
  return value as number;
}
function array(value: unknown, maximum: number, code: string): unknown[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const length = integer(Object.getOwnPropertyDescriptor(value, 'length')?.value, maximum, code);
  if (Reflect.ownKeys(value).length !== length + 1) fail(code);
  const output: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) fail(code);
    output.push(field.value);
  }
  return output;
}
export function validateDiscoveryNames(value: unknown, code = 'INVALID_TOOL_DISCOVERY_POLICY', maximum = TOOL_DISCOVERY_LIMITS.maxVisibleTools): string[] {
  const result = array(value, maximum, code);
  const names: string[] = [];
  for (const item of result) {
    if (typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(item)) fail(code);
    names.push(item);
  }
  if (new Set(names).size !== names.length) fail(code);
  return names;
}
export function validateToolDiscoveryPolicy(value: unknown = DEFAULT_TOOL_DISCOVERY_POLICY): ResolvedToolDiscoveryPolicy {
  const code = 'INVALID_TOOL_DISCOVERY_POLICY';
  const input = plain(value, ['kind', 'version', 'alwaysVisibleToolNames', 'maxSelectedTools', 'maxSchemaBytes'], code);
  if (input.kind !== 'bounded-tool-discovery' || input.version !== 1) fail(code);
  const names = input.alwaysVisibleToolNames === undefined ? undefined : validateDiscoveryNames(input.alwaysVisibleToolNames);
  return Object.freeze({ kind: 'bounded-tool-discovery', version: 1,
    ...(names === undefined ? {} : { alwaysVisibleToolNames: Object.freeze(names) }),
    maxSelectedTools: input.maxSelectedTools === undefined ? TOOL_DISCOVERY_LIMITS.defaultSelectedTools : integer(input.maxSelectedTools, TOOL_DISCOVERY_LIMITS.maxSelectedTools, code),
    maxSchemaBytes: input.maxSchemaBytes === undefined ? TOOL_DISCOVERY_LIMITS.defaultSchemaBytes : integer(input.maxSchemaBytes, TOOL_DISCOVERY_LIMITS.maxSchemaBytes, code, 1),
  });
}
export function validateDiscoveryMaterializeLimits(value: unknown): ToolDiscoveryMaterializeLimits {
  const code = 'TOOL_DISCOVERY_LIMIT';
  const input = plain(value, ['maxTools', 'maxBytes'], code);
  return { maxTools: integer(input.maxTools, TOOL_DISCOVERY_LIMITS.maxVisibleTools, code), maxBytes: integer(input.maxBytes, TOOL_DISCOVERY_LIMITS.maxSchemaBytes, code) };
}
export function validateDiscoveryQuery(query: unknown, limit: unknown): { query: string; limit: number } {
  const code = 'INVALID_TOOL_DISCOVERY_QUERY';
  if (typeof query !== 'string' || Buffer.byteLength(query) > TOOL_DISCOVERY_LIMITS.maxQueryBytes || /[\u0000-\u001f\u007f]/.test(query) || !query.trim()) fail(code);
  return { query: query.trim().toLowerCase(), limit: integer(limit, TOOL_DISCOVERY_LIMITS.maxResults, code, 1) };
}
/** Descriptor inspection avoids invoking caller accessors or proxy traps. No schema occurs in this signature. */
export function discoveryCatalogueSignature(value: unknown): string {
  const code = 'TOOL_DISCOVERY_STALE';
  const input = plain(value, ['scopeId', 'revision', 'policyVersion', 'mode', 'tools'], code);
  if (typeof input.scopeId !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(input.scopeId) || (input.mode !== 'plan' && input.mode !== 'build')) fail(code);
  integer(input.revision, Number.MAX_SAFE_INTEGER, code); integer(input.policyVersion, Number.MAX_SAFE_INTEGER, code);
  const candidates = array(input.tools, TOOL_DISCOVERY_LIMITS.maxCandidates, code);
  const tools: ToolDiscoveryMetadata[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ scopeId: input.scopeId, revision: input.revision, policyVersion: input.policyVersion, mode: input.mode, tools: [] }));
  for (const candidate of candidates) {
    const metadata = plain(candidate, ['name', 'description', 'schemaSha256', 'definitionSha256', 'schemaBytes', 'definitionBytes'], code);
    if (typeof metadata.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(metadata.name) || typeof metadata.description !== 'string' || Buffer.byteLength(metadata.description) > 8192) fail(code);
    if (typeof metadata.schemaSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.schemaSha256) || typeof metadata.definitionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.definitionSha256)) fail(code);
    const tool = { name: metadata.name, description: metadata.description, schemaSha256: metadata.schemaSha256, definitionSha256: metadata.definitionSha256,
      schemaBytes: integer(metadata.schemaBytes, 64 * 1024, code, 2), definitionBytes: integer(metadata.definitionBytes, TOOL_DISCOVERY_LIMITS.maxSchemaBytes, code, 2) };
    bytes += Buffer.byteLength(JSON.stringify(tool)) + (tools.length ? 1 : 0);
    if (bytes > TOOL_DISCOVERY_LIMITS.maxMetadataBytes) fail(code);
    tools.push(tool);
  }
  return JSON.stringify({ scopeId: input.scopeId, revision: input.revision, policyVersion: input.policyVersion, mode: input.mode, tools });
}
