import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { headerValue } from './http.js';
import { object } from './protocol.js';
export interface HeaderProjection { name: string; path: string[]; type: 'string' | 'integer' | 'boolean' }
/** A deliberately small schema feature: annotations elsewhere make a definition unusable over modern HTTP. */
export function schemaHeaders(schema: JsonObject): HeaderProjection[] {
  const projections: HeaderProjection[] = []; const names = new Set<string>();
  function visit(value: JsonValue, path: string[], reachable: boolean, depth: number): void {
    if (depth > 64) throw new EngineError('MCP_INVALID_TOOL_SCHEMA', 'MCP tool schema is too deep');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, path, false, depth + 1); return; }
    if (Object.hasOwn(value, 'x-mcp-header')) {
      const name = value['x-mcp-header']; const type = value.type;
      if (!reachable || path.length === 0 || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,128}$/.test(name) || names.has(name.toLowerCase()) || !['string', 'integer', 'boolean'].includes(String(type))) throw new EngineError('MCP_INVALID_TOOL_SCHEMA', 'MCP x-mcp-header annotation is invalid or unreachable');
      names.add(name.toLowerCase()); projections.push({ name: `Mcp-Param-${name}`, path: [...path], type: type as HeaderProjection['type'] });
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'properties' && object(item) && reachable) for (const [property, child] of Object.entries(item)) visit(child, [...path, property], true, depth + 1);
      else if (key !== 'x-mcp-header') visit(item, path, false, depth + 1);
    }
  }
  visit(schema, [], true, 0); return projections;
}
export function projectHeaders(projections: readonly HeaderProjection[], input: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const projection of projections) {
    let value: JsonValue | undefined = input;
    for (const part of projection.path) { if (!object(value) || !Object.hasOwn(value, part)) { value = undefined; break; } value = value[part]; }
    if (value === undefined || value === null) continue;
    if (projection.type === 'string' && typeof value !== 'string' || projection.type === 'boolean' && typeof value !== 'boolean' || projection.type === 'integer' && !Number.isSafeInteger(value)) throw new EngineError('MCP_INVALID_TOOL_ARGUMENT', 'MCP header-annotated argument has the wrong primitive type');
    headers[projection.name] = headerValue(String(value));
  }
  return headers;
}
