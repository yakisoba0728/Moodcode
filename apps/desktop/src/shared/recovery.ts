export function validateRecoveryInput(input: unknown): {
  fingerprint: string;
  acknowledged: true;
} {
  const invalid = (): never => {
    throw Object.assign(
      new Error(
        "Recovery requires the current diagnostic fingerprint and explicit acknowledgment.",
      ),
      { code: "INVALID_INPUT" },
    );
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["fingerprint", "acknowledged"].includes(key),
    )
  )
    invalid();
  for (const descriptor of Object.values(descriptors))
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
  const fingerprint = descriptors.fingerprint?.value;
  if (
    descriptors.acknowledged?.value !== true ||
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  )
    return invalid();
  return { fingerprint, acknowledged: true };
}
