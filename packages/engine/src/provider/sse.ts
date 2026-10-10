import { EngineError } from '@moodcode/contracts';

export interface SseLimits { maxFrameBytes: number; maxResponseBytes: number }
export interface SseErrors { frameLimit(): EngineError; malformed(): EngineError }

const providerErrors: SseErrors = {
  frameLimit: () => new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider SSE frame exceeds the byte limit.'),
  malformed: () => new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider returned an invalid SSE stream.'),
};

/** Parse bytes, not decoded network chunks: UTF-8 and CRLF may cross reads. */
export class SseDataParser {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  #lineBuffer: Uint8Array;
  #lineBytes = 0;
  #frameBytes = 0;
  #pendingCr = false;
  #firstLine = true;
  #data: string[] = [];

  constructor(private readonly maxFrameBytes: number, private readonly errors: SseErrors = providerErrors) {
    this.#lineBuffer = new Uint8Array(Math.min(4096, maxFrameBytes));
  }

  /** Whether an unterminated line or data frame is buffered. */
  get partial(): boolean { return this.#lineBytes > 0 || this.#data.length > 0; }

  /** Yields the data of each frame that `bytes` completes. */
  *push(bytes: Uint8Array): Generator<string> {
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      // Defer a CR delimiter until the next byte, so the optional LF is
      // included in the same frame's byte limit before it is dispatched.
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (byte === 10) this.#account(1);
        const frame = this.#line();
        if (frame !== undefined) yield frame;
        if (byte === 10) { start = index + 1; continue; }
      }
      if (byte !== 10 && byte !== 13) continue;
      this.#append(bytes.subarray(start, index));
      this.#account(1);
      start = index + 1;
      if (byte === 13) { this.#pendingCr = true; }
      else { const frame = this.#line(); if (frame !== undefined) yield frame; }
    }
    const tail = bytes.subarray(start);
    if (tail.length > 0) this.#append(tail);
  }

  /** At EOF a deferred CR still ends its line; returns the frame it completes. */
  end(): string | undefined {
    if (!this.#pendingCr) return undefined;
    this.#pendingCr = false;
    return this.#line();
  }

  #account(bytes: number) {
    this.#frameBytes += bytes;
    if (this.#frameBytes > this.maxFrameBytes) throw this.errors.frameLimit();
  }

  #append(part: Uint8Array) {
    this.#account(part.length);
    const required = this.#lineBytes + part.length;
    if (required > this.#lineBuffer.length) {
      const replacement = new Uint8Array(Math.min(this.maxFrameBytes, Math.max(required, this.#lineBuffer.length * 2)));
      replacement.set(this.#lineBuffer.subarray(0, this.#lineBytes));
      this.#lineBuffer = replacement;
    }
    this.#lineBuffer.set(part, this.#lineBytes);
    this.#lineBytes = required;
  }

  #line(): string | undefined {
    let value: string;
    try { value = this.#decoder.decode(this.#lineBuffer.subarray(0, this.#lineBytes)); } catch { throw this.errors.malformed(); }
    this.#lineBytes = 0;
    if (this.#firstLine) { value = value.replace(/^\uFEFF/, ''); this.#firstLine = false; }
    if (value === '') {
      const frame = this.#data.length === 0 ? undefined : this.#data.join('\n');
      this.#data = [];
      this.#frameBytes = 0;
      return frame;
    }
    if (value.startsWith(':')) return undefined;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'data') this.#data.push(fieldValue);
    return undefined;
  }
}

export async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, limits: SseLimits): AsyncGenerator<string> {
  const reader = body.getReader();
  const parser = new SseDataParser(limits.maxFrameBytes);
  let responseBytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const checkAbort = () => {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
  };
  try {
    checkAbort();
    while (true) {
      const result = await reader.read();
      checkAbort();
      if (result.done) break;
      responseBytes += result.value.byteLength;
      if (responseBytes > limits.maxResponseBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider response exceeds the byte limit.');
      for (const frame of parser.push(result.value)) { checkAbort(); yield frame; }
    }
    const frame = parser.end();
    if (frame !== undefined) { checkAbort(); yield frame; }
    // SSE events need a blank line; EOF does not complete a partially written frame.
    if (parser.partial) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider SSE stream ended inside a frame.');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
