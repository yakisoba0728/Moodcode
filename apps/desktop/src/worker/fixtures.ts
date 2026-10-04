import { EngineError } from '@moodcode/contracts';
import { ScriptedProvider, type ProviderAdapter, type ProviderEvent, type TurnRequest } from '@moodcode/engine';

function toolMessage(request: TurnRequest, toolCallId: string): string {
  const message = request.messages.findLast(value => value.role === 'tool' && value.toolCallId === toolCallId);
  if (!message) throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture did not receive the expected tool result.');
  return message.content;
}
function toolOutput(request: TurnRequest, toolCallId: string): Record<string, unknown> {
  let result: unknown;
  try { result = JSON.parse(toolMessage(request, toolCallId)); }
  catch { throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture tool output was not JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.hasOwn(result, 'error')) {
    throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture tool was denied or failed.');
  }
  return result as Record<string, unknown>;
}

/** Uses the ordinary engine tools and approval policy; it has no filesystem access. */
export class CodingFixtureProvider implements ProviderAdapter {
  readonly id = 'scripted';
  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Coding fixture was cancelled.');
    const suffix = request.runId;
    const readId = `fixture-read-${suffix}`;
    const patchId = `fixture-patch-${suffix}`;
    const commandId = `fixture-command-${suffix}`;
    switch (request.turnIndex) {
      case 0:
        yield { type: 'tool.call', call: { id: readId, name: 'read_file', input: { path: 'math.mjs' } } };
        break;
      case 1: {
        const read = toolOutput(request, readId);
        if (read.path !== 'math.mjs' || typeof read.content !== 'string' || typeof read.sha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(read.sha256) || read.truncated === true) {
          throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture requires a complete read and file hash.');
        }
        const content = read.content.replace(/\ba\s*-\s*b\b/, 'a + b');
        if (content === read.content) throw new EngineError('FIXTURE_INPUT_INVALID', 'Coding fixture expects an a - b expression in math.mjs.');
        yield { type: 'tool.call', call: { id: patchId, name: 'apply_patch', input: {
          changes: [{ path: 'math.mjs', expectedHash: read.sha256, content }],
        } } };
        break;
      }
      case 2:
        if (!/^Applied patch to [1-9]\d* file\(s\)\./.test(toolMessage(request, patchId))) {
          throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture patch was denied or failed.');
        }
        yield { type: 'tool.call', call: { id: commandId, name: 'run_command', input: { command: 'node --test', timeoutMs: 15_000 } } };
        break;
      default: {
        const command = toolMessage(request, commandId);
        if (!/^Command completed; exitCode=0; signal=null; cleanupConfirmed=true\./.test(command)
          || !/(?:#|ℹ) tests [1-9]\d*/u.test(command)) {
          throw new EngineError('FIXTURE_TOOL_FAILED', 'Coding fixture test command did not complete successfully.');
        }
        yield { type: 'text.delta', delta: 'Fixed add(a, b) in math.mjs and verified the change with node --test.' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
    }
    yield { type: 'finish', reason: 'tool_calls' };
  }
}

export function testFixtureProvider(scenario: 'coding' | 'slow'): ProviderAdapter {
  if (scenario === 'coding') return new CodingFixtureProvider();
  return new ScriptedProvider([{ delayMs: 10_000, events: [
    { type: 'text.delta', delta: 'The slow desktop fixture completed.' },
    { type: 'finish', reason: 'stop' },
  ] }]);
}
