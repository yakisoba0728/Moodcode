import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { providerImages } from '../media/provider.js';

export interface ScriptedTurn {
  events: ProviderEvent[];
  /** Delay before each event, or once for an empty turn. */
  delayMs?: number;
  /** Failure raised after the configured events have been emitted. */
  error?: string;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_ECHO_CHARACTERS = 160;

function cancellationError(): Error {
  // Abort reasons may contain credentials or other private request context.
  const error = new Error('Scripted provider request cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  checkCancellation(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancellationError());
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function echo(prompt: string | undefined): string {
  if (!prompt) return 'Ready for a prompt.';
  let excerpt = '';
  let length = 0;
  for (const character of prompt) {
    if (length === MAX_ECHO_CHARACTERS) return `Received: ${excerpt}…`;
    excerpt += character;
    length += 1;
  }
  return `Received: ${excerpt}`;
}

/** A deterministic, local provider for harness runs and failure scenarios. */
export class ScriptedProvider implements ProviderAdapter {
  readonly id = 'scripted';
  readonly inputModalities = Object.freeze(['text'] as const);
  readonly #turns: ScriptedTurn[];
  #callCount = 0;

  constructor(turns: ScriptedTurn[] = []) {
    for (const turn of turns) {
      if (turn.delayMs !== undefined && (
        !Number.isFinite(turn.delayMs) || turn.delayMs < 0 || turn.delayMs > MAX_TIMER_MS
      )) {
        throw new RangeError('Scripted turn delayMs must be a finite, non-negative timer duration.');
      }
    }
    // Both the caller's fixture and previously yielded events may be mutated.
    this.#turns = structuredClone(turns);
  }

  /** Number of streamTurn invocations, including cancelled and failed attempts. */
  get callCount(): number {
    return this.#callCount;
  }

  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.#callCount += 1;
    return this.#stream(request, signal);
  }

  async *#stream(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    checkCancellation(signal);
    providerImages(request, false, signal);
    if (!Number.isSafeInteger(request.turnIndex) || request.turnIndex < 0) {
      throw new RangeError('Scripted provider turnIndex must be a non-negative safe integer.');
    }
    const scripted = this.#turns[request.turnIndex];
    const events: ProviderEvent[] = scripted?.events ?? [
      { type: 'text.delta', delta: echo(request.messages.findLast(message => message.role === 'user')?.content) },
      { type: 'finish', reason: 'stop' },
    ];
    const delayMs = scripted?.delayMs ?? 0;

    if (events.length === 0 && delayMs > 0) await delay(delayMs, signal);
    for (const event of events) {
      checkCancellation(signal);
      if (delayMs > 0) await delay(delayMs, signal);
      checkCancellation(signal);
      yield structuredClone(event);
    }
    checkCancellation(signal);
    if (scripted?.error !== undefined) {
      throw new Error(scripted.error);
    }
  }
}
