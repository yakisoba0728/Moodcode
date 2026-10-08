import { EngineError } from "@moodcode/contracts";

interface AdmissionGate {
  promise: Promise<void>;
  release(): void;
}
const gates = new WeakMap<object, AdmissionGate>();

/** The original child handle releases provider work after durable task admission. */
export function holdChildProviderAdmission(engine: object): () => void {
  if (gates.has(engine))
    throw new EngineError(
      "CHILD_ADMISSION_CONFLICT",
      "Child provider admission is already held",
    );
  let resolve!: () => void;
  const gate: AdmissionGate = {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    release: () => {},
  };
  let released = false;
  gate.release = () => {
    if (released) return;
    released = true;
    resolve();
    gates.delete(engine);
  };
  gates.set(engine, gate);
  return gate.release;
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
    gate.promise.then(
      () => finish(),
      (error) => finish(error),
    );
  });
}
