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
/** A seed chooses bounded payloads, not random sleeps or weaker assertions. */
export function resolveResilienceOptions(
  input: ResilienceOptions = {},
): ResolvedResilienceOptions {
  for (const key of Object.keys(input))
    if (!["profile", "iterations", "seed", "boundaryTimeoutMs"].includes(key))
      throw new RangeError("Unknown resilience option");
  const profile = input.profile ?? "quick";
  if (profile !== "quick" && profile !== "extended")
    throw new RangeError("Profile must be quick or extended");
  const iterations = input.iterations ?? (profile === "quick" ? 3 : 12);
  const seed = input.seed ?? 20261009;
  const boundaryTimeoutMs = input.boundaryTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(iterations) || iterations < 3 || iterations > 60)
    throw new RangeError("Iterations must be between 3 and 60");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError("Seed must be a uint32");
  if (
    !Number.isSafeInteger(boundaryTimeoutMs) ||
    boundaryTimeoutMs < 1000 ||
    boundaryTimeoutMs > 30000
  )
    throw new RangeError("Boundary timeout must be between 1000 and 30000 ms");
  return { profile, iterations, seed, boundaryTimeoutMs };
}
export function scenarioAt(iteration: number): ResilienceScenario {
  return (["complete", "cancel", "root-sigkill"] as const)[iteration % 3]!;
}
export function iterationSeed(seed: number, iteration: number): number {
  return (seed ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0;
}
