import { isAbsolute } from 'node:path';
import { EngineError, type JsonObject, type JsonValue, type Message, type ProviderReplay, type ProviderToolCall, type RunConfig } from '@moodcode/contracts';
import { normalizeDocumentAttachments, normalizeMediaAttachments, normalizeImageAttachments } from '@moodcode/contracts/validation';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { agentInstructions } from './instructions.js';
import { codepointPrefix, entriesBytes, entryBytes, extractiveMemory, MAX_MEMORY_BYTES, MIN_MEMORY_BYTES, type MemorySource } from './memory.js';
import { InstructionSources } from './sources.js';

export { EXTRACTIVE_MEMORY_PREFIX } from './memory.js';
export { AGENT_DEFAULTS_PREFIX } from './instructions.js';

const MAX_INSTRUCTION_BYTES = 32 * 1024;
const INSTRUCTION_PREFIX = 'Workspace instructions (AGENTS.md):\n';
const TRUNCATION_NOTICE = '\n[AGENTS.md truncated.]';

interface ContextBlock {
  messages: ProviderMessage[];
  sources: MemorySource[];
  // Every entry contributes its serialized bytes and one array delimiter.
  cost: number;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('CANCELLED', 'Context construction was cancelled.');
}

function arrayBytes(cost: number, count: number): number {
  return count === 0 ? 2 : cost + 1;
}

function block(messages: ProviderMessage[], sources: MemorySource[] = []): ContextBlock {
  return { messages, sources, cost: entriesBytes(messages) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Reject cyclic, non-JSON, and excessively deep tool metadata before serialization.
// The clone also prevents a provider from changing the stored history through aliases.
function copyJson(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth > 64 || ancestors.has(value)) return undefined;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const child of value) {
        const copied = copyJson(child, ancestors, depth + 1);
        if (copied === undefined) return undefined;
        result.push(copied);
      }
      return result;
    }
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      const copied = copyJson(child, ancestors, depth + 1);
      if (copied === undefined) return undefined;
      Object.defineProperty(result, key, { value: copied, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function copyCalls(value: unknown): ProviderToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids = new Set<string>();
  const calls: ProviderToolCall[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0
      || typeof candidate.name !== 'string' || candidate.name.length === 0 || ids.has(candidate.id)) return undefined;
    const input = copyJson(candidate.input);
    if (input === undefined) return undefined;
    ids.add(candidate.id);
    calls.push({ id: candidate.id, name: candidate.name, input });
  }
  return calls;
}

function invalidReplay(): never {
  throw new EngineError('INVALID_CONTEXT', 'Stored provider replay metadata is malformed.');
}

/** Clone opaque replay JSON without silently removing malformed/native state. */
function replayJson(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || depth > 64 || ancestors.has(value)) invalidReplay();
  let array: boolean;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  let keys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch { invalidReplay(); }
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) invalidReplay();
  ancestors.add(value);
  try {
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) invalidReplay();
      const result: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidReplay();
        result.push(replayJson(descriptor.value, ancestors, depth + 1));
      }
      return result;
    }
    const result: JsonObject = {};
    for (const key of keys) {
      if (typeof key !== 'string') invalidReplay();
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidReplay();
      Object.defineProperty(result, key, {
        value: replayJson(descriptor.value, ancestors, depth + 1), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  } finally { ancestors.delete(value); }
}

function messageReplay(message: Message): ProviderReplay | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(message, 'providerReplay');
    if (descriptor === undefined && 'providerReplay' in message) invalidReplay();
  } catch { invalidReplay(); }
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalidReplay();
  if (descriptor.value === undefined) return undefined;
  const copied = replayJson(descriptor.value);
  if (!isRecord(copied) || Object.keys(copied).some(key => !['providerId', 'items', 'modelId', 'protocol', 'version'].includes(key))
    || !Object.hasOwn(copied, 'providerId') || !Object.hasOwn(copied, 'items')) invalidReplay();
  const providerId = copied.providerId;
  const items = copied.items;
  if (typeof providerId !== 'string' || providerId.trim().length === 0 || providerId.length > 256
    || Buffer.byteLength(providerId, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(providerId)
    || !Array.isArray(items) || items.some((item) => !isRecord(item))) invalidReplay();
  const bindingKeys = ['modelId', 'protocol', 'version'];
  const supplied = bindingKeys.filter(key => Object.hasOwn(copied, key));
  if (supplied.length !== 0 && supplied.length !== bindingKeys.length) invalidReplay();
  if (supplied.length) {
    for (const key of ['modelId', 'protocol']) {
      const value = copied[key];
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) invalidReplay();
    }
    if (typeof copied.version !== 'number' || !Number.isSafeInteger(copied.version) || copied.version < 1 || copied.version > 32) invalidReplay();
    return { providerId, items: items as JsonObject[], modelId: copied.modelId as string, protocol: copied.protocol as string, version: copied.version };
  }
  return { providerId, items: items as JsonObject[] };
}

function validMessage(value: unknown, sessionId: string): value is Message {
  return isRecord(value) && value.sessionId === sessionId && typeof value.runId === 'string'
    && typeof value.content === 'string' && ['user', 'assistant', 'tool'].includes(String(value.role));
}

function checkedMessageReplay(value: unknown, sessionId: string, config: RunConfig, originalModelId?: string): ProviderReplay | undefined {
  if (!isRecord(value) || value.sessionId !== sessionId) return undefined;
  const replay = messageReplay(value as unknown as Message);
  if (replay === undefined) return undefined;
  if (value.role !== 'assistant') throw new EngineError('INVALID_CONTEXT', 'Provider replay is only supported on assistant messages.');
  if (!validMessage(value, sessionId)) throw new EngineError('INVALID_CONTEXT', 'Stored message with provider replay is malformed.');
  // Native state belongs to one transport; still validate it before switching providers.
  if (replay.providerId !== config.providerId) return undefined;
  const boundModel = replay.modelId ?? originalModelId;
  return boundModel === undefined || boundModel === config.modelId ? replay : undefined;
}

function historyBlocks(request: ContextRequest): ContextBlock[] {
  const stored = request.snapshot.messages;
  const sessionId = request.snapshot.session.id;
  const runModels = new Map(request.snapshot.runs.map(run => [run.id, run.config.modelId]));
  const blocks: ContextBlock[] = [];
  for (let index = 0; index < stored.length; index += 1) {
    checkAbort(request.signal);
    const message = stored[index];
    // Inspect same-session native state before filtering malformed surrounding rows.
    const providerReplay = checkedMessageReplay(message, sessionId, request.config, message && typeof message === 'object' ? runModels.get(message.runId) : undefined);
    if (!validMessage(message, sessionId)) continue;
    if (message.attachments?.length && message.role !== 'user') throw new EngineError('INVALID_CONTEXT', 'Image input references belong to user messages');
    if (message.media?.length && message.role !== 'user') throw new EngineError('INVALID_CONTEXT','Media sources belong to user messages');
    if (message.documents?.length && message.role !== 'user') throw new EngineError('INVALID_CONTEXT', 'Document input references belong to user messages');
    const source: MemorySource = { ordinal: index + 1, message };
    if (message.role === 'tool') continue;
    if (message.role === 'user') {
      blocks.push(block([{ role: 'user', content: message.content, ...(message.attachments === undefined ? {} : { attachments: normalizeImageAttachments(message.attachments) }),
        ...(message.documents === undefined ? {} : { documents: normalizeDocumentAttachments(message.documents) }), ...(message.media === undefined ? {} : { media: normalizeMediaAttachments(message.media) }) }], [source]));
      continue;
    }
    const calls = copyCalls(message.toolCalls);
    if (calls) {
      const expectedIds = new Set(calls.map((call) => call.id));
      const seenIds = new Set<string>();
      const results: ProviderMessage[] = [];
      const sources: MemorySource[] = [source];
      let valid = true;
      let cursor = index + 1;
      // Results must belong to this call block; pairing cannot cross another turn.
      while (cursor < stored.length && stored[cursor]?.role === 'tool' && seenIds.size < calls.length) {
        checkAbort(request.signal);
        const result = stored[cursor];
        checkedMessageReplay(result, sessionId, request.config, result && typeof result === 'object' ? runModels.get(result.runId) : undefined);
        if (!validMessage(result, sessionId) || result.runId !== message.runId
          || typeof result.toolCallId !== 'string' || !expectedIds.has(result.toolCallId)
          || seenIds.has(result.toolCallId)) {
          valid = false;
        } else {
          seenIds.add(result.toolCallId);
          results.push({ role: 'tool', content: result.content, toolCallId: result.toolCallId });
          sources.push({ ordinal: cursor + 1, message: result });
        }
        cursor += 1;
      }
      index = cursor - 1;
      if (valid && seenIds.size === calls.length) {
        blocks.push(block([{
          role: 'assistant', content: message.content, toolCalls: calls,
          ...(providerReplay === undefined ? {} : { providerReplay }),
        }, ...results], sources));
        continue;
      }
    }
    // Interrupted/damaged calls never produce provider-visible dangling results.
    // Preserve explanatory text without claiming the missing calls completed.
    const declaredCalls = message.toolCalls !== undefined && !(Array.isArray(message.toolCalls) && message.toolCalls.length === 0);
    const completedReplay = declaredCalls ? undefined : providerReplay;
    if (message.content.length > 0 || completedReplay !== undefined) blocks.push(block([{
      role: 'assistant', content: message.content,
      ...(completedReplay === undefined ? {} : { providerReplay: completedReplay }),
    }], [source]));
  }
  return blocks;
}

async function readInstructions(request: ContextRequest): Promise<{ text: string; truncated: boolean } | undefined> {
  checkAbort(request.signal);
  const sources = request.instructionSources ?? (await new InstructionSources(request.workspace.root).observe([], request.signal)).sources;
  const sections = sources.filter(source => source.text !== null)
    .map(source => `[Scope: ${source.scope || 'workspace root'}; source: ${source.path}]\n${source.text}`);
  const combined = sections.join('\n\n');
  if (!combined) return undefined;
  const bytes = Buffer.from(combined);
  const truncated = bytes.length > MAX_INSTRUCTION_BYTES;
  return { text: new TextDecoder().decode(bytes.subarray(0, MAX_INSTRUCTION_BYTES), { stream: truncated }), truncated };
}

function fitInstructions(instructions: { text: string; truncated: boolean }, cost: number, count: number, limit: number): ProviderMessage | undefined {
  const makeMessage = (length: number): ProviderMessage => ({
    role: 'system',
    content: INSTRUCTION_PREFIX + codepointPrefix(instructions.text, length)
      + (instructions.truncated || length < instructions.text.length ? TRUNCATION_NOTICE : ''),
  });
  const fits = (message: ProviderMessage): boolean => Buffer.byteLength(message.content, 'utf8') <= MAX_INSTRUCTION_BYTES
    && arrayBytes(cost + entryBytes(message), count + 1) <= limit;
  const full = makeMessage(instructions.text.length);
  if (fits(full)) return full;
  // Every partial candidate includes a truncation notice, so costs are monotone.
  let low = 0;
  let high = instructions.text.length - 1;
  let candidate: ProviderMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = makeMessage(middle);
    if (fits(current)) {
      if (codepointPrefix(instructions.text, middle).length > 0) candidate = current;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

/** Build a bounded provider transcript without exposing incomplete tool exchanges. */
export async function buildContext(request: ContextRequest, options: { requiredOnly?: boolean } = {}): Promise<ProviderMessage[]> {
  checkAbort(request.signal);
  const maxContextBytes = request.config.limits.maxContextBytes;
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 2) {
    throw new EngineError('CONTEXT_LIMIT', 'Context budget must fit a serialized message array.');
  }
  const reservedBytes = request.reservedBytes === undefined ? 0 : request.reservedBytes;
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
    throw new EngineError('CONTEXT_LIMIT', 'Reserved context bytes must be a nonnegative safe integer.');
  }
  // The caller reserves tool schemas and envelope overhead; keep persisted config intact.
  const limit = maxContextBytes - reservedBytes;
  if (limit < 2) {
    throw new EngineError('CONTEXT_LIMIT', 'Context reservation leaves insufficient space for a serialized message array.', {
      maxContextBytes, reservedBytes,
    });
  }
  if (!isAbsolute(request.workspace.root) || request.snapshot.session.workspaceId !== request.workspace.id
    || !Array.isArray(request.snapshot.messages)) {
    throw new EngineError('INVALID_CONTEXT', 'Context workspace and stored session are inconsistent.');
  }
  const blocks = historyBlocks(request);
  let requiredStart = blocks.findLastIndex((item) => item.messages[0]?.role === 'user');
  // A transcript without a user still keeps its latest valid block intact.
  if (requiredStart < 0) requiredStart = Math.max(0, blocks.length - 1);
  const selected = new Set<ContextBlock>();
  if (request.run) {
    const current = blocks.filter(item => item.sources.some(source => source.message.runId === request.run!.id));
    const users = current.filter(item => item.messages[0]?.role === 'user');
    const latestExchange = current.findLast(item => item.messages[0]?.role === 'assistant');
    for (const item of [users[0], users.at(-1), latestExchange, current.at(-1)]) if (item) selected.add(item);
    if (!selected.size && blocks.length) selected.add(blocks.at(-1)!);
  } else for (const item of blocks.slice(requiredStart)) selected.add(item);
  for (const id of request.requiredHistoryMessageIds ?? []) {
    const item = blocks.find(candidate => candidate.sources.some(source => source.message.id === id));
    if (!item) throw new EngineError('IMAGE_HISTORY_INVALID_ANCHOR', 'Required image history text or complete exchange is unavailable');
    selected.add(item);
  }
  // A text projection cannot stand in for omitted pixels. Keep selected history's
  // image-bearing blocks whole until an explicit media compaction policy exists.
  const imageBlocks = blocks.filter(item => item.messages.some(message => message.attachments?.length || message.media?.length));
  for (const item of imageBlocks) selected.add(item);
  const documentBlocks = blocks.filter(item => item.messages.some(message => message.documents?.length));
  for (const item of documentBlocks) selected.add(item);
  let cost = [...selected].reduce((sum, item) => sum + item.cost, 0);
  let count = [...selected].reduce((sum, item) => sum + item.messages.length, 0);
  if (arrayBytes(cost, count) > limit) {
    throw new EngineError(documentBlocks.length ? 'DOCUMENT_CONTEXT_LIMIT' : imageBlocks.length ? 'IMAGE_CONTEXT_LIMIT' : 'CONTEXT_LIMIT', 'Required user anchors and complete exchanges exceed the available context budget.', {
      requiredBytes: arrayBytes(cost, count), maxContextBytes, reservedBytes, availableContextBytes: limit,
    });
  }
  const mediaNotice = request.mediaHistoryNotice;
  if (mediaNotice) {
    if (mediaNotice.role !== 'assistant' || typeof mediaNotice.content !== 'string' || mediaNotice.toolCalls !== undefined
      || mediaNotice.toolCallId !== undefined || mediaNotice.attachments !== undefined || mediaNotice.documents !== undefined || mediaNotice.media !== undefined || mediaNotice.providerReplay !== undefined
      || arrayBytes(cost + entryBytes(mediaNotice), count + 1) > limit) {
      throw new EngineError('IMAGE_HISTORY_METADATA_LIMIT', 'Required image history provenance cannot fit beside the current exchange');
    }
    cost += entryBytes(mediaNotice); count++;
  }
  const documentNotice = request.documentHistoryNotice;
  if (documentNotice) {
    if (documentNotice.role !== 'assistant' || typeof documentNotice.content !== 'string' || documentNotice.toolCalls !== undefined
      || documentNotice.toolCallId !== undefined || documentNotice.attachments !== undefined || documentNotice.documents !== undefined || documentNotice.media !== undefined || documentNotice.providerReplay !== undefined
      || arrayBytes(cost + entryBytes(documentNotice), count + 1) > limit) throw new EngineError('DOCUMENT_HISTORY_METADATA_LIMIT', 'Required document provenance cannot fit beside the current exchange');
    cost += entryBytes(documentNotice); count++;
  }
  const verificationContinuation = request.verificationContinuation;
  if (verificationContinuation) {
    if (verificationContinuation.role !== 'user' || typeof verificationContinuation.content !== 'string' || Buffer.byteLength(verificationContinuation.content) > 9216 || Object.keys(verificationContinuation).some(key => !['role', 'content'].includes(key)) || arrayBytes(cost + entryBytes(verificationContinuation), count + 1) > limit) throw new EngineError('VERIFICATION_CONTEXT_LIMIT', 'Required verification control data cannot fit within the original context budget');
    cost += entryBytes(verificationContinuation); count++;
  }
  const semantic = request.semanticMemory, prefixMemory = request.activePrefixMemory;
  const lifecycleContinuation = request.lifecycleContinuation;
  if (lifecycleContinuation) {
    if (lifecycleContinuation.role !== 'user' || typeof lifecycleContinuation.content !== 'string' || !lifecycleContinuation.content.startsWith('[Moodcode lifecycle continuation v1]\n')
      || Buffer.byteLength(lifecycleContinuation.content) > 8192 || Object.keys(lifecycleContinuation).some(key => !['role', 'content'].includes(key)) || arrayBytes(cost + entryBytes(lifecycleContinuation), count + 1) > limit)
      throw new EngineError('LIFECYCLE_CONTEXT_LIMIT', 'Required lifecycle continuation must fit the original context budget as complete host control data');
    cost += entryBytes(lifecycleContinuation); count++;
  }
  for (const memory of [semantic, prefixMemory]) {
    if (!memory) continue;
    if (memory.role !== 'assistant' || typeof memory.content !== 'string' || arrayBytes(cost + entryBytes(memory), count + 1) > limit) {
      throw new EngineError(prefixMemory ? 'ACTIVE_PREFIX_CONTEXT_LIMIT' : 'CONTEXT_LIMIT', 'Required derived memory cannot fit beside the current exchange');
    }
    cost += entryBytes(memory); count++;
  }
  const profile = request.agentInstructions ? { role: 'system' as const, content: request.agentInstructions } : undefined;
  if (profile && (Buffer.byteLength(profile.content) > MAX_INSTRUCTION_BYTES || arrayBytes(cost + entryBytes(profile), count + 1) > limit)) throw new EngineError(prefixMemory ? 'ACTIVE_PREFIX_CONTEXT_LIMIT' : 'CONTEXT_LIMIT', 'Agent profile instructions cannot fit the current exchange');
  if (profile) { cost += entryBytes(profile); count++; }
  const instructions = await readInstructions(request);
  checkAbort(request.signal);
  const system = instructions ? fitInstructions(instructions, cost, count, limit) : undefined;
  if (system) { cost += entryBytes(system); count += 1; }
  const defaults = agentInstructions(request.config.mode);
  const includeDefaults = arrayBytes(cost + entryBytes(defaults), count + 1) <= limit
    && Buffer.byteLength((system?.content ?? '') + defaults.content, 'utf8') <= MAX_INSTRUCTION_BYTES;
  if (includeDefaults) { cost += entryBytes(defaults); count += 1; }
  const olderCost = blocks.filter(item => !selected.has(item)).reduce((sum, item) => sum + item.cost, 0);
  const available = limit - arrayBytes(cost, count);
  // Reserve part of optional history space only when the full older transcript
  // cannot fit. Required current exchanges and project guidance are already kept.
  const reserve = !options.requiredOnly && !semantic && olderCost > available ? Math.min(MAX_MEMORY_BYTES, Math.floor(available / 4)) : 0;
  const memoryReserve = reserve >= MIN_MEMORY_BYTES ? reserve : 0;
  let nextOptional = options.requiredOnly ? -1 : blocks.length - 1;
  // The required anchors can precede the retained recent suffix. Groups remain indivisible.
  for (; nextOptional >= 0; nextOptional -= 1) {
    checkAbort(request.signal);
    const item = blocks[nextOptional]!;
    if (selected.has(item)) continue;
    if (arrayBytes(cost + item.cost + memoryReserve, count + item.messages.length) > limit) break;
    selected.add(item);
    cost += item.cost;
    count += item.messages.length;
  }
  checkAbort(request.signal);
  const omitted = blocks.filter(item => !selected.has(item));
  const memory = semantic ?? (!options.requiredOnly && omitted.length ? extractiveMemory(
    omitted.flatMap((item) => item.sources),
    limit - arrayBytes(cost, count),
  ) : undefined);
  // Some omitted groups contain only opaque/native state and tool results. If
  // there is no useful excerpt, reclaim the unused reservation for whole groups.
  if (!memory && memoryReserve) {
    for (; nextOptional >= 0; nextOptional--) {
      checkAbort(request.signal);
      const item = blocks[nextOptional]!;
      if (selected.has(item)) continue;
      if (arrayBytes(cost + item.cost, count + item.messages.length) > limit) break;
      selected.add(item);
      cost += item.cost;
      count += item.messages.length;
    }
  }
  checkAbort(request.signal);
  const messages = blocks.filter(item => selected.has(item)).flatMap((item) => item.messages);
  return [...(system ? [system] : []), ...(profile ? [profile] : []), ...(includeDefaults ? [defaults] : []), ...(memory ? [memory] : []), ...(prefixMemory ? [prefixMemory] : []), ...(mediaNotice ? [mediaNotice] : []), ...(documentNotice ? [documentNotice] : []), ...messages, ...(verificationContinuation ? [verificationContinuation] : []), ...(lifecycleContinuation ? [lifecycleContinuation] : [])];
}
