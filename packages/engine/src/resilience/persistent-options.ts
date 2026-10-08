export interface PersistentSoakOptions {
  profile?: "quick" | "long";
  durationMs?: number;
  maxCycles?: number;
  maxInputs?: number;
  maxInputBytes?: number;
  payloadBytes?: number;
  seed?: number;
  maxSamples?: number;
  boundaryTimeoutMs?: number;
}
export interface ResolvedPersistentSoakOptions extends Required<PersistentSoakOptions> {}
export function resolvePersistentSoakOptions(
  input: PersistentSoakOptions = {},
): ResolvedPersistentSoakOptions {
  const allowed = [
    "profile",
    "durationMs",
    "maxCycles",
    "maxInputs",
    "maxInputBytes",
    "payloadBytes",
    "seed",
    "maxSamples",
    "boundaryTimeoutMs",
  ];
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new RangeError("Unknown persistent soak option");
  const profile = input.profile ?? "quick";
  if (profile !== "quick" && profile !== "long")
    throw new RangeError("Profile must be quick or long");
  const maxCycles = input.maxCycles ?? (profile === "quick" ? 6 : 10000);
  const result = {
    profile,
    durationMs: input.durationMs ?? (profile === "quick" ? 1000 : 1800000),
    maxCycles,
    maxInputs: input.maxInputs ?? maxCycles * 4 + 4,
    maxInputBytes: input.maxInputBytes ?? 67_108_864,
    payloadBytes: input.payloadBytes ?? 1024,
    seed: input.seed ?? 20261009,
    maxSamples: input.maxSamples ?? 128,
    boundaryTimeoutMs: input.boundaryTimeoutMs ?? 10000,
  };
  const bounds = {
    durationMs: [1000, 28_800_000],
    maxCycles: [3, 50000],
    maxInputs: [16, 200004],
    maxInputBytes: [1024, 134_217_728],
    payloadBytes: [64, 8192],
    seed: [0, 0xffffffff],
    maxSamples: [8, 256],
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
  if (result.maxInputBytes < result.payloadBytes * 16)
    throw new RangeError(
      "Input byte ceiling must reserve three cycles and the crash checkpoint",
    );
  return result;
}
