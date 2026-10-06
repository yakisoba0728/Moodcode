import { DatabaseSync } from 'node:sqlite';
import { EngineError, type Message } from '@moodcode/contracts';

export interface HistorySearchOptions { query: string; beforeMessageId?: string; limit?: number; maxBytes?: number }
export interface HistorySearchMatch { messageId: string; runId: string; role: Message['role']; createdAt: string; snippet: string; contentBytes: number; truncated: boolean }
export interface HistorySearchPage { matches: HistorySearchMatch[]; nextCursor: string | null }

/** Only plain content is projected: providerReplay/native continuation data is never searched or returned. */
export function searchHistoryDatabase(database: DatabaseSync, sessionId: string, options: HistorySearchOptions): HistorySearchPage {
  const limit = options?.limit ?? 50, maxBytes = options?.maxBytes ?? 262_144, query = options?.query;
  if (typeof query !== 'string' || !query.trim() || query.includes('\0') || Buffer.byteLength(query) > 1024 || Buffer.from(query).toString() !== query) throw new EngineError('INVALID_HISTORY_QUERY', 'History query must be a nonempty UTF-8 literal of at most 1024 bytes');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1_048_576) throw new EngineError('INVALID_HISTORY_SEARCH_LIMIT', 'History search needs a limit of 1..100 and byte budget of 1024..1048576');
  let before = Number.MAX_SAFE_INTEGER;
  if (options.beforeMessageId !== undefined) {
    const cursor = database.prepare('SELECT ordinal FROM messages WHERE id=? AND session_id=?').get(options.beforeMessageId, sessionId);
    if (!cursor) throw new EngineError('INVALID_HISTORY_SEARCH_CURSOR', 'History search cursor does not belong to this session');
    before = Number(cursor.ordinal);
  }
  const literal = `%${query.replace(/[\\%_]/g, character => '\\' + character)}%`;
  // SQLite handles large source strings; only a bounded character excerpt crosses into JavaScript.
  const rows = database.prepare(`SELECT id,run_id,json_extract(data,'$.role') AS role,json_extract(data,'$.createdAt') AS created_at,
    substr(json_extract(data,'$.content'),max(1,instr(lower(json_extract(data,'$.content')),lower(?))-160),512) AS snippet,
    length(CAST(json_extract(data,'$.content') AS BLOB)) AS content_bytes,
    length(json_extract(data,'$.content')) AS content_characters,
    max(1,instr(lower(json_extract(data,'$.content')),lower(?))-160) AS excerpt_start
    FROM messages WHERE session_id=? AND ordinal<? AND json_extract(data,'$.content') LIKE ? ESCAPE '\\'
    ORDER BY ordinal DESC LIMIT ?`).all(query, query, sessionId, before, literal, limit + 1);
  const matches: HistorySearchMatch[] = []; let bytes = Buffer.byteLength('{"matches":[],"nextCursor":null}');
  for (const row of rows.slice(0, limit)) {
    if (!['user', 'assistant', 'tool'].includes(String(row.role)) || typeof row.created_at !== 'string' || typeof row.snippet !== 'string') throw new EngineError('INVALID_RECORD', 'History message projection is invalid');
    const match: HistorySearchMatch = { messageId: String(row.id), runId: String(row.run_id), role: row.role as Message['role'], createdAt: row.created_at, snippet: row.snippet,
      contentBytes: Number(row.content_bytes), truncated: Number(row.excerpt_start) > 1 || Number(row.content_characters) > 512 };
    const cost = Buffer.byteLength(JSON.stringify(match)) + 1 + Buffer.byteLength(JSON.stringify(match.messageId));
    if (bytes + cost > maxBytes) {
      if (!matches.length) throw new EngineError('HISTORY_SEARCH_LIMIT', 'One history excerpt exceeds the requested response budget');
      break;
    }
    matches.push(match); bytes += cost;
  }
  return { matches, nextCursor: rows.length > matches.length ? matches.at(-1)!.messageId : null };
}
