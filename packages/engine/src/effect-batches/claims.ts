import { EngineError } from "@moodcode/contracts";
import type { PreparedTool, ToolContext, ToolDefinition } from "../ports.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { PreparedResourceClaim } from "./types.js";
interface Claim {
  proof: PreparedResourceClaim;
  physical: object;
  fresh(signal: AbortSignal): Promise<void>;
}
const producers = new WeakMap<
  ToolDefinition,
  (prepared: PreparedTool) => object | null
>();
const claims = new WeakMap<object, Claim>();
const permits = new WeakMap<
  object,
  {
    claim: object;
    context: ToolContext;
    assert(): void;
    used: boolean;
    cleanup: boolean | null;
  }
>();
export function registerPreparedResourceProducer(
  tool: ToolDefinition,
  capture: (prepared: PreparedTool) => object | null,
): void {
  producers.set(tool, capture);
}
export function hasPreparedResourceProducer(tool: ToolDefinition): boolean {
  return producers.has(tool);
}
export function capturePreparedResource(
  tool: ToolDefinition,
  prepared: PreparedTool,
): object | null {
  return producers.get(tool)?.(prepared) ?? null;
}
export function issuePreparedPatchResource(
  proof: Omit<PreparedResourceClaim, "sha256">,
  physical: object,
  fresh: Claim["fresh"],
): object {
  const original = Object.freeze(Object.create(null));
  claims.set(original, {
    proof: Object.freeze({ ...proof, sha256: knowledgeHash(proof) }),
    physical,
    fresh,
  });
  return original;
}
export function readPreparedResource(original: object): PreparedResourceClaim {
  const c = claims.get(original);
  if (!c)
    throw new EngineError(
      "EFFECT_RESOURCE_ORIGINAL_REQUIRED",
      "Original prepared resource required",
    );
  return structuredClone(c.proof);
}
export async function assertPreparedResourceCurrent(
  original: object,
  signal: AbortSignal,
): Promise<void> {
  const c = claims.get(original);
  if (!c)
    throw new EngineError(
      "EFFECT_RESOURCE_ORIGINAL_REQUIRED",
      "Original prepared resource required",
    );
  await c.fresh(signal);
}
export function conflictingResources(
  a: PreparedResourceClaim | null,
  b: PreparedResourceClaim | null,
): boolean {
  if (
    !a ||
    !b ||
    a.workspaceId !== b.workspaceId ||
    a.root !== b.root ||
    a.rootDevice !== b.rootDevice ||
    a.rootInode !== b.rootInode
  )
    return true;
  return a.files.some((x) =>
    b.files.some(
      (y) =>
        (x.device === y.device && x.inode === y.inode) ||
        x.path.toLowerCase() === y.path.toLowerCase() ||
        x.path.toLowerCase().startsWith(y.path.toLowerCase() + "/") ||
        y.path.toLowerCase().startsWith(x.path.toLowerCase() + "/"),
    ),
  );
}
export function issueResourcePermit(
  originalClaim: object,
  context: ToolContext,
  assert: () => void,
): object {
  if (!claims.has(originalClaim))
    throw new EngineError(
      "EFFECT_RESOURCE_ORIGINAL_REQUIRED",
      "Original prepared resource required",
    );
  assert();
  const permit = Object.freeze(Object.create(null));
  permits.set(permit, {
    claim: originalClaim,
    context,
    assert,
    used: false,
    cleanup: null,
  });
  return permit;
}
export function consumeResourcePermit(
  original: object,
  context: ToolContext,
  physical: object,
): void {
  const p = permits.get(original);
  if (
    !p ||
    p.context !== context ||
    p.used ||
    claims.get(p.claim)?.physical !== physical ||
    context.signal.aborted
  )
    throw new EngineError(
      "EFFECT_RESOURCE_PERMIT_STALE",
      "Original current resource permit required",
    );
  p.assert();
  p.used = true;
}
export function settleResourcePermit(
  original: object,
  context: ToolContext,
  physical: object,
  cleanupConfirmed: boolean,
): void {
  const p = permits.get(original);
  if (!p || p.context !== context || claims.get(p.claim)?.physical !== physical)
    throw new EngineError(
      "EFFECT_RESOURCE_PERMIT_STALE",
      "Original resource completion required",
    );
  p.cleanup = cleanupConfirmed === true;
}
export function readResourcePermitCleanup(original: object): boolean | null {
  return permits.get(original)?.cleanup ?? null;
}

export function resourcePermitConsumed(original: object): boolean {
  return permits.get(original)?.used === true;
}

export function planPreparedResources(
  members: readonly {
    providerCallId: string;
    claim: PreparedResourceClaim | null;
  }[],
) {
  let wave = 0;
  const selected: { claim: PreparedResourceClaim | null; wave: number }[] = [];
  for (const m of members) {
    if (
      selected.some(
        (p) => p.wave === wave && conflictingResources(p.claim, m.claim),
      )
    )
      wave++;
    selected.push({ claim: m.claim, wave });
    if (!m.claim) wave++;
  }
  return {
    waves: selected.map((m) => m.wave),
    mode: selected.some((m, i) =>
      selected.some((n, j) => i !== j && m.wave === n.wave),
    )
      ? ("parallel" as const)
      : ("serial" as const),
    fallback: members
      .filter((m) => !m.claim)
      .map((m) => `${m.providerCallId}:unproved-resource-serial`),
  };
}
