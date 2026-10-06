import { randomUUID } from 'node:crypto';
import { EngineError, isTerminal, type JsonObject, type Run, type SessionSnapshot } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';
import type { SessionDocumentStore } from '../session-state/index.js';

export interface QuestionSpec { prompt: string; options: { id: string; label: string }[]; allowFreeText: boolean; multiple: boolean }
export interface QuestionAnswer { optionIds: string[]; text?: string }
export interface QuestionRecord {
  id: string; version: number; sessionId: string; runId: string; toolCallId: string;
  spec: QuestionSpec; status: 'pending' | 'answered' | 'rejected' | 'expired'; createdAt: string; expiresAt: string; answer?: QuestionAnswer;
}
export interface QuestionStore extends SessionDocumentStore { getRun(id: string): Run; getSnapshot(sessionId: string): SessionSnapshot }
interface Wait { record: QuestionRecord; promise: Promise<QuestionRecord>; resolve(record: QuestionRecord): void; reject(error: unknown): void; detach(): void }

function fail(code: string, message: string): never { throw new EngineError(code, message); }
function record(value: unknown): Record<string, unknown> {
  const copy = boundedJson(value, 32_768);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) fail('INVALID_QUESTION', 'Question data requires an object');
  return copy;
}
export function normalizeQuestionSpec(value: unknown): QuestionSpec {
  const input = record(value);
  if (Object.keys(input).some(key => !['prompt', 'options', 'allowFreeText', 'multiple'].includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 4096) fail('INVALID_QUESTION', 'Question prompt must be bounded nonempty text');
  const options = input.options ?? [];
  if (!Array.isArray(options) || options.length > 12) fail('INVALID_QUESTION', 'Question permits at most twelve options');
  const ids = new Set<string>();
  const normalized = options.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'label'].includes(key))) fail('INVALID_QUESTION', 'Question option needs an ID and label');
    const { id, label } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id) || ids.has(id) || typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 1024) fail('INVALID_QUESTION', 'Question option is invalid or duplicated');
    ids.add(id); return { id, label };
  });
  const allowFreeText = input.allowFreeText ?? true;
  const multiple = input.multiple ?? false;
  if (typeof allowFreeText !== 'boolean' || typeof multiple !== 'boolean' || !allowFreeText && !normalized.length) fail('INVALID_QUESTION', 'Question must permit at least one answer');
  return { prompt: input.prompt, options: normalized, allowFreeText, multiple };
}

/** Durable question decisions only resume a live, exactly bound tool waiter. */
export class QuestionManager {
  private readonly waits = new Map<string, Wait>();
  constructor(private readonly store: QuestionStore) {}
  private all(sessionId: string): QuestionRecord[] {
    const document = this.store.getSessionDocument(sessionId, 'questions');
    return structuredClone((document?.data.records ?? []) as unknown as QuestionRecord[]);
  }
  private save(question: QuestionRecord): void {
    const document = this.store.getSessionDocument(question.sessionId, 'questions');
    let records = structuredClone((document?.data.records ?? []) as unknown as QuestionRecord[]);
    const index = records.findIndex(record => record.id === question.id);
    if (index < 0) records.push(question); else records[index] = question;
    while (records.length > 64) {
      const terminal = records.findIndex(record => record.status !== 'pending');
      if (terminal < 0) fail('QUESTION_LIMIT', 'Session question history is full');
      records.splice(terminal, 1);
    }
    const data = JSON.parse(JSON.stringify({ records })) as JsonObject;
    this.store.putSessionDocument(question.sessionId, 'questions', document?.revision ?? 0, data);
  }
  private live(question: QuestionRecord): void {
    const run = this.store.getRun(question.runId);
    if (run.sessionId !== question.sessionId || isTerminal(run.state) || run.state === 'cancelling') fail('QUESTION_STALE', 'Question Run is no longer active');
    const tool = this.store.getSnapshot(question.sessionId).tools.find(tool => tool.id === question.toolCallId);
    if (!tool || tool.runId !== question.runId || tool.sessionId !== question.sessionId || !['requested', 'running', 'awaiting_approval'].includes(tool.state)) fail('QUESTION_STALE', 'Question tool owner is no longer active');
  }
  list(sessionId: string): QuestionRecord[] {
    this.store.getSession(sessionId);
    for (const question of this.all(sessionId)) if (question.status === 'pending' && (!this.waits.has(question.id) || Date.now() >= Date.parse(question.expiresAt))) this.expire(question);
    return this.all(sessionId);
  }
  request(input: { sessionId: string; runId: string; toolCallId: string; spec: unknown; timeoutMs?: number }, signal: AbortSignal): Promise<QuestionRecord> {
    try {
      if (signal.aborted) fail('QUESTION_CANCELLED', 'Question request was cancelled');
      const spec = normalizeQuestionSpec(input.spec);
      const timeoutMs = input.timeoutMs ?? 300_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !input.toolCallId || Buffer.byteLength(input.toolCallId) > 256) fail('INVALID_QUESTION', 'Question owner and timeout are invalid');
      const questions = this.all(input.sessionId);
      const prior = questions.find(question => question.runId === input.runId && question.toolCallId === input.toolCallId);
      if (prior) {
        if (JSON.stringify(prior.spec) !== JSON.stringify(spec)) fail('QUESTION_CONFLICT', 'A different question is already bound to this tool');
        const wait = this.waits.get(prior.id);
        if (prior.status !== 'pending' || !wait) { if (prior.status === 'pending') this.expire(prior); fail('QUESTION_STALE', 'Question has no live waiter'); }
        return wait.promise;
      }
      if (questions.filter(question => question.status === 'pending').length >= 32) fail('QUESTION_LIMIT', 'Too many pending questions');
      const createdAt = new Date().toISOString();
      const question: QuestionRecord = { id: randomUUID(), version: 1, sessionId: input.sessionId, runId: input.runId, toolCallId: input.toolCallId, spec, status: 'pending', createdAt, expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
      this.live(question);
      let resolve!: Wait['resolve'], reject!: Wait['reject'];
      const promise = new Promise<QuestionRecord>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      const abort = () => this.expire(question);
      const timer = setTimeout(abort, timeoutMs);
      const wait: Wait = { record: question, promise, resolve, reject, detach: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } };
      this.waits.set(question.id, wait);
      signal.addEventListener('abort', abort, { once: true });
      try { this.save(question); }
      catch (error) { this.waits.delete(question.id); wait.detach(); reject(error); }
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private expire(question: QuestionRecord): void {
    if (question.status !== 'pending') return;
    const wait = this.waits.get(question.id);
    const expired: QuestionRecord = { ...question, version: question.version + 1, status: 'expired' };
    let error: unknown = new EngineError('QUESTION_EXPIRED', 'Question expired, was cancelled, or lost its execution owner');
    try { this.save(expired); } catch (failure) { error = failure; }
    this.waits.delete(question.id); wait?.detach(); wait?.reject(error);
  }
  answer(sessionId: string, questionId: string, version: number, value: unknown): QuestionRecord {
    const question = this.all(sessionId).find(record => record.id === questionId);
    if (!question) fail('QUESTION_NOT_FOUND', 'Question does not belong to this session');
    const input = record(value);
    if (Object.keys(input).some(key => !['optionIds', 'text'].includes(key)) || !Array.isArray(input.optionIds) || input.optionIds.some(value => typeof value !== 'string')
      || new Set(input.optionIds).size !== input.optionIds.length || input.optionIds.some(id => !question.spec.options.some(option => option.id === id))
      || !question.spec.multiple && input.optionIds.length > 1 || input.text !== undefined && (typeof input.text !== 'string' || !question.spec.allowFreeText || Buffer.byteLength(input.text) > 8192)
      || input.optionIds.length === 0 && !(typeof input.text === 'string' && input.text.trim())) fail('INVALID_QUESTION_ANSWER', 'Answer must match the question options and free-text policy');
    const answer: QuestionAnswer = { optionIds: input.optionIds as string[], ...(input.text === undefined ? {} : { text: input.text as string }) };
    if (question.status === 'answered' && question.version === version + 1 && JSON.stringify(question.answer) === JSON.stringify(answer)) return question;
    return this.decide(question, version, 'answered', answer);
  }
  reject(sessionId: string, questionId: string, version: number): QuestionRecord {
    const question = this.all(sessionId).find(record => record.id === questionId);
    if (!question) fail('QUESTION_NOT_FOUND', 'Question does not belong to this session');
    if (question.status === 'rejected' && question.version === version + 1) return question;
    return this.decide(question, version, 'rejected');
  }
  private decide(question: QuestionRecord, version: number, status: 'answered' | 'rejected', answer?: QuestionAnswer): QuestionRecord {
    const wait = this.waits.get(question.id);
    if (!Number.isSafeInteger(version) || version !== question.version || question.status !== 'pending') fail('QUESTION_CONFLICT', 'Question version or committed decision differs');
    if (!wait || Date.now() >= Date.parse(question.expiresAt)) { this.expire(question); fail('QUESTION_STALE', 'Question has no live execution owner'); }
    try { this.live(question); } catch (error) { this.expire(question); throw error; }
    const resolved: QuestionRecord = { ...question, version: version + 1, status, ...(answer ? { answer } : {}) };
    this.save(resolved);
    this.waits.delete(question.id); wait.detach();
    if (status === 'answered') wait.resolve(structuredClone(resolved)); else wait.reject(new EngineError('QUESTION_REJECTED', 'User rejected the question'));
    return resolved;
  }
  close(): void { for (const wait of [...this.waits.values()]) this.expire(wait.record); }
}
