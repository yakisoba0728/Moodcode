import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SESSION_SCHEMA_VERSION, type AcceptInput, type InputRecord, type Run, type SessionEventV2 } from '@moodcode/contracts';

/** Independent v2 identities and sequence; the existing Run-owned v1 journal is unchanged. */
const NATIVE_SESSION_SCHEMA = `
  CREATE INDEX model_messages_run ON messages(run_id,ordinal);
  CREATE INDEX model_tools_run ON tools(run_id,ordinal);
  CREATE INDEX model_approvals_run ON approvals(run_id,ordinal);
  CREATE TABLE session_sequences (session_id TEXT PRIMARY KEY REFERENCES sessions(id), last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0)) STRICT;
  CREATE TABLE session_controls (session_id TEXT PRIMARY KEY REFERENCES sessions(id), paused INTEGER NOT NULL CHECK(paused IN (0,1)), revision INTEGER NOT NULL CHECK(revision >= 0), data TEXT NOT NULL) STRICT;
  CREATE TABLE session_inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, delivery TEXT NOT NULL CHECK(delivery IN ('queue','steer')), state TEXT NOT NULL CHECK(state IN ('pending','promoted','cancelled')), admitted_seq INTEGER NOT NULL CHECK(admitted_seq > 0), promoted_seq INTEGER, run_id TEXT REFERENCES runs(id), legacy_seq INTEGER, bytes INTEGER NOT NULL CHECK(bytes >= 0), data TEXT NOT NULL, UNIQUE(session_id,request_id), UNIQUE(session_id,admitted_seq), CHECK((state='promoted' AND run_id IS NOT NULL AND promoted_seq IS NOT NULL AND legacy_seq IS NOT NULL AND promoted_seq > admitted_seq AND legacy_seq > 0) OR (state IN ('pending','cancelled') AND run_id IS NULL AND promoted_seq IS NULL AND legacy_seq IS NULL))) STRICT;
  CREATE INDEX session_inputs_pending ON session_inputs(session_id,state,delivery,admitted_seq);
  CREATE TABLE session_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL CHECK(turn_index >= 0), state TEXT NOT NULL CHECK(state IN ('created','streaming','awaiting_tools','completed','failed','interrupted','uncertain')), data TEXT NOT NULL, UNIQUE(run_id,turn_index)) STRICT;
  CREATE INDEX session_turns_page ON session_turns(run_id,turn_index);
  CREATE TABLE provider_attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT NOT NULL REFERENCES session_turns(id), attempt_index INTEGER NOT NULL CHECK(attempt_index >= 0 AND attempt_index < 16), state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','streaming','completed','failed','interrupted','uncertain')), data TEXT NOT NULL, UNIQUE(turn_id,attempt_index)) STRICT;
  CREATE INDEX provider_attempts_turn ON provider_attempts(turn_id,attempt_index);
  CREATE TABLE message_parts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT NOT NULL REFERENCES session_turns(id), message_id TEXT NOT NULL, part_index INTEGER NOT NULL CHECK(part_index >= 0), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL CHECK(state IN ('open','completed','failed','interrupted')), data TEXT NOT NULL, UNIQUE(message_id,part_index)) STRICT;
  CREATE INDEX message_parts_turn ON message_parts(turn_id,message_id,part_index);
  CREATE TABLE context_revisions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL CHECK(revision > 0), run_id TEXT REFERENCES runs(id), turn_id TEXT REFERENCES session_turns(id), supersedes_id TEXT REFERENCES context_revisions(id), data TEXT NOT NULL, UNIQUE(session_id,revision)) STRICT;
  CREATE TABLE session_documents (session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64), revision INTEGER NOT NULL CHECK(revision > 0), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 262144), PRIMARY KEY(session_id,kind)) STRICT;
  CREATE TABLE session_events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=2), run_id TEXT REFERENCES runs(id), input_id TEXT REFERENCES session_inputs(id), turn_id TEXT REFERENCES session_turns(id), attempt_id TEXT REFERENCES provider_attempts(id), type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq)) STRICT;
`;
export const NATIVE_SESSION_TABLES = ['session_sequences', 'session_controls', 'session_inputs', 'session_turns', 'provider_attempts', 'message_parts', 'context_revisions', 'session_documents', 'session_events'] as const;

export function requestIdentity(input: AcceptInput): string {
  return canonical(input);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value)!;
}

/** Backfill request bindings only. Original v1 JSON, ordinals and event cursors are never rewritten. */
export function migrateNativeSessions(database: DatabaseSync): void {
  database.exec(NATIVE_SESSION_SCHEMA);
  const rows = database.prepare('SELECT inputs.id,inputs.data AS input_data,inputs.admitted_seq,runs.data AS run_data FROM inputs JOIN runs ON runs.input_id=inputs.id ORDER BY runs.ordinal').all();
  for (const row of rows) {
    const input = JSON.parse(String(row.input_data)) as Omit<AcceptInput, 'delivery'>;
    const run = JSON.parse(String(row.run_data)) as Run;
    const accepted: AcceptInput = { ...input, delivery: 'queue' };
    database.prepare('INSERT OR IGNORE INTO session_sequences(session_id,last_seq) VALUES(?,0)').run(input.sessionId);
    const previous = Number(database.prepare('SELECT last_seq FROM session_sequences WHERE session_id=?').get(input.sessionId)?.last_seq);
    const admittedSeq = previous + 1, promotedSeq = previous + 2;
    const record: InputRecord = { ...accepted, schemaVersion: SESSION_SCHEMA_VERSION, id: String(row.id), workspaceId: run.workspaceId, state: 'promoted', admittedSeq, promotedSeq, runId: run.id, createdAt: run.createdAt, updatedAt: run.createdAt };
    database.prepare('INSERT INTO session_inputs(id,session_id,workspace_id,request_id,fingerprint,delivery,state,admitted_seq,promoted_seq,run_id,legacy_seq,bytes,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.id, record.sessionId, record.workspaceId, record.requestId, requestIdentity(accepted), 'queue', 'promoted', admittedSeq, promotedSeq, run.id, Number(row.admitted_seq), Buffer.byteLength(JSON.stringify(accepted)), JSON.stringify(record));
    for (const [seq, type] of [[admittedSeq, 'input.legacy_bound'], [promotedSeq, 'input.promoted']] as const) {
      const event: SessionEventV2 = { schemaVersion: SESSION_SCHEMA_VERSION, stream: 'session-v2', eventId: randomUUID(), sessionId: record.sessionId, seq, timestamp: run.createdAt, type, inputId: record.id, runId: run.id, payload: { legacy: true, requestId: input.requestId } };
      database.prepare('INSERT INTO session_events(session_id,seq,event_id,schema_version,run_id,input_id,type,data) VALUES(?,?,?,?,?,?,?,?)').run(record.sessionId, seq, event.eventId, SESSION_SCHEMA_VERSION, run.id, record.id, type, JSON.stringify(event));
    }
    database.prepare('UPDATE session_sequences SET last_seq=? WHERE session_id=?').run(promotedSeq, input.sessionId);
  }
}
