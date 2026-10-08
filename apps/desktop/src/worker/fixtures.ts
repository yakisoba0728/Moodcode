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

/** Deterministic GUI input still travels through the genuine question and child APIs. */
export class AdvancedFixtureProvider implements ProviderAdapter {
  readonly id = 'scripted';
  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Advanced fixture was cancelled.');
    const slowChild = request.messages.some(message => message.role === 'user' && message.content.includes('desktop child slow fixture'));
    if (slowChild) await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new EngineError('PROVIDER_CANCELLED', 'Advanced child fixture was cancelled.')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 10_000);
      signal.addEventListener('abort', aborted, { once: true });
    });
    const child = slowChild || request.messages.some(message => message.role === 'user' && message.content.includes('desktop child fixture'));
    if (child) {
      yield { type: 'text.delta', delta: JSON.stringify({ summary: 'fixture child result' }) };
      yield { type: 'finish', reason: 'stop' }; return;
    }
    if (request.messages.some(message => message.role === 'user' && message.content.includes('desktop MCP fixture'))) {
      if (request.turnIndex === 0) {
        const tool = request.tools.find(value => value.name === 'mcp_fixture_echo');
        if (!tool) throw new EngineError('FIXTURE_TOOL_FAILED', 'Connect the fixture MCP before starting this flow.');
        yield { type: 'tool.call', call: { id: `fixture-mcp-${request.runId}`, name: tool.name, input: {} } };
        yield { type: 'finish', reason: 'tool_calls' }; return;
      }
      yield { type: 'text.delta', delta: 'The desktop fixture consumed the native MCP result.' };
      yield { type: 'finish', reason: 'stop' }; return;
    }
    if (request.turnIndex === 0) {
      yield { type: 'tool.call', call: { id: `fixture-question-${request.runId}`, name: 'ask_user', input: { prompt: 'Continue the desktop fixture?', options: [{ id: 'continue', label: 'Continue' }], allowFreeText: true, multiple: false } } };
      yield { type: 'finish', reason: 'tool_calls' }; return;
    }
    yield { type: 'text.delta', delta: 'The desktop fixture received the answer.' };
    yield { type: 'finish', reason: 'stop' };
  }
}
export function testFixtureProvider(scenario: 'coding' | 'slow' | 'advanced' | 'account'): ProviderAdapter {
  if (scenario === 'coding') return new CodingFixtureProvider();
  if (scenario === 'advanced') return new AdvancedFixtureProvider();
  if (scenario === 'account') return new ScriptedProvider();
  return new ScriptedProvider([{ delayMs: 10_000, events: [
    { type: 'text.delta', delta: 'The slow desktop fixture completed.' },
    { type: 'finish', reason: 'stop' },
  ] }]);
}
