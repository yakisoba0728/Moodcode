import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ToolDefinition } from '../../ports.js';
import { createPatchAdapter } from '../file-actions/adapter.js';
import { exactPath, readExactText, TEXT_FILE_LIMIT } from '../file-actions/text.js';
function inputObject(input: unknown): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new EngineError('INVALID_EDIT_INPUT', 'Edit requires an object'); return input as Record<string, unknown>; }
/** Exact substring replacement: no fuzzy matching or source-derived recovery heuristics. */
export function createExactEditTool(): ToolDefinition {
  return createPatchAdapter({ name: 'edit_file', description: 'Replace exactly one occurrence of oldString in a bounded UTF-8 text file after verifying expectedHash. Preview and approval required. BOM and existing line endings are preserved.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'expectedHash', 'oldString', 'newString'], properties: { path: { type: 'string' }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, oldString: { type: 'string', minLength: 1 }, newString: { type: 'string' } } },
    async transform(value, context) {
      const input = inputObject(value); if (Object.keys(input).length !== 4 || ['path', 'expectedHash', 'oldString', 'newString'].some(key => !Object.hasOwn(input, key))) throw new EngineError('INVALID_EDIT_INPUT', 'Edit requires path, expectedHash, oldString and newString only');
      const path = exactPath(input.path);
      if (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash) || typeof input.oldString !== 'string' || !input.oldString || typeof input.newString !== 'string') throw new EngineError('INVALID_EDIT_INPUT', 'Edit text and expected SHA-256 must be valid');
      for (const text of [input.oldString, input.newString]) if (Buffer.byteLength(text) > TEXT_FILE_LIMIT || text.includes('\0') || Buffer.from(text).toString() !== text) throw new EngineError('INVALID_EDIT_INPUT', 'Replacement text must be bounded UTF-8 without NUL');
      const before = await readExactText(context.workspace, path, context.signal); if (before.hash !== input.expectedHash) throw new EngineError('EDIT_PREIMAGE_MISMATCH', 'File hash differs from the expected preimage');
      const first = before.content.indexOf(input.oldString); if (first < 0) throw new EngineError('EDIT_MATCH_NOT_FOUND', 'oldString has no exact occurrence');
      if (before.content.indexOf(input.oldString, first + 1) >= 0) throw new EngineError('EDIT_MATCH_AMBIGUOUS', 'oldString must have exactly one occurrence, including overlapping matches');
      if (input.oldString === input.newString) throw new EngineError('EDIT_NO_CHANGE', 'Replacement must change the file');
      const content = before.content.slice(0, first) + input.newString + before.content.slice(first + input.oldString.length);
      if (Buffer.byteLength(content) > TEXT_FILE_LIMIT) throw new EngineError('FILE_ACTION_LIMIT', 'Replacement exceeds the file byte limit');
      const normalized: JsonObject = { path, expectedHash: input.expectedHash, oldString: input.oldString, newString: input.newString };
      return { input: normalized, changes: [{ path, expectedHash: before.hash, content }], preview: { matching: 'exact single occurrence', lineEndings: before.content.includes('\r\n') ? 'CRLF' : 'LF', bom: before.content.startsWith('\ufeff') } };
    },
  });
}
