import { EngineError } from "@moodcode/contracts";

const gates = new WeakMap<object, Promise<void>>();

/** The original child handle releases provider work after durable task admission. */
export function holdChildProviderAdmission(engine: object): () => void {
  if (gates.has(engine))
    throw new EngineError(
      "CHILD_ADMISSION_CONFLICT",
      "Child provider admission is already held",
    );
  let resolve!: () => void;
  gates.set(
    engine,
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolve();
    gates.delete(engine);
  };
}

export function waitChildProviderAdmission(
  engine: object,
  signal: AbortSignal,
): Promise<void> | undefined {
  const gate = gates.get(engine);
  if (!gate) return;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        signal.reason ??
          new EngineError(
            "CANCELLED",
            "Child provider admission was cancelled",
          ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    gate.then(() => finish());
  });
}
