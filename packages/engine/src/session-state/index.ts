import { EngineError, type JsonObject, type JsonValue, type Session } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';

export interface SessionDocument { revision: number; data: JsonObject }
export interface SessionDocumentStore {
  getSession(id: string): Session;
  getSessionDocument(sessionId: string, kind: string): SessionDocument | null;
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): SessionDocument;
}
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export interface SessionTask { id: string; title: string; status: TaskStatus }
export interface SessionTasks { revision: number; tasks: SessionTask[] }

/** Planning state has its own revision; it never admits inputs or approves effects. */
export class SessionTaskService {
  constructor(private readonly store: SessionDocumentStore) {}
  get(sessionId: string): SessionTasks {
    this.store.getSession(sessionId);
    const document = this.store.getSessionDocument(sessionId, 'tasks');
    return { revision: document?.revision ?? 0, tasks: structuredClone((document?.data.tasks ?? []) as unknown as SessionTask[]) };
  }
  replace(sessionId: string, expectedRevision: number, value: unknown): SessionTasks {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new EngineError('INVALID_TASK_REVISION', 'Task revision must be a nonnegative integer');
    const normalized = boundedJson(value, 65_536);
    if (!Array.isArray(normalized) || normalized.length > 128) throw new EngineError('INVALID_TASKS', 'Tasks require an array of at most 128 entries');
    const ids = new Set<string>();
    const tasks = normalized.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'title', 'status'].includes(key))) throw new EngineError('INVALID_TASKS', 'Task entries require id, title and status');
      const { id, title, status } = entry;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id) || ids.has(id)
        || typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 1024 || /[\u0000-\u001f\u007f]/.test(title)
        || typeof status !== 'string' || !['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) throw new EngineError('INVALID_TASKS', 'Invalid or duplicate task entry');
      ids.add(id);
      return { id, title, status };
    });
    const result = this.store.putSessionDocument(sessionId, 'tasks', expectedRevision, { tasks: tasks as JsonValue });
    return { revision: result.revision, tasks: tasks as SessionTask[] };
  }
}
