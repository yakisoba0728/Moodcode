import { types } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError, type InputDocumentAttachment, type InputImageAttachment } from '@moodcode/contracts';
import { attachment as documentAttachment, DEFAULT_DOCUMENT_LIMITS } from '../documents/validation.js';
import { attachment as imageAttachment, DEFAULT_IMAGE_LIMITS } from '../media/validation.js';

interface IndexBounds {
  maxDocuments: number;
  maxRefs: number;
  maxJsonBytes: number;
}
const LIMITS: Readonly<IndexBounds> = Object.freeze({ maxDocuments: 64, maxRefs: 2048, maxJsonBytes: 4_194_304 });
const DOCUMENT_BYTES = 262_144;
const OWNER_BYTES = 16_384;
type IndexKind = 'input_images' | 'input_documents';
export interface InputIndexOptions {
  maxDocuments?: number;
  maxRefs?: number;
  maxJsonBytes?: number;
  signal?: AbortSignal;
}
export type InputIndexReport<Ref, IdsKey extends string, Kind extends IndexKind> = {
  scope: 'primary-database-only';
  observedAt: string;
  complete: boolean;
  totalDocuments: number;
  sampledDocuments: number;
  invalidDocuments: number;
  omittedDocuments: number;
  invalidReferences: number;
  omittedReferences: number | null;
  sampledJsonBytes: number;
  documents: Array<{ sessionId: string; workspaceId: string; workspaceRoot: string; revision: number; referenceCount: number }>;
  refs: Array<Ref & { sessionId: string; workspaceId: string }>;
  declaredBytes: number | null;
  limits: { maxDocuments: number; maxRefs: number; maxJsonBytes: number };
  reasons: string[];
  coverage: {
    source: `session_documents.${Kind}`;
    ownerValidation: 'joined-session-workspace-and-stored-payload';
    bytes: 'UTF-8 sampled JSON and declared unique reference bytes';
    sql: 'bounded metadata/payload rows; document count may scan primary headers';
    childDatabases: 'not-read';
    childBlobs: 'not-read';
    filesystem: 'not-read';
    physicalReadBytes: null;
  };
} & { [Key in IdsKey]: string[] };
export type InputImageIndexOptions = InputIndexOptions;
export type InputImageIndexReport = InputIndexReport<InputImageAttachment, 'imageIds', 'input_images'>;
export type InputDocumentIndexOptions = InputIndexOptions;
export type InputDocumentIndexReport = InputIndexReport<InputDocumentAttachment, 'documentIds', 'input_documents'>;

/** Per-kind table rows, payload field, report key, error codes and session reference budget. */
interface InputIndexSpec<Ref, IdsKey extends string, Kind extends IndexKind> {
  kind: Kind;
  field: 'attachments' | 'documents';
  idsKey: IdsKey;
  code: 'IMAGE' | 'DOCUMENT';
  noun: 'Image' | 'Document';
  validate: (value: unknown) => Ref;
  maxSessionRefs: number;
  maxSessionBytes: number;
}
const IMAGE_SPEC: InputIndexSpec<InputImageAttachment, 'imageIds', 'input_images'> = {
  kind: 'input_images', field: 'attachments', idsKey: 'imageIds', code: 'IMAGE', noun: 'Image', validate: value => imageAttachment(value),
  maxSessionRefs: DEFAULT_IMAGE_LIMITS.maxSessionImages, maxSessionBytes: DEFAULT_IMAGE_LIMITS.maxSessionBytes,
};
const DOCUMENT_SPEC: InputIndexSpec<InputDocumentAttachment, 'documentIds', 'input_documents'> = {
  kind: 'input_documents', field: 'documents', idsKey: 'documentIds', code: 'DOCUMENT', noun: 'Document', validate: value => documentAttachment(value),
  maxSessionRefs: DEFAULT_DOCUMENT_LIMITS.maxSessionDocuments, maxSessionBytes: DEFAULT_DOCUMENT_LIMITS.maxSessionBytes,
};

function plain(value: unknown): value is Record<string, unknown> {
  return !types.isProxy(value) && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function root(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value;
}
function options(value: InputIndexOptions, spec: { code: string; noun: string }): { bounds: typeof LIMITS; signal?: AbortSignal } {
  const invalid = (message: string) => new EngineError(`INVALID_${spec.code}_INDEX_OPTIONS`, `${spec.noun} index ${message}`);
  if (!plain(value)) throw invalid('options must be plain bounded data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['maxDocuments', 'maxRefs', 'maxJsonBytes', 'signal'].includes(key)
    || !Object.hasOwn(descriptors[key]!, 'value'))) throw invalid('options must be plain bounded data');
  const bounds = { ...LIMITS };
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const number = descriptors[key]?.value === undefined ? LIMITS[key] : descriptors[key]!.value;
    if (!Number.isSafeInteger(number) || number < 1 || number > LIMITS[key]) throw invalid('bounds exceed supported limits');
    bounds[key] = number;
  }
  const signal = descriptors.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid('signal must be an AbortSignal');
  return { bounds, signal };
}

function inspectInputIndex<Ref extends { id: string; bytes: number }, IdsKey extends string, Kind extends IndexKind>(
  database: DatabaseSync, input: InputIndexOptions, spec: InputIndexSpec<Ref, IdsKey, Kind>,
): InputIndexReport<Ref, IdsKey, Kind> {
  const cancel = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new EngineError('CANCELLED', `Input ${spec.noun.toLowerCase()} index inspection was cancelled`);
  };
  const { bounds, signal } = options(input, spec);
  cancel(signal);
  const totalDocuments = Number(database.prepare('SELECT count(*) AS total FROM session_documents WHERE kind=?').get(spec.kind)?.total);
  const metadata = database.prepare(`SELECT CAST(d.rowid AS TEXT) AS document_id,
    CASE WHEN d.revision BETWEEN 1 AND 9007199254740991 THEN d.revision ELSE 0 END AS revision,
    length(CAST(d.data AS BLOB)) AS document_bytes,length(CAST(d.session_id AS BLOB)) AS session_id_bytes,
    length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes,
    length(CAST(s.workspace_id AS BLOB)) AS workspace_id_bytes,length(CAST(w.root AS BLOB)) AS root_bytes,
    s.id IS NOT NULL AS has_session,w.id IS NOT NULL AS has_workspace
    FROM session_documents d LEFT JOIN sessions s ON s.id=d.session_id LEFT JOIN workspaces w ON w.id=s.workspace_id
    WHERE d.kind=? ORDER BY d.session_id LIMIT ?`).all(spec.kind, bounds.maxDocuments);
  cancel(signal);
  const documents: InputIndexReport<Ref, IdsKey, Kind>['documents'] = [], refs: InputIndexReport<Ref, IdsKey, Kind>['refs'] = [],
    ids = new Set<string>(), reasons = new Set<string>();
  let invalidDocuments = 0, invalidReferences = 0, omittedDocuments = totalDocuments - metadata.length,
    omittedReferences: number | null = omittedDocuments ? null : 0, sampledJsonBytes = 0;
  if (omittedDocuments) reasons.add('document-limit');
  const omitRefs = (count: number | null) => {
    if (count === null || omittedReferences === null) omittedReferences = null;
    else omittedReferences += count;
  };
  for (const meta of metadata) {
    cancel(signal);
    if (!['document_bytes', 'session_id_bytes', 'session_bytes', 'workspace_bytes', 'workspace_id_bytes', 'root_bytes'].every(key => Number.isSafeInteger(meta[key]) && Number(meta[key]) >= 0)
      || !meta.has_session || !meta.has_workspace || Number(meta.session_id_bytes) > 256 || Number(meta.workspace_id_bytes) > 256 || Number(meta.root_bytes) > 4096
      || Number(meta.document_bytes) > DOCUMENT_BYTES || Number(meta.session_bytes) > OWNER_BYTES || Number(meta.workspace_bytes) > OWNER_BYTES
      || !Number.isSafeInteger(meta.revision) || Number(meta.revision) < 1) {
      invalidDocuments++;
      omitRefs(null);
      reasons.add('invalid-or-oversized-owner-document');
      continue;
    }
    const bytes = Number(meta.document_bytes) + Number(meta.session_bytes) + Number(meta.workspace_bytes);
    if (sampledJsonBytes + bytes > bounds.maxJsonBytes) {
      omittedDocuments++;
      omitRefs(null);
      reasons.add('json-byte-limit');
      continue;
    }
    const row = database.prepare(`SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data,w.data AS workspace_data
      FROM session_documents d JOIN sessions s ON s.id=d.session_id JOIN workspaces w ON w.id=s.workspace_id
      WHERE d.rowid=? AND d.kind=?
      AND length(CAST(d.data AS BLOB))=? AND length(CAST(s.data AS BLOB))=? AND length(CAST(w.data AS BLOB))=?
      AND length(CAST(d.session_id AS BLOB))=? AND length(CAST(s.workspace_id AS BLOB))=? AND length(CAST(w.root AS BLOB))=? AND d.revision=?`)
      .get(String(meta.document_id), spec.kind, Number(meta.document_bytes), Number(meta.session_bytes), Number(meta.workspace_bytes),
        Number(meta.session_id_bytes), Number(meta.workspace_id_bytes), Number(meta.root_bytes), Number(meta.revision));
    sampledJsonBytes += bytes;
    if (!row) {
      invalidDocuments++;
      omitRefs(null);
      reasons.add('missing-owner-document');
      continue;
    }
    let count: number | null = null;
    try {
      const data: unknown = JSON.parse(String(row.data)), session: unknown = JSON.parse(String(row.session_data)), workspace: unknown = JSON.parse(String(row.workspace_data));
      const values = plain(data) ? data[spec.field] : undefined;
      if (Array.isArray(values)) count = values.length;
      if (!plain(data) || Object.keys(data).length !== 3 || Object.keys(data).some(key => !['version', 'owner', spec.field].includes(key)) || data.version !== 1
        || !plain(data.owner) || Object.keys(data.owner).length !== 3 || !Array.isArray(values) || !plain(session) || !plain(workspace)
        || !id(row.session_id) || !id(row.workspace_id) || !root(row.root) || session.id !== row.session_id || session.workspaceId !== row.workspace_id
        || workspace.id !== row.workspace_id || workspace.root !== row.root || data.owner.sessionId !== row.session_id
        || data.owner.workspaceId !== row.workspace_id || data.owner.workspaceRoot !== row.root) {
        throw new EngineError(`INVALID_${spec.code}_INDEX_OWNER`, `${spec.noun} index ownership is inconsistent`);
      }
      if (values.length > spec.maxSessionRefs) throw new EngineError(`INVALID_${spec.code}_INDEX_COUNT`, `${spec.noun} index reference count exceeds its session budget`);
      const items: Ref[] = [], local = new Set<string>();
      let invalid = 0;
      for (const value of values) {
        try {
          const ref = spec.validate(value);
          if (local.has(ref.id) || ids.has(ref.id)) throw new EngineError(`DUPLICATE_${spec.code}_INDEX_ID`, `${spec.noun} index ID is not unique`);
          local.add(ref.id);
          items.push(ref);
        } catch {
          invalid++;
        }
      }
      invalidReferences += invalid;
      if (invalid || items.reduce((total, ref) => total + ref.bytes, 0) > spec.maxSessionBytes) {
        throw new EngineError(`INVALID_${spec.code}_INDEX_REFERENCES`, `${spec.noun} index references are inconsistent`);
      }
      documents.push({ sessionId: row.session_id, workspaceId: row.workspace_id, workspaceRoot: row.root, revision: Number(meta.revision), referenceCount: items.length });
      for (const ref of items) {
        if (refs.length >= bounds.maxRefs) {
          omitRefs(1);
          reasons.add('reference-limit');
          continue;
        }
        refs.push({ ...ref, sessionId: row.session_id, workspaceId: row.workspace_id });
        ids.add(ref.id);
      }
    } catch (error) {
      invalidDocuments++;
      omitRefs(count);
      reasons.add(error instanceof EngineError ? error.code.toLowerCase().replaceAll('_', '-') : `corrupt-${spec.noun.toLowerCase()}-index-json`);
    }
  }
  cancel(signal);
  return {
    scope: 'primary-database-only',
    observedAt: new Date().toISOString(),
    complete: omittedDocuments === 0 && invalidDocuments === 0 && omittedReferences === 0 && invalidReferences === 0,
    totalDocuments,
    sampledDocuments: metadata.length,
    invalidDocuments,
    omittedDocuments,
    invalidReferences,
    omittedReferences,
    sampledJsonBytes,
    documents,
    refs,
    [spec.idsKey]: [...ids],
    declaredBytes: refs.reduce((total, ref) => total + ref.bytes, 0),
    limits: bounds,
    reasons: [...reasons],
    coverage: {
      source: `session_documents.${spec.kind}`,
      ownerValidation: 'joined-session-workspace-and-stored-payload',
      bytes: 'UTF-8 sampled JSON and declared unique reference bytes',
      sql: 'bounded metadata/payload rows; document count may scan primary headers',
      childDatabases: 'not-read',
      childBlobs: 'not-read',
      filesystem: 'not-read',
      physicalReadBytes: null,
    },
  } as InputIndexReport<Ref, IdsKey, Kind>;
}

/** Inspect only primary image indexes. Completeness never certifies a blob or safe deletion. */
export function inspectInputImageIndex(database: DatabaseSync, input: InputImageIndexOptions = {}): InputImageIndexReport {
  return inspectInputIndex(database, input, IMAGE_SPEC);
}
/** Inspect only primary document indexes. Completeness never certifies a blob or safe deletion. */
export function inspectInputDocumentIndex(database: DatabaseSync, input: InputDocumentIndexOptions = {}): InputDocumentIndexReport {
  return inspectInputIndex(database, input, DOCUMENT_SPEC);
}
