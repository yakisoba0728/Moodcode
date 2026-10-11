export type ResilienceProfile = "quick" | "extended";
export type ResilienceScenario = "complete" | "cancel" | "root-sigkill";
export interface ResilienceOptions {
  profile?: ResilienceProfile;
  iterations?: number;
  seed?: number;
  boundaryTimeoutMs?: number;
}
export interface ResolvedResilienceOptions {
  profile: ResilienceProfile;
  iterations: number;
  seed: number;
  boundaryTimeoutMs: number;
}
/** A seed chooses bounded fixture payloads. */
export function resolveResilienceOptions(
  input: ResilienceOptions = {},
): ResolvedResilienceOptions {
  const profile = input.profile ?? "quick";
  const result = {
    profile,
    iterations: input.iterations ?? (profile === "quick" ? 3 : 12),
    seed: input.seed ?? 20261009,
    boundaryTimeoutMs: input.boundaryTimeoutMs ?? 10000,
  };
  for (const key of Object.keys(input))
    if (!Object.hasOwn(result, key))
      throw new RangeError("Unknown resilience option");
  if (profile !== "quick" && profile !== "extended")
    throw new RangeError("Profile must be quick or extended");
  const bounds = {
    iterations: [3, 60],
    seed: [0, 0xffffffff],
    boundaryTimeoutMs: [1000, 30000],
  } as const;
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const [min, max] = bounds[key];
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] < min ||
      result[key] > max
    )
      throw new RangeError(
        `${key} must be an integer between ${min} and ${max}`,
      );
  }
  return result;
}
export function scenarioAt(iteration: number): ResilienceScenario {
  return (["complete", "cancel", "root-sigkill"] as const)[iteration % 3]!;
}
export function iterationSeed(seed: number, iteration: number): number {
  return (seed ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0;
}
