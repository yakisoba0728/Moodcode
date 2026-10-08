import type { DatabaseSync } from "node:sqlite";
import { normalizeDocumentAttachments, normalizeMediaAttachments, normalizeImageAttachments } from "@moodcode/contracts/validation";
import {
  EngineError,
  type Message,
  type Run,
  type SessionSnapshot,
  type ToolCallRecord,
} from "@moodcode/contracts";

export interface ActiveHistoryWindow {
  runId: string;
  strategy: "initial-user-and-latest-user-with-complete-recent-exchanges";
  requiredAnchorIds: string[];
  /** Latest image-bearing user in this active Run; historical Runs are outside this window. */
  requiredImageAnchorIds?: string[];
  requiredDocumentAnchorIds?: string[];
  firstRecentMessageId: string | null;
  selectedMessages: number;
  omittedMessages: number;
  selectedJsonBytes: number;
  metadataRows: number;
  toolContentProjections: Array<{
    messageId: string;
    originalUtf8Bytes: number;
    projectedUtf8Bytes: number;
  }>;
  auxiliary: {
    selectedToolRecords: number;
    omittedToolRecords: number;
    toolOutputs: "omitted-duplicate-message-projection";
    approvals: "not-read-for-model-context";
  };
  summarized: false;
  physicalReadBytes: null;
}
type Candidate = {
  id: string;
  ordinal: number;
  role: Message["role"];
  bytes: number;
};

export interface SessionImageAnchor {
  messageId: string;
  runId: string;
  source: "latest-image-user-in-session";
  messageUtf8Bytes: number;
  runMetadataUtf8Bytes: number;
  physicalReadBytes: null;
}
export interface SessionSegmentAnchor extends Omit<SessionImageAnchor, 'source'> { source:'latest-media-user-in-session' }
export interface SessionDocumentAnchor extends Omit<SessionImageAnchor, 'source'> { source: 'latest-document-user-in-session' }
type HistoryPage = {
  snapshot: SessionSnapshot;
  omittedRuns: number;
  omittedMessages: number;
  beforeRunId: string | null;
  activeWindow?: ActiveHistoryWindow;
  sessionImageAnchor?: SessionImageAnchor;
  sessionDocumentAnchor?: SessionDocumentAnchor;
  sessionSegmentAnchor?: SessionSegmentAnchor;
};

/** Preserve one exact image user across Run pagination; never reconstruct pixels from memory. */
export function withSessionImageAnchor<T extends HistoryPage>(
  database: DatabaseSync, page: T, maxMessages: number, maxBytes: number,
): T {
  return withSessionInputAnchor(database, page, maxMessages, maxBytes, 'image');
}
export function withSessionDocumentAnchor<T extends HistoryPage>(database: DatabaseSync, page: T, maxMessages: number, maxBytes: number): T {
  return withSessionInputAnchor(database, page, maxMessages, maxBytes, 'document');
}
function withSessionInputAnchor<T extends HistoryPage>(database: DatabaseSync, page: T, maxMessages: number, maxBytes: number, kind: 'image' | 'document' | 'segment'): T {
  const field = kind === 'image' ? 'attachments' : kind==='document' ? 'documents' : 'media';
  const limitCode = kind === 'image' ? 'IMAGE_CONTEXT_LIMIT' : 'DOCUMENT_CONTEXT_LIMIT';
  const session = page.snapshot.session;
  const metadata = database.prepare(`SELECT m.id,m.run_id,m.session_id,CAST(m.ordinal AS TEXT) AS ordinal,
    length(CAST(m.data AS BLOB)) AS message_bytes,r.session_id AS run_session_id,r.workspace_id,
    length(CAST(r.data AS BLOB)) AS run_bytes,r.state AS run_state
    FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.session_id=?
    AND json_extract(m.data,'$.role')='user' AND json_type(m.data,'$.${field}')='array'
    AND json_array_length(m.data,'$.${field}')>0 ORDER BY m.ordinal DESC LIMIT 1`).get(session.id);
  if (!metadata) return page;
  const ordinal = Number(metadata.ordinal), messageBytes = Number(metadata.message_bytes), runBytes = Number(metadata.run_bytes);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || metadata.session_id !== session.id
    || metadata.run_session_id !== session.id || metadata.workspace_id !== session.workspaceId) {
    throw new EngineError("MODEL_HISTORY_BINDING_MISMATCH", "Latest image anchor has an inconsistent session owner");
  }
  if (!Number.isSafeInteger(messageBytes) || !Number.isSafeInteger(runBytes) || messageBytes < 1 || runBytes < 1
    || messageBytes + runBytes > maxBytes) throw new EngineError(limitCode, "Latest input anchor exceeds the model history byte budget");
  const row = database.prepare("SELECT data FROM messages WHERE id=? AND session_id=? AND run_id=?").get(String(metadata.id), session.id, String(metadata.run_id));
  const runRow = database.prepare("SELECT data FROM runs WHERE id=? AND session_id=?").get(String(metadata.run_id), session.id);
  if (!row || !runRow) throw new EngineError("MODEL_HISTORY_BINDING_MISMATCH", "Latest image anchor owner is unavailable");
  const message = JSON.parse(String(row.data)) as Message, origin = JSON.parse(String(runRow.data)) as Run;
  if (message.id !== metadata.id || message.runId !== metadata.run_id || message.sessionId !== session.id || message.role !== "user"
    || origin.id !== metadata.run_id || origin.sessionId !== session.id || origin.workspaceId !== session.workspaceId || origin.state !== metadata.run_state) {
    throw new EngineError("MODEL_HISTORY_BINDING_MISMATCH", "Latest image anchor payload has an inconsistent owner");
  }
  try { if (!(kind === 'image' ? normalizeImageAttachments(message.attachments) : kind==='document'?normalizeDocumentAttachments(message.documents):normalizeMediaAttachments(message.media)).length) throw new Error("empty"); }
  catch { throw new EngineError("MODEL_HISTORY_BINDING_MISMATCH", "Latest image anchor references are invalid"); }
  const anchor: SessionImageAnchor | SessionDocumentAnchor | SessionSegmentAnchor = { messageId: message.id, runId: origin.id, source: kind === 'image' ? "latest-image-user-in-session" : kind==='document'?'latest-document-user-in-session':'latest-media-user-in-session',
    messageUtf8Bytes: messageBytes, runMetadataUtf8Bytes: runBytes, physicalReadBytes: null };
  let snapshot = page.snapshot, window = page.activeWindow;
  if (!snapshot.messages.some(item => item.id === message.id)) {
    if (window) {
      const active = snapshot.runs.find(item => item.id === window!.runId);
      const priorIds = new Set([page.sessionImageAnchor?.messageId, page.sessionDocumentAnchor?.messageId, page.sessionSegmentAnchor?.messageId].filter((id): id is string => Boolean(id) && id !== message.id));
      // Active anchors are already mandatory in readActiveHistoryWindow. Reserve
      // only foreign Run inputs here, otherwise the same message is charged twice.
      const priorMessages = snapshot.messages.filter(item => priorIds.has(item.id) && item.runId !== active?.id);
      const priorRuns = snapshot.runs.filter(item => priorMessages.some(prior => prior.runId === item.id) && item.id !== active?.id && item.id !== origin.id);
      const reservedBytes = messageBytes + (active?.id === origin.id ? 0 : runBytes) + (priorMessages.length ? Buffer.byteLength(JSON.stringify({ messages: priorMessages, runs: priorRuns })) : 0) + 128;
      if (!active || maxMessages < 2 + priorMessages.length || maxBytes - reservedBytes < 1024) throw new EngineError(limitCode, "Required input and current Run anchors cannot fit model history");
      try {
        const reduced = readActiveHistoryWindow(database, session, active, snapshot.lastSeq, maxMessages - 1 - priorMessages.length, maxBytes - reservedBytes);
        snapshot = { ...reduced.snapshot, messages: [...priorMessages.filter(item => !reduced.snapshot.messages.some(existing => existing.id === item.id)), ...reduced.snapshot.messages],
          runs: [...priorRuns.filter(item => !reduced.snapshot.runs.some(existing => existing.id === item.id)), ...reduced.snapshot.runs] }; window = reduced.window;
      } catch (error) {
        if (error instanceof EngineError && error.code === "MODEL_HISTORY_LIMIT") throw new EngineError(limitCode, "Required input and current Run exchange cannot fit model history");
        throw error;
      }
    }
    const attach = (base: SessionSnapshot): SessionSnapshot => ({ ...base,
      runs: base.runs.some(item => item.id === origin.id) ? base.runs : [origin, ...base.runs], messages: [message, ...base.messages] });
    snapshot = attach(snapshot);
    // Completed history keeps complete Run groups. Only optional older groups may
    // be dropped to make space for this required, independently bound image user.
    while (!window && (snapshot.messages.length > maxMessages || Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes)) {
      const removable = snapshot.runs.find(item => item.id !== origin.id && item.id !== page.snapshot.runs.at(-1)?.id
        && item.id !== page.sessionImageAnchor?.runId && item.id !== page.sessionDocumentAnchor?.runId && item.id !== page.sessionSegmentAnchor?.runId);
      if (!removable) break;
      snapshot = { ...snapshot, runs: snapshot.runs.filter(item => item.id !== removable.id),
        messages: snapshot.messages.filter(item => item.runId !== removable.id), tools: snapshot.tools.filter(item => item.runId !== removable.id),
        approvals: snapshot.approvals.filter(item => item.runId !== removable.id) };
    }
  }
  if (kind !== 'image' && snapshot.messages.length > 1) {
    const ids = snapshot.messages.map(item => item.id);
    const ordered = database.prepare(`SELECT id FROM messages WHERE session_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY ordinal`).all(session.id, ...ids);
    const positions = new Map(ordered.map((item, position) => [String(item.id), position]));
    const runIds = snapshot.runs.map(item => item.id);
    const orderedRuns = database.prepare(`SELECT id FROM runs WHERE session_id=? AND id IN (${runIds.map(() => '?').join(',')}) ORDER BY ordinal`).all(session.id, ...runIds);
    const runPositions = new Map(orderedRuns.map((item, position) => [String(item.id), position]));
    snapshot = { ...snapshot, messages: [...snapshot.messages].sort((left, right) => positions.get(left.id)! - positions.get(right.id)!),
      runs: [...snapshot.runs].sort((left, right) => runPositions.get(left.id)! - runPositions.get(right.id)!) };
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (snapshot.messages.length > maxMessages || bytes > maxBytes) throw new EngineError(limitCode, "Latest inputs and required current history exceed model history limits");
  const totalRuns = Number(database.prepare("SELECT count(*) AS count FROM runs WHERE session_id=?").get(session.id)?.count);
  const totalMessages = Number(database.prepare("SELECT count(*) AS count FROM messages WHERE session_id=?").get(session.id)?.count);
  return { ...page, snapshot, omittedRuns: totalRuns - snapshot.runs.length, omittedMessages: totalMessages - snapshot.messages.length,
    beforeRunId: totalRuns > snapshot.runs.length ? snapshot.runs[0]?.id ?? null : null,
    ...(window ? { activeWindow: window } : {}), ...(kind === 'image' ? { sessionImageAnchor: anchor as SessionImageAnchor } : kind==='document'?{ sessionDocumentAnchor: anchor as SessionDocumentAnchor }:{sessionSegmentAnchor:anchor as SessionSegmentAnchor}) };
}

// SQL never returns the original large content to JavaScript. All remaining fields,
// including opaque provider replay and attachments, retain their original identity.
const MESSAGE_PROJECTION = `CASE WHEN json_extract(data,'$.role')='tool' AND length(CAST(json_extract(data,'$.content') AS BLOB))>4096 THEN
  json_set(data,'$.content','[Moodcode bounded tool observation v1; original transcript retained] ' ||
    json_object('messageId',id,'originalUtf8Bytes',length(CAST(json_extract(data,'$.content') AS BLOB)),
      'excerpt',substr(json_extract(data,'$.content'),1,512),'excerptCharacters',min(length(json_extract(data,'$.content')),512),
      'omittedCharacters',max(length(json_extract(data,'$.content'))-512,0),'completeContent',json('false'),
      'artifactReferences',json((SELECT json_group_array(json_object('id',json_extract(value,'$.id'),'sha256',json_extract(value,'$.sha256'),
        'storedBytes',json_extract(value,'$.storedBytes'),'complete',json_extract(value,'$.complete'),'outcome',json_extract(value,'$.outcome')))
        FROM (SELECT value FROM json_each(messages.data,'$.toolResult.artifactRefs') LIMIT 4))),
      'omittedArtifactReferences',max(coalesce(json_array_length(data,'$.toolResult.artifactRefs'),0)-4,0)))
  ELSE data END`;

/** Split only an active Run. Completed Run pagination continues to use whole groups. */
export function readActiveHistoryWindow(
  database: DatabaseSync,
  session: SessionSnapshot["session"],
  run: Run,
  lastSeq: number,
  maxMessages: number,
  maxBytes: number,
): { snapshot: SessionSnapshot; window: ActiveHistoryWindow } {
  const mapCandidate = (row: Record<string, unknown>): Candidate => ({
    id: String(row.id),
    ordinal: Number(row.ordinal),
    role: String(row.role) as Message["role"],
    bytes: Number(row.bytes),
  });
  const metadata = database
    .prepare(
      `SELECT id,ordinal,json_extract(data,'$.role') AS role,length(CAST(${MESSAGE_PROJECTION} AS BLOB)) AS bytes
    FROM messages WHERE run_id=? ORDER BY ordinal DESC LIMIT ?`,
    )
    .all(run.id, maxMessages + 1)
    .map(mapCandidate)
    .reverse();
  const anchorMetadata = database
    .prepare(
      `WITH latest_image AS (SELECT max(ordinal) AS ordinal FROM messages WHERE run_id=?
       AND json_extract(data,'$.role')='user' AND json_type(data,'$.attachments')='array'
       AND json_array_length(data,'$.attachments')>0),
     latest_document AS (SELECT max(ordinal) AS ordinal FROM messages WHERE run_id=?
       AND json_extract(data,'$.role')='user' AND json_type(data,'$.documents')='array' AND json_array_length(data,'$.documents')>0)
    SELECT id,ordinal,json_extract(data,'$.role') AS role,length(CAST(data AS BLOB)) AS bytes,
     ordinal=(SELECT ordinal FROM latest_image) AS required_image,ordinal=(SELECT ordinal FROM latest_document) AS required_document
    FROM messages WHERE run_id=? AND ordinal IN
    ((SELECT min(ordinal) FROM messages WHERE run_id=? AND json_extract(data,'$.role')='user'),
     (SELECT max(ordinal) FROM messages WHERE run_id=? AND json_extract(data,'$.role')='user'),
     (SELECT ordinal FROM latest_image),(SELECT ordinal FROM latest_document)) ORDER BY ordinal`,
    )
    .all(run.id, run.id, run.id, run.id, run.id);
  const anchors = anchorMetadata.map(mapCandidate);
  const requiredImageAnchorIds = anchorMetadata.filter(row => Number(row.required_image) === 1).map(row => String(row.id));
  const requiredDocumentAnchorIds = anchorMetadata.filter(row => Number(row.required_document) === 1).map(row => String(row.id));
  if (!anchors.length)
    throw new EngineError(
      "MODEL_HISTORY_LIMIT",
      "Active Run has no required user anchor",
    );
  const anchorIds = new Set(anchors.map((row) => row.id));
  // A block begins with a user/assistant and includes its contiguous tool results.
  // Metadata LIMIT may begin in an old result batch; that incomplete prefix is omitted.
  const groups: Candidate[][] = [];
  for (const row of metadata) {
    if (row.role === "tool") {
      groups.at(-1)?.push(row);
      continue;
    }
    groups.push([row]);
  }
  const latestAssistant = database
    .prepare(
      "SELECT ordinal FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' ORDER BY ordinal DESC LIMIT 1",
    )
    .get(run.id);
  if (
    latestAssistant &&
    !metadata.some((row) => row.ordinal === Number(latestAssistant.ordinal))
  )
    throw new EngineError(
      "MODEL_HISTORY_LIMIT",
      "The newest required assistant/tool exchange exceeds the model message budget",
    );
  const initialBytes =
    Buffer.byteLength(
      JSON.stringify({
        session,
        runs: [run],
        messages: [],
        tools: [],
        approvals: [],
        lastSeq,
      }),
    ) + 128;
  let bytes =
    initialBytes + anchors.reduce((total, row) => total + row.bytes + 1, 0);
  let count = anchors.length;
  if (count > maxMessages || bytes > maxBytes)
    throw new EngineError(
      "MODEL_HISTORY_LIMIT",
      "Required active Run anchors exceed the model history budget",
    );
  const selected = new Map(anchors.map((row) => [row.id, row]));
  let newestExchange = false;
  for (const group of groups.toReversed()) {
    const added = group.filter((row) => !selected.has(row.id));
    const required = !newestExchange && group[0]?.role === "assistant";
    const groupBytes = added.reduce((sum, row) => sum + row.bytes + 1, 0);
    if (count + added.length > maxMessages || bytes + groupBytes > maxBytes) {
      if (required)
        throw new EngineError(
          "MODEL_HISTORY_LIMIT",
          "The newest required assistant/tool exchange exceeds the model history budget",
        );
      break;
    }
    for (const row of added) selected.set(row.id, row);
    count += added.length;
    bytes += groupBytes;
    if (group[0]?.role === "assistant") newestExchange = true;
  }
  const ids = [...selected.values()]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const selectedRows = database
    .prepare(
      `SELECT id,${MESSAGE_PROJECTION} AS data,
    length(CAST(json_extract(data,'$.content') AS BLOB)) AS original_content_bytes
    FROM messages WHERE run_id=? AND id IN (${placeholders}) ORDER BY ordinal`,
    )
    .all(run.id, ...ids);
  const messages = selectedRows.map(
    (row) => JSON.parse(String(row.data)) as Message,
  );
  // Tool outputs already have a message; avoid a second copy. Recent tool inputs
  // are useful for path-specific instruction discovery, but are independently bounded.
  const toolMetadata = database
    .prepare(
      "SELECT id,length(CAST(json_remove(data,'$.output','$.error') AS BLOB)) AS bytes FROM tools WHERE run_id=? ORDER BY ordinal DESC LIMIT 32",
    )
    .all(run.id);
  const toolIds: string[] = [];
  let toolBytes = 0;
  for (const row of toolMetadata) {
    if (bytes + toolBytes + Number(row.bytes) + 1 > maxBytes) break;
    toolIds.push(String(row.id));
    toolBytes += Number(row.bytes) + 1;
  }
  const tools = toolIds.length
    ? database
        .prepare(
          `SELECT json_remove(data,'$.output','$.error') AS data FROM tools WHERE run_id=? AND id IN (${toolIds.map(() => "?").join(",")}) ORDER BY ordinal`,
        )
        .all(run.id, ...toolIds)
        .map((row) => JSON.parse(String(row.data)) as ToolCallRecord)
    : [];
  const snapshot: SessionSnapshot = {
    session,
    runs: [run],
    messages,
    tools,
    approvals: [],
    lastSeq,
  };
  const selectedJsonBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (selectedJsonBytes > maxBytes)
    throw new EngineError(
      "MODEL_HISTORY_LIMIT",
      "Required active Run projection exceeds the model history budget",
    );
  const total = Number(
    database
      .prepare("SELECT count(*) AS count FROM messages WHERE run_id=?")
      .get(run.id)?.count,
  );
  const totalTools = Number(
    database
      .prepare("SELECT count(*) AS count FROM tools WHERE run_id=?")
      .get(run.id)?.count,
  );
  return {
    snapshot,
    window: {
      runId: run.id,
      strategy: "initial-user-and-latest-user-with-complete-recent-exchanges",
      requiredAnchorIds: [...anchorIds],
      ...(requiredImageAnchorIds.length ? { requiredImageAnchorIds } : {}),
      ...(requiredDocumentAnchorIds.length ? { requiredDocumentAnchorIds } : {}),
      firstRecentMessageId:
        messages.find((message) => !anchorIds.has(message.id))?.id ?? null,
      selectedMessages: messages.length,
      omittedMessages: total - messages.length,
      selectedJsonBytes,
      metadataRows:
        metadata.length +
        anchors.length +
        toolMetadata.length +
        (latestAssistant ? 1 : 0),
      toolContentProjections: selectedRows.flatMap((row, index) =>
        Number(row.original_content_bytes) > 4096 &&
        messages[index]?.role === "tool"
          ? [
              {
                messageId: String(row.id),
                originalUtf8Bytes: Number(row.original_content_bytes),
                projectedUtf8Bytes: Buffer.byteLength(messages[index]!.content),
              },
            ]
          : [],
      ),
      auxiliary: {
        selectedToolRecords: tools.length,
        omittedToolRecords: totalTools - tools.length,
        toolOutputs: "omitted-duplicate-message-projection",
        approvals: "not-read-for-model-context",
      },
      summarized: false,
      physicalReadBytes: null,
    },
  };
}

export function withSessionSegmentAnchor<T extends HistoryPage>(database:DatabaseSync,page:T,maxMessages:number,maxBytes:number):T{return withSessionInputAnchor(database,page,maxMessages,maxBytes,'segment');}
