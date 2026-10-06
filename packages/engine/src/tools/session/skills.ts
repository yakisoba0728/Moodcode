import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { projectToolResult } from '../../artifacts/result.js';

export interface LocalSkill { id: string; path: string; description: string; sha256: string }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function live(signal: AbortSignal): void { if (signal.aborted) throw new EngineError('CANCELLED', 'Local reference read was cancelled'); }
async function read(root: string, path: string, signal: AbortSignal): Promise<{ text: string; sha256: string; truncated: boolean }> {
  live(signal);
  const target = resolve(root, path), within = relative(root, target);
  if (isAbsolute(path) || within === '..' || within.startsWith(`..${sep}`) || path.includes('\0')) throw new EngineError('INVALID_REFERENCE_PATH', 'Reference must stay inside its local discovery root');
  let current = root;
  const startRoot = await lstat(root);
  if (!startRoot.isDirectory() || startRoot.isSymbolicLink() || await realpath(root) !== root) throw new EngineError('REFERENCE_PATH_UNSAFE', 'Reference root must be a canonical directory');
  for (const piece of within.split(sep).slice(0, -1)) { current = join(current, piece); const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EngineError('REFERENCE_PATH_UNSAFE', 'Reference directory is unsafe'); }
  const linked = await lstat(target);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1) throw new EngineError('REFERENCE_PATH_UNSAFE', 'Reference must be a regular singly linked file');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== linked.dev || before.ino !== linked.ino) throw new EngineError('REFERENCE_CHANGED', 'Reference changed before it could be opened');
    const bytes = Buffer.alloc(Math.min(65_537, before.size + 1));
    let offset = 0;
    while (offset < bytes.length) { live(signal); const item = await file.read(bytes, offset, bytes.length - offset, offset); if (!item.bytesRead) break; offset += item.bytesRead; }
    const after = await file.stat(), pathAfter = await lstat(target), rootAfter = await lstat(root);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || rootAfter.dev !== startRoot.dev || rootAfter.ino !== startRoot.ino || await realpath(target) !== target) throw new EngineError('REFERENCE_CHANGED', 'Reference changed during its read');
    const retained = bytes.subarray(0, Math.min(offset, 65_536));
    if (retained.includes(0)) throw new EngineError('REFERENCE_BINARY_UNSUPPORTED', 'Local references must be UTF-8 text');
    const truncated = offset > 65_536 || before.size > 65_536;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(retained, { stream: truncated });
    return { text, sha256: createHash('sha256').update(retained).digest('hex'), truncated };
  } finally { await file.close(); }
}
export class LocalReferenceService {
  async list(workspaceRoot: string, signal: AbortSignal): Promise<{ skills: LocalSkill[]; truncated: boolean }> {
    const root = join(workspaceRoot, '.moodcode', 'skills');
    const names: string[] = []; let scanned = 0, truncated = false;
    try {
      const directory = await opendir(root);
      for await (const entry of directory) { live(signal); if (++scanned > 1024 || names.length >= 64) { truncated = true; break; } if (entry.isDirectory() && idPattern.test(entry.name)) names.push(entry.name); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { skills: [], truncated: false }; throw new EngineError('SKILL_DISCOVERY_FAILED', 'Local skills could not be listed'); }
    names.sort();
    const skills: LocalSkill[] = [];
    for (const id of names.slice(0, 64)) {
      live(signal);
      try {
        const result = await read(root, join(id, 'SKILL.md'), signal);
        const description = /^description:\s*["']?([^\r\n]{1,1024})/mu.exec(result.text)?.[1]?.replace(/["']$/u, '') ?? result.text.split('\n').find(line => line.trim() && !line.startsWith('---'))?.slice(0, 1024) ?? id;
        skills.push({ id, path: `.moodcode/skills/${id}/SKILL.md`, description, sha256: result.sha256 });
      } catch (error) { live(signal); if (error instanceof EngineError && ['REFERENCE_PATH_UNSAFE', 'REFERENCE_CHANGED', 'REFERENCE_BINARY_UNSUPPORTED'].includes(error.code) || (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new EngineError('SKILL_DISCOVERY_FAILED', 'A local skill could not be inspected'); }
    }
    return { skills, truncated };
  }
  async skill(workspaceRoot: string, id: string, reference: string | undefined, signal: AbortSignal) {
    if (!idPattern.test(id)) throw new EngineError('INVALID_SKILL_ID', 'Skill needs a bounded directory identifier');
    const path = reference ?? 'SKILL.md';
    return { ...await read(join(workspaceRoot, '.moodcode', 'skills', id), path, signal), source: `.moodcode/skills/${id}/${path}`, kind: 'local-skill' };
  }
  async reference(workspaceRoot: string, path: string, signal: AbortSignal) { return { ...await read(join(workspaceRoot, '.moodcode', 'references'), path, signal), source: `.moodcode/references/${path}`, kind: 'local-reference' }; }
}
export function createLocalReferenceTools(service = new LocalReferenceService()): ToolDefinition[] {
  return ['skill_list', 'skill_read', 'reference_read'].map((name): ToolDefinition => {
    const prepared = new WeakMap<PreparedTool, { binding: string; snapshot: string; used: boolean }>();
    const binding = (context: ToolContext) => JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId]);
    const inputSchema: JsonObject = name === 'skill_list' ? { type: 'object', properties: {}, additionalProperties: false }
      : name === 'skill_read' ? { type: 'object', properties: { id: { type: 'string' }, reference: { type: 'string' } }, required: ['id'], additionalProperties: false }
      : { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
    return { name, effectClass: 'read', description: name === 'skill_list' ? 'Discover workspace-local skills with bounded descriptions.' : 'Read a bounded workspace-local skill or reference with source provenance.', inputSchema,
      async prepare(value, context) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192) throw new EngineError('INVALID_REFERENCE_INPUT', 'Reference arguments must be a bounded object');
        const input = value as Record<string, unknown>; const keys = name === 'skill_list' ? [] : name === 'skill_read' ? ['id', 'reference'] : ['path'];
        if (Object.keys(input).some(key => !keys.includes(key)) || name === 'skill_read' && (typeof input.id !== 'string' || !idPattern.test(input.id)) || name === 'reference_read' && typeof input.path !== 'string' || input.reference !== undefined && typeof input.reference !== 'string') throw new EngineError('INVALID_REFERENCE_INPUT', 'Reference arguments are invalid');
        const result: PreparedTool = { name, input: JSON.parse(JSON.stringify(input)), fingerprint: createHash('sha256').update(JSON.stringify([context.workspace.id, name, input])).digest('hex'), requiresApproval: false, preview: { localReference: true } };
        prepared.set(result, { binding: binding(context), snapshot: JSON.stringify(result), used: false }); return result;
      },
      async execute(request, context) {
        const capture = prepared.get(request); if (!capture || capture.used || capture.binding !== binding(context) || capture.snapshot !== JSON.stringify(request)) throw new EngineError('REFERENCE_REQUEST_STALE', 'Reference request must be used once by its owner'); capture.used = true;
        const input = request.input as JsonObject;
        const data = name === 'skill_list' ? await service.list(context.workspace.root, context.signal) : name === 'skill_read' ? await service.skill(context.workspace.root, input.id as string, input.reference as string | undefined, context.signal) : await service.reference(context.workspace.root, input.path as string, context.signal);
        return projectToolResult({ displayContent: JSON.stringify(data), structuredData: JSON.parse(JSON.stringify(data)), warnings: data.truncated ? ['Local reference output is incomplete.'] : [], outcome: 'completed' }, { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32_768), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 65_536) });
      },
    };
  });
}
