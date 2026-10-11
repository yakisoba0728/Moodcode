import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ToolDefinition } from '../../ports.js';
import { createPatchAdapter } from './adapter.js';
import { isSha256 } from '../../shared/data.js';
import { exactInput, exactPath, readExpectedText } from './text.js';
export function createFileActionTools(): ToolDefinition[] {
  return (['rename_file', 'delete_file'] as const).map(name => createPatchAdapter({ name,
    description: name === 'rename_file' ? 'Move one exact UTF-8 text file to an absent destination using a hash-checked create then delete checkpoint. Partial effects are possible and are reviewable. Requires approval.' : 'Delete one exact UTF-8 text file after verifying expectedHash. Directory and binary deletion are unsupported. Requires approval.',
    inputSchema: { type: 'object', additionalProperties: false, required: name === 'rename_file' ? ['path', 'destination', 'expectedHash'] : ['path', 'expectedHash'], properties: { path: { type: 'string' }, ...(name === 'rename_file' ? { destination: { type: 'string' } } : {}), expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    async transform(value, context) {
      const input = exactInput(value, name === 'rename_file' ? ['path', 'destination', 'expectedHash'] : ['path', 'expectedHash'], 'INVALID_FILE_ACTION_INPUT', ['File action requires an object', 'File action has missing or unknown properties']);
      const path = exactPath(input.path); if (!isSha256(input.expectedHash)) throw new EngineError('INVALID_FILE_ACTION_INPUT', 'Expected SHA-256 is required');
      const before = await readExpectedText(context.workspace, path, input.expectedHash, context.signal, ['FILE_ACTION_PREIMAGE_MISMATCH', 'File hash differs from expected preimage']);
      const normalized: JsonObject = { path, expectedHash: input.expectedHash };
      if (name === 'delete_file') return { input: normalized, changes: [{ path, expectedHash: before.hash, content: null }] };
      const destination = exactPath(input.destination); normalized.destination = destination;
      if (destination.toLowerCase() === path.toLowerCase()) throw new EngineError('INVALID_FILE_ACTION_INPUT', 'Rename source and destination must differ');
      if (before.mode !== (0o666 & ~process.umask())) throw new EngineError('UNSUPPORTED_FILE_ACTION_MODE', 'Rename supports default-created text file permissions only; custom or executable modes require a metadata-aware rename implementation');
      return { input: normalized, changes: [{ path: destination, expectedHash: null, content: before.content }, { path, expectedHash: before.hash, content: null }], preview: { atomic: false, warning: 'Destination is created before source deletion; partial effects retain both pre/post images.' } };
    },
  }));
}
