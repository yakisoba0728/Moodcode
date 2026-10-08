import type { ToolDefinition } from "../ports.js";

const catalogues = new WeakMap<object, readonly ToolDefinition[]>();

/** Only the owned child constructor receives the root's fixed, scoped handlers. */
export function bindChildTeamModelCatalogue(
  options: object,
  tools: readonly ToolDefinition[],
): void {
  if (tools.length) catalogues.set(options, tools);
}

export function consumeChildTeamModelCatalogue(
  options: object,
): readonly ToolDefinition[] {
  const tools = catalogues.get(options) ?? [];
  catalogues.delete(options);
  return tools;
}
