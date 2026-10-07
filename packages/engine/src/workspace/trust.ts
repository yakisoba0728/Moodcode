import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { EngineError } from '@moodcode/contracts';
import type { KnowledgeHostBinding, TrustRevision, TrustSourcePin } from '../knowledge/types.js';
import { KnowledgeStorage } from '../knowledge/store.js';
import { KNOWLEDGE_LIMITS, exactKnowledgePath, immutableKnowledgeJson, knowledgeError, knowledgeHash, sha256, validateBinding } from '../knowledge/validation.js';

/** Host-visible preview is descriptive; only this service's original object can authorize its exact sources. */
export interface WorkspaceTrustPreview {
  readonly workspaceId: string;
  readonly binding: KnowledgeHostBinding;
  readonly sources: readonly TrustSourcePin[];
  readonly sha256: string;
}
export function assertPhysicalKnowledgeRoot(input: KnowledgeHostBinding): void {
  const binding = validateBinding(input);
  try {
    const root = lstatSync(binding.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(binding.root) !== binding.root || root.dev.toString() !== binding.rootDevice || root.ino.toString() !== binding.rootInode) knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace physical root no longer matches its host trust binding');
  } catch (error) {
    if (error instanceof EngineError) throw error;
    knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace physical root is unavailable');
  }
}
function readPin(binding: KnowledgeHostBinding, relative: string): TrustSourcePin {
  exactKnowledgePath(relative); assertPhysicalKnowledgeRoot(binding);
  let selected = binding.root;
  const components = relative.split('/');
  try {
    for (let index = 0; index < components.length; index++) {
      selected = path.join(selected, components[index]!);
      const metadata = lstatSync(selected, { bigint: true });
      if (metadata.isSymbolicLink() || realpathSync(selected) !== selected || index < components.length - 1 && !metadata.isDirectory()) knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Trust sources cannot traverse symlinks or unavailable path components');
    }
    const descriptor = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(KNOWLEDGE_LIMITS.trustFileBytes)) knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Trust sources must be bounded ordinary files with one link');
      const output = Buffer.alloc(KNOWLEDGE_LIMITS.trustFileBytes + 1); let bytes = 0;
      while (bytes < output.byteLength) {
        const count = readSync(descriptor, output, bytes, output.byteLength - bytes, null);
        if (!count) break; bytes += count;
      }
      const after = fstatSync(descriptor, { bigint: true }), current = lstatSync(selected, { bigint: true });
      if (bytes > KNOWLEDGE_LIMITS.trustFileBytes || BigInt(bytes) !== after.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs || realpathSync(selected) !== selected) knowledgeError('KNOWLEDGE_SOURCE_CHANGED', 'Instruction file changed during its exact trust observation');
      const body = output.subarray(0, bytes), text = body.toString('utf8');
      if (!Buffer.from(text).equals(body) || text.includes('\0')) knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Trust sources must contain plain UTF-8 text');
      assertPhysicalKnowledgeRoot(binding);
      return Object.freeze({ path: relative, sha256: sha256(text), bytes, device: after.dev.toString(), inode: after.ino.toString() });
    } finally { closeSync(descriptor); }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return knowledgeError('KNOWLEDGE_SOURCE_UNAVAILABLE', 'Instruction source is missing or unreadable');
  }
}
export function captureWorkspaceTrustSources(binding: KnowledgeHostBinding, paths: readonly string[]): readonly TrustSourcePin[] {
  const normalized = immutableKnowledgeJson(paths);
  if (!Array.isArray(normalized) || normalized.length > KNOWLEDGE_LIMITS.trustSources || new Set(normalized).size !== normalized.length) knowledgeError('KNOWLEDGE_LIMIT', 'Trust previews require at most 32 distinct exact paths');
  assertPhysicalKnowledgeRoot(binding);
  const sources = normalized.map(relative => readPin(binding, relative));
  assertPhysicalKnowledgeRoot(binding); return Object.freeze(sources);
}
/** Suitable for KnowledgeStorage's synchronous freshness port inside its write transaction. */
export function assertWorkspaceTrustSourcesCurrent(binding: KnowledgeHostBinding, sources: readonly TrustSourcePin[]): void {
  const observed = captureWorkspaceTrustSources(binding, sources.map(source => source.path));
  if (knowledgeHash(observed) !== knowledgeHash(sources)) knowledgeError('KNOWLEDGE_SOURCE_CHANGED', 'Current instruction sources differ from the exact host-approved trust snapshot');
}
export class WorkspaceTrustService {
  readonly #store: KnowledgeStorage;
  readonly #previews = new WeakSet<object>();
  constructor(store: KnowledgeStorage) { this.#store = store; Object.freeze(this); }
  preview(workspaceId: string, paths: readonly string[]): WorkspaceTrustPreview {
    const binding = this.#store.readHostBinding(workspaceId), sources = captureWorkspaceTrustSources(binding, paths);
    if (knowledgeHash(binding) !== knowledgeHash(this.#store.readHostBinding(workspaceId))) knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Host binding changed while constructing its trust preview');
    const body = { workspaceId, binding, sources }, preview = immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) }); this.#previews.add(preview); return preview;
  }
  set(input: { readonly workspaceId: string; readonly requestId: string; readonly expectedRevision: number; readonly decision: 'allow' | 'deny'; readonly preview?: WorkspaceTrustPreview; readonly expiresAt?: string | null }): TrustRevision {
    const normalized = immutableKnowledgeJson(input);
    if (Object.keys(normalized).some(key => !['workspaceId', 'requestId', 'expectedRevision', 'decision', 'preview', 'expiresAt'].includes(key))) knowledgeError('INVALID_KNOWLEDGE', 'Unknown host trust decision field');
    let binding: KnowledgeHostBinding, sources: readonly TrustSourcePin[];
    if (input.decision === 'allow') {
      const preview = input.preview;
      if (!preview || typeof preview !== 'object' || !this.#previews.has(preview) || preview.workspaceId !== input.workspaceId) knowledgeError('WORKSPACE_TRUST_PREVIEW_INVALID', 'Host must approve this service\'s original exact workspace trust preview');
      binding = preview.binding; sources = preview.sources; assertWorkspaceTrustSourcesCurrent(binding, sources);
    } else {
      if (input.preview !== undefined || input.expiresAt !== undefined && input.expiresAt !== null) knowledgeError('INVALID_KNOWLEDGE', 'Trust revocation cannot approve a source preview or expiry');
      binding = this.#store.readHostBinding(input.workspaceId); sources = Object.freeze([]);
    }
    return this.#store.setTrust({ workspaceId: input.workspaceId, requestId: input.requestId, expectedRevision: input.expectedRevision, decision: input.decision, binding, sources, expiresAt: input.expiresAt ?? null });
  }
}
