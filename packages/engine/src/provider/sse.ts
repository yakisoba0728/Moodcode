import { EngineError } from '@moodcode/contracts';

export interface SseLimits { maxFrameBytes: number; maxResponseBytes: number }

const malformed = () => new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider returned an invalid SSE stream.');

/** Parse bytes, not decoded network chunks: UTF-8 and CRLF may cross reads. */
export async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, limits: SseLimits): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let lineBuffer = new Uint8Array(Math.min(4096, limits.maxFrameBytes));
  let lineBytes = 0;
  let frameBytes = 0;
  let responseBytes = 0;
  let pendingCr = false;
  let firstLine = true;
  let data: string[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const checkAbort = () => {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
  };
  function account(bytes: number) {
    frameBytes += bytes;
    if (frameBytes > limits.maxFrameBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider SSE frame exceeds the byte limit.');
  }
  function append(part: Uint8Array) {
    account(part.length);
    const required = lineBytes + part.length;
    if (required > lineBuffer.length) {
      const replacement = new Uint8Array(Math.min(limits.maxFrameBytes, Math.max(required, lineBuffer.length * 2)));
      replacement.set(lineBuffer.subarray(0, lineBytes));
      lineBuffer = replacement;
    }
    lineBuffer.set(part, lineBytes);
    lineBytes = required;
  }
  function line(): string | undefined {
    let value: string;
    try { value = decoder.decode(lineBuffer.subarray(0, lineBytes)); } catch { throw malformed(); }
    lineBytes = 0;
    if (firstLine) { value = value.replace(/^\uFEFF/, ''); firstLine = false; }
    if (value === '') {
      const frame = data.length === 0 ? undefined : data.join('\n');
      data = [];
      frameBytes = 0;
      return frame;
    }
    if (value.startsWith(':')) return undefined;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'data') data.push(fieldValue);
    return undefined;
  }
  try {
    checkAbort();
    while (true) {
      const result = await reader.read();
      checkAbort();
      if (result.done) break;
      const bytes = result.value;
      responseBytes += bytes.byteLength;
      if (responseBytes > limits.maxResponseBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider response exceeds the byte limit.');
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        // Defer a CR delimiter until the next byte, so the optional LF is
        // included in the same frame's byte limit before it is dispatched.
        if (pendingCr) {
          pendingCr = false;
          if (byte === 10) account(1);
          const frame = line();
          if (frame !== undefined) { checkAbort(); yield frame; }
          if (byte === 10) { start = index + 1; continue; }
        }
        if (byte !== 10 && byte !== 13) continue;
        const part = bytes.subarray(start, index);
        append(part);
        account(1);
        start = index + 1;
        if (byte === 13) { pendingCr = true; }
        else { const frame = line(); if (frame !== undefined) { checkAbort(); yield frame; } }
      }
      const tail = bytes.subarray(start);
      if (tail.length > 0) append(tail);
    }
    if (pendingCr) { const frame = line(); if (frame !== undefined) { checkAbort(); yield frame; } }
    // SSE events need a blank line; EOF does not complete a partially written frame.
    if (lineBytes > 0 || data.length > 0) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider SSE stream ended inside a frame.');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
