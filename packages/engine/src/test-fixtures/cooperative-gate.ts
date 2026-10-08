/** Fixture providers resolve on abort; callers retain their post-abort checks. */
export async function cooperativeGateOrAbort(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let listener!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((done) => {
        listener = done;
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) done();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
