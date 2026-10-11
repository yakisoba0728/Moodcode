import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { canonicalSha256, sameCanonical } from '../shared/canonical.js';
import { readBoundedBody } from './evidence-read.js';

/** Fields every journaled revision stores next to its module body. */
export interface JournalRecord<K extends string = string> {
  readonly id: string;
  readonly kind: K;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly lastReceiptId: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface JournalReceipt<K extends string = string> {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: K;
  readonly entityId: string;
  readonly operation: string;
  readonly beforeRevisionId: string | null;
  readonly afterRevisionId: string;
  readonly afterSha256: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly requestInput: object;
  readonly createdAt: string;
  readonly sha256: string;
}
/** Header columns of a revisions row; `bytes` is the stored data length. */
export interface JournalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly entity_id: string;
  readonly revision: number;
  readonly previous_id: string | null;
  readonly request_scope: string;
  readonly request_id: string;
  readonly request_sha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly [column: string]: SQLOutputValue;
}
export interface JournalHead { readonly workspace_id: string; readonly kind: string; readonly entity_id: string; readonly revision_id: string; readonly revision: number; readonly sha256: string }
export interface JournalPair<R, T> { readonly record: R; readonly receipt: T }
export interface JournalBudget { readonly rows: number; readonly bytes: number }
/** Persisted conventions of one journal; everything that differs between modules lives here. */
export interface RevisionJournalProfile<K extends string, R extends JournalRecord<K>> {
  readonly revisions: string;
  readonly heads: string;
  /** Index columns stored between previous_id and request_scope. */
  readonly columns: readonly string[];
  /** `kinds` caps the heads of each kind; together they bound every head scan. */
  readonly limits: { readonly rowBytes: number; readonly rows: number; readonly bytes: number; readonly kinds: Readonly<Record<K, number>> };
  /** Index column values of a record's row, or of its receipt's row. */
  index(record: R, receipt: boolean): Readonly<Record<string, SQLInputValue>>;
  /** request_scope of a record row and of its receipt row. */
  scope(kind: K, entityId: string, operation: string): { readonly record: string; readonly receipt: string };
  /** previous_id stored on a receipt row. */
  receiptPrevious(before: R | undefined): string | null;
  /** A caller-supplied ID, checked with the module's bounds and code. */
  identifier(value: unknown): string;
  /** Immutable copy of a parsed body whose seal holds. */
  sealed<B extends { readonly sha256: string }>(value: B): B;
  /** Module checks a record read back from its row must pass. */
  verify(record: R, db: DatabaseSync): void;
  /** Throws the module error; without a code, its invalid-journal code. */
  fail(code?: string): never;
  readonly codes: { readonly limit: string; readonly revisionConflict: string; readonly requestConflict: string };
}
export interface JournalAdmission<K extends string, R extends JournalRecord<K>, T, B extends R> {
  readonly kind: K;
  readonly before: R | undefined;
  readonly expectedRevision: number;
  /** Signs the next revision and its receipt under fresh IDs; validation precedes signing. */
  build(revisionId: string, receiptId: string): JournalPair<B, T>;
  /** Headroom later administrative writes need once `record` heads its entity. Administrative writes omit it and meet the row bound before they are built. */
  reserve?(record: B): JournalBudget;
}
/** Every row of a journal, decoded in kind, workspace, entity and revision order. */
export interface JournalScan<R, T> {
  readonly heads: readonly JournalHead[];
  readonly records: ReadonlyMap<string, R>;
  readonly receipts: ReadonlyMap<string, T>;
  readonly rows: ReadonlyMap<string, JournalRow>;
}
export type RevisionJournal<K extends string, R extends JournalRecord<K>, T extends JournalReceipt<K>> = ReturnType<typeof createRevisionJournal<K, R, T>>;

const RECEIPT_FIELDS = ['id', 'workspaceId', 'kind', 'entityId', 'operation', 'beforeRevisionId', 'afterRevisionId', 'afterSha256', 'requestId', 'requestSha256', 'requestInput', 'createdAt', 'sha256'];

/** Revisions, heads and receipt pairs of one module: bounded reads, request replay, budgeted appends and head moves. */
export function createRevisionJournal<K extends string, R extends JournalRecord<K>, T extends JournalReceipt<K>>(db: DatabaseSync, profile: RevisionJournalProfile<K, R>) {
  const { revisions, heads, columns, limits, codes } = profile, id = profile.identifier, fail: (code?: string) => never = profile.fail;
  const header = `id,workspace_id,kind,entity_id,revision,previous_id,${columns.join(',')},request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) bytes`;
  const insert = `INSERT INTO ${revisions}(id,workspace_id,kind,entity_id,revision,previous_id,${columns.join(',')},request_scope,request_id,request_sha256,sha256,data) VALUES(${Array(columns.length + 11).fill('?').join(',')})`;
  const maxHeads = (Object.values(limits.kinds) as number[]).reduce((total, max) => total + max, 0);
  const indexed = (row: JournalRow, record: R, receipt: boolean) => { const index = profile.index(record, receipt); return columns.every(column => row[column] === index[column]); };
  function load(row: Readonly<Record<string, SQLOutputValue>>, where: string, params: readonly SQLInputValue[]): string {
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > limits.rowBytes) fail(codes.limit);
    return readBoundedBody(db, { table: revisions, where, params }, Number(row.bytes), fail) ?? fail();
  }
  function decode(row: JournalRow, raw: string): R | T {
    const body = profile.sealed(JSON.parse(raw) as R | T);
    if (body.id !== row.id || body.workspaceId !== row.workspace_id || body.entityId !== row.entity_id || body.sha256 !== row.sha256) fail();
    if (row.kind === 'transition') {
      const receipt = body as T, keys = Object.keys(receipt);
      if (keys.length !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some(key => !Object.hasOwn(receipt, key)) || receipt.requestId !== row.request_id
        || receipt.requestSha256 !== row.request_sha256 || canonicalSha256(receipt.requestInput) !== receipt.requestSha256) fail();
      return receipt;
    }
    const record = body as R;
    if (record.kind !== row.kind || record.revision !== row.revision || record.previousId !== row.previous_id) fail();
    profile.verify(record, db);
    return record;
  }
  function totals(): JournalBudget {
    const total = db.prepare(`SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM ${revisions}`).get()!;
    return { rows: Number(total.n), bytes: Number(total.bytes) };
  }
  function read<B extends R | T>(workspaceId: string, revisionId: string, kind?: K | 'transition'): B {
    const row = db.prepare(`SELECT ${header} FROM ${revisions} WHERE workspace_id=? AND id=?`).get(id(workspaceId), id(revisionId)) as JournalRow | undefined;
    if (!row) fail();
    const raw = load(row, 'workspace_id=? AND id=?', [workspaceId, revisionId]);
    if (kind && row.kind !== kind) fail();
    return decode(row, raw) as B;
  }
  /** The head revision, which must also be its entity's highest revision. */
  function head<B extends R>(workspaceId: string, kind: K, entityId: string): B | undefined {
    const h = db.prepare(`SELECT revision_id,revision,sha256 FROM ${heads} WHERE workspace_id=? AND kind=? AND entity_id=?`).get(id(workspaceId), kind, id(entityId));
    if (!h) return undefined;
    const record = read<B>(workspaceId, String(h.revision_id), kind);
    if (record.entityId !== entityId || record.revision !== h.revision || record.sha256 !== h.sha256) fail();
    if (db.prepare(`SELECT max(revision) revision FROM ${revisions} WHERE workspace_id=? AND kind=? AND entity_id=?`).get(workspaceId, kind, entityId)?.revision !== record.revision) fail();
    return record;
  }
  function list<B extends R>(workspaceId: string, kind: K, max: number): B[] {
    const hs = db.prepare(`SELECT entity_id FROM ${heads} WHERE workspace_id=? AND kind=? ORDER BY entity_id LIMIT ?`).all(id(workspaceId), kind, max + 1);
    if (hs.length > max) fail(codes.limit);
    return hs.map(h => head<B>(workspaceId, kind, String(h.entity_id))!);
  }
  /** The pair an earlier identical request wrote; the same request ID with other input conflicts. */
  function replay<B extends R>(workspaceId: string, kind: K, entityId: string, operation: string, input: { readonly requestId: string }): JournalPair<B, T> | undefined {
    const h = db.prepare(`SELECT id,request_sha256 FROM ${revisions} WHERE workspace_id=? AND kind='transition' AND request_scope=? AND request_id=?`)
      .get(workspaceId, profile.scope(kind, entityId, operation).receipt, id(input.requestId));
    if (!h) return undefined;
    if (h.request_sha256 !== canonicalSha256(input)) fail(codes.requestConflict);
    const receipt = read<T>(workspaceId, String(h.id), 'transition');
    return { record: read<B>(workspaceId, receipt.afterRevisionId, kind), receipt };
  }
  /** The next pair under the head, row and byte bounds, without writing it. */
  function admit<B extends R>(entry: JournalAdmission<K, R, T, B>): JournalPair<B, T> {
    const { kind, before } = entry;
    if ((before?.revision ?? 0) !== entry.expectedRevision) fail(codes.revisionConflict);
    if (!before && Number(db.prepare(`SELECT count(*) n FROM ${heads} WHERE kind=?`).get(kind)?.n) >= limits.kinds[kind]) fail(codes.limit);
    const total = totals();
    if (!entry.reserve && total.rows + 2 > limits.rows) fail(codes.limit);
    const pair = entry.build(randomUUID(), randomUUID()), reserve = entry.reserve?.(pair.record) ?? { rows: 0, bytes: 0 };
    if (total.rows + 2 + reserve.rows > limits.rows
      || total.bytes + Buffer.byteLength(JSON.stringify(pair.record)) + Buffer.byteLength(JSON.stringify(pair.receipt)) + reserve.bytes > limits.bytes) fail(codes.limit);
    return pair;
  }
  /** Inserts the record and receipt rows, then moves the head only from `before`. */
  function write(pair: JournalPair<R, T>, before: R | undefined): void {
    const { record, receipt } = pair, scope = profile.scope(record.kind, record.entityId, receipt.operation);
    const values = (forReceipt: boolean) => { const index = profile.index(record, forReceipt); return columns.map(column => index[column]!); };
    const rows = db.prepare(insert);
    rows.run(record.id, record.workspaceId, record.kind, record.entityId, record.revision, record.previousId, ...values(false), scope.record, receipt.requestId, receipt.requestSha256, record.sha256, JSON.stringify(record));
    rows.run(receipt.id, record.workspaceId, 'transition', record.entityId, record.revision, profile.receiptPrevious(before), ...values(true), scope.receipt, receipt.requestId, receipt.requestSha256, receipt.sha256, JSON.stringify(receipt));
    if (!before) {
      db.prepare(`INSERT INTO ${heads}(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,?,?,?,?,?)`).run(record.workspaceId, record.kind, record.entityId, record.id, record.revision, record.sha256);
      return;
    }
    const moved = db.prepare(`UPDATE ${heads} SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=? AND revision=? AND sha256=?`)
      .run(record.id, record.revision, record.sha256, record.workspaceId, record.kind, record.entityId, before.id, before.revision, before.sha256);
    if (moved.changes !== 1) fail(codes.revisionConflict);
  }
  function append<B extends R>(entry: JournalAdmission<K, R, T, B>): JournalPair<B, T> {
    const pair = admit(entry);
    write(pair, entry.before);
    return pair;
  }
  /** Head bodies, optionally of one workspace, checked against their seals only. */
  function current(workspaceId?: string): R[] {
    const hs = db.prepare(`SELECT h.revision_id,length(CAST(r.data AS BLOB)) bytes FROM ${heads} h JOIN ${revisions} r ON r.id=h.revision_id ${workspaceId ? 'WHERE h.workspace_id=?' : ''} LIMIT ?`)
      .all(...(workspaceId ? [id(workspaceId)] : []), maxHeads + 1);
    if (hs.length > maxHeads) fail(codes.limit);
    return hs.map(h => profile.sealed(JSON.parse(load(h, 'id=?', [String(h.revision_id)])) as R));
  }
  /** Journal bounds, then every row decoded and matched to its index columns. */
  function scan(check?: () => void): JournalScan<R, T> {
    const total = totals();
    if (total.rows > limits.rows || total.bytes > limits.bytes) fail(codes.limit);
    const hs = db.prepare(`SELECT workspace_id,kind,entity_id,revision_id,revision,sha256 FROM ${heads} LIMIT ?`).all(maxHeads + 1) as unknown as JournalHead[];
    if (hs.length > maxHeads) fail(codes.limit);
    for (const kind of Object.keys(limits.kinds) as K[]) if (hs.filter(h => h.kind === kind).length > limits.kinds[kind]) fail(codes.limit);
    const all = db.prepare(`SELECT ${header} FROM ${revisions} ORDER BY kind,workspace_id,entity_id,revision`).all() as unknown as JournalRow[];
    const records = new Map<string, R>(), receipts = new Map<string, T>();
    for (const row of all) {
      check?.();
      const body = decode(row, load(row, 'id=?', [row.id]));
      if (row.kind === 'transition') receipts.set(row.id, body as T);
      else if (!indexed(row, body as R, false)) fail();
      else records.set(row.id, body as R);
    }
    return { heads: hs, records, receipts, rows: new Map(all.map(row => [row.id, row])) };
  }
  /** The receipt that wrote `record`, matched to its scope, request and index columns. */
  function receiptOf(record: R, graph: JournalScan<R, T>): T {
    const receipt = graph.receipts.get(record.lastReceiptId);
    if (!receipt || receipt.afterRevisionId !== record.id || receipt.afterSha256 !== record.sha256 || receipt.workspaceId !== record.workspaceId || receipt.kind !== record.kind
      || receipt.entityId !== record.entityId || receipt.beforeRevisionId !== record.previousId || receipt.createdAt !== record.createdAt) fail();
    const row = graph.rows.get(record.id)!, receiptRow = graph.rows.get(receipt.id)!, scope = profile.scope(record.kind, record.entityId, receipt.operation);
    const input = receipt.requestInput as Record<string, unknown>, before = record.previousId === null ? undefined : graph.records.get(record.previousId);
    if (row.request_scope !== scope.record || receiptRow.request_scope !== scope.receipt || row.request_id !== receipt.requestId || row.request_sha256 !== receipt.requestSha256
      || receiptRow.revision !== record.revision || receiptRow.previous_id !== profile.receiptPrevious(before) || input.workspaceId !== record.workspaceId
      || input.requestId !== receipt.requestId || input.expectedRevision !== record.revision - 1 || !indexed(receiptRow, record, true)) fail();
    return receipt;
  }
  function previousOf(record: R, graph: JournalScan<R, T>): R | undefined {
    const before = record.previousId ? graph.records.get(record.previousId) : undefined;
    if ((record.previousId && !before) || (!before && record.revision !== 1)) fail();
    return before;
  }
  /** Each record has one receipt, and each entity's head is its highest revision. */
  function assertHeads(graph: JournalScan<R, T>): void {
    const maxima = new Map<string, R>();
    for (const record of graph.records.values()) {
      const key = `${record.workspaceId}\0${record.kind}\0${record.entityId}`, old = maxima.get(key);
      if (!old || old.revision < record.revision) maxima.set(key, record);
    }
    if (graph.receipts.size !== graph.records.size || graph.heads.length !== maxima.size) fail();
    for (const h of graph.heads) {
      const record = maxima.get(`${h.workspace_id}\0${h.kind}\0${h.entity_id}`);
      if (!record || h.revision_id !== record.id || h.revision !== record.revision || h.sha256 !== record.sha256) fail();
    }
  }
  return { read, head, list, replay, admit, write, append, current, scan, receiptOf, previousOf, assertHeads };
}

/** `after` is the next revision of `before`'s entity. */
export function assertRevisionLink(before: JournalRecord, after: JournalRecord, fail: () => never): void {
  if (before.kind !== after.kind || before.entityId !== after.entityId || before.workspaceId !== after.workspaceId || before.revision + 1 !== after.revision || after.previousId !== before.id) fail();
}

/** Keys outside `mutable` keep their canonical value and are neither added nor removed. */
export function assertOnlyChanged(before: object, after: object, mutable: readonly string[], fail: () => never): void {
  const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
    if (!mutable.includes(key) && !sameCanonical(left[key], right[key])) fail();
}
