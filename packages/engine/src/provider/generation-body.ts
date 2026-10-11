import { EngineError } from '@moodcode/contracts';

/** True when the operation fulfils within the timeout; rejection or timeout is false. */
export async function settles(operation: Promise<unknown>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Preserve actual transport cleanup, even when a reader ignores cancellation. */
export function boundedGenerationBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, timeoutMs: number): { stream: ReadableStream<Uint8Array>; close(): Promise<boolean> } {
  const reader = body.getReader();
  let closing: Promise<boolean> | undefined;
  const close = () => closing ??= (async () => {
    const clean = await settles(Promise.resolve().then(() => reader.cancel()), timeoutMs);
    try { reader.releaseLock(); } catch { return false; }
    return clean;
  })();
  const read = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => { reject(new EngineError('PROVIDER_CANCELLED', 'Provider generation cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const item = await read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await close(); },
  });
  return { stream, close };
}
