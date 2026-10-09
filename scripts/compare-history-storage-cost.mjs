import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE = Object.freeze({ seed: 'next01-private-history-v1', runs: 12, textDeltas: 4,
  deltaCharacters: 2048, reasoningCharacters: 1024, querySamples: 12, warmups: 2,
  timestamp: '2026-10-09T00:00:00.000Z', modelMessages: 200, modelBytes: 8388608 });
const stringify = JSON.stringify, parse = JSON.parse;
const hash = value => createHash('sha256').update(value).digest('hex');

export function runtimeManifest(runtime) {
  const files = [];
  const visit = relative => {
    for (const entry of readdirSync(join(runtime, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (path.endsWith('.js') || path.endsWith('.d.ts'))) {
        const bytes = readFileSync(join(runtime, path)); files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  };
  visit('');
  return { files, totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    filesSha256: hash(stringify(files)), scope: 'Copied engine JS and declaration graph; dependencies are separately pinned by package-lock and contracts validators.' };
}

/** Independent digest normalization; raw ordered-row digests are checked separately. */
export function semanticNormalizer(root) {
  const identities = new Map();
  const text = value => value.replaceAll(root, '<fixture-root>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, value => {
      if (!identities.has(value)) identities.set(value, `<id:${identities.size + 1}>`);
      return identities.get(value);
    }).replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<timestamp>');
  const normalize = value => typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)])) : value;
  return normalize;
}

function counters() { return { stringifyCalls: 0, serializedUtf8Bytes: 0, parseCalls: 0, parsedUtf8Bytes: 0,
  sqlPrepareCalls: 0, sqlExecCalls: 0, sqlReadCalls: 0, sqlWriteCalls: 0, sqlReturnedRows: 0, sqlReturnedJsonUtf8Bytes: 0,
  nativeRowWrites: 0, exactEventRecordCopies: 0 }; }

/** Instrument the isolated fixture process, without a production instrumentation API. */
function instrument() {
  let active = null;
  const native = new Map(), originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
  JSON.stringify = function (...args) {
    const result = Reflect.apply(stringify, JSON, args);
    if (active) { active.stringifyCalls++; if (typeof result === 'string') active.serializedUtf8Bytes += Buffer.byteLength(result); }
    return result;
  };
  JSON.parse = function (...args) {
    if (active) { active.parseCalls++; active.parsedUtf8Bytes += Buffer.byteLength(String(args[0])); }
    return Reflect.apply(parse, JSON, args);
  };
  const returned = (result, count) => {
    if (!count) return;
    const rows = Array.isArray(result) ? result : result ? [result] : [];
    count.sqlReturnedRows += rows.length;
    for (const row of rows) if (row && typeof row.data === 'string') count.sqlReturnedJsonUtf8Bytes += Buffer.byteLength(row.data);
  };
  const written = (sql, args, count) => {
    const match = /^INSERT INTO (session_turns|provider_attempts|message_parts|context_revisions)\(/.exec(sql);
    if (match) { native.set(String(args[0]), String(args.at(-1))); if (count) count.nativeRowWrites++; }
    if (/^INSERT INTO session_events\(/.test(sql)) {
      const event = parse(String(args.at(-1)));
      for (const field of ['turn', 'attempt', 'part', 'context']) {
        const record = event.payload[field];
        if (record && native.has(record.id)) {
          assert.equal(stringify(record), native.get(record.id), 'Native event copy must equal the exact encoded row for this write');
          if (count) count.exactEventRecordCopies++;
        }
      }
    }
  };
  DatabaseSync.prototype.prepare = function (sql) {
    if (active) active.sqlPrepareCalls++;
    const statement = Reflect.apply(originalPrepare, this, [sql]);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const count = active;
        if (key === 'run' && count) count.sqlWriteCalls++;
        if (['get', 'all', 'iterate'].includes(String(key)) && count) count.sqlReadCalls++;
        const result = Reflect.apply(value, target, args);
        if (key === 'run') written(sql, args, count);
        if (key === 'get' || key === 'all') returned(result, count);
        if (key === 'iterate') return (function* () { for (const row of result) { returned(row, count); yield row; } })();
        return result;
      };
    } });
  };
  DatabaseSync.prototype.exec = function (sql) { if (active) active.sqlExecCalls++; return Reflect.apply(originalExec, this, [sql]); };
  return { start() { active = counters(); return active; }, stop() { active = null; }, restore() {
    active = null; JSON.stringify = stringify; JSON.parse = parse;
    DatabaseSync.prototype.prepare = originalPrepare; DatabaseSync.prototype.exec = originalExec;
  } };
}

function deterministicFixtureIdentity() {
  let sequence = 0;
  crypto.randomUUID = () => {
    const value = hash(`${FIXTURE.seed}:${++sequence}`).slice(0, 32);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
  };
  syncBuiltinESMExports();
  const NativeDate = Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [FIXTURE.timestamp])); }
    static now() { return NativeDate.parse(FIXTURE.timestamp); }
  };
}

function readTables(path, root) {
  const database = new DatabaseSync(path, { readOnly: true }), normalize = semanticNormalizer(root);
  try {
    const tables = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const raw = createHash('sha256'), semantic = createHash('sha256'), summary = {};
    for (const { name, sql } of tables) {
      const metadata = database.prepare(`PRAGMA table_info("${name}")`).all(), columns = metadata.map(row => String(row.name));
      const order = /WITHOUT ROWID/i.test(sql) ? metadata.filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => `"${row.name}"`).join(',') : 'rowid';
      const rows = database.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).all();
      raw.update(name + '\n'); semantic.update(name + '\n');
      let dataBytes = 0;
      for (const row of rows) {
        raw.update(stringify(row) + '\n');
        semantic.update(stringify(normalize(Object.fromEntries(columns.map(key => [key, key === 'data' && typeof row[key] === 'string' ? parse(row[key]) : row[key]])))) + '\n');
        if (typeof row.data === 'string') dataBytes += Buffer.byteLength(row.data);
      }
      if (rows.length || columns.includes('data')) summary[name] = { rows: rows.length, dataUtf8Bytes: dataBytes };
    }
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    const pageCount = Number(database.prepare('PRAGMA page_count').get().page_count);
    const freePages = Number(database.prepare('PRAGMA freelist_count').get().freelist_count);
    const pageBytes = Number(database.prepare('PRAGMA page_size').get().page_size);
    return { schema: Number(database.prepare('PRAGMA user_version').get().user_version), tables: summary, exactOrderedRowsSha256: raw.digest('hex'),
      normalizedOrderedRowsSha256: semantic.digest('hex'), integrity: 'ok', foreignKeyViolations: 0, pageCount, freePages, pageBytes,
      primaryBytes: statSync(path).size, pageAllocationBytes: pageCount * pageBytes };
  } finally { database.close(); }
}

function percentile(samples, fraction) { return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]; }

async function worker(runtime, root, output) {
  deterministicFixtureIdentity();
  const { createEngine } = await import(pathToFileURL(join(runtime, 'engine.js')).href);
  const { ScriptedProvider } = await import(pathToFileURL(join(runtime, 'provider/scripted.js')).href);
  const { exportEngineArchive, validateEngineArchive } = await import(pathToFileURL(join(runtime, 'storage/archive.js')).href);
  mkdirSync(root, { mode: 0o700 });
  const repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  mkdirSync(repository); mkdirSync(artifactDir, { mode: 0o700 });
  execFileSync('git', ['init', '--quiet', '--template=', repository], { stdio: 'pipe' });
  const text = 'Dummy fixture 한국어 🚀 '.repeat(FIXTURE.deltaCharacters).slice(0, FIXTURE.deltaCharacters);
  const reasoning = 'Dummy private reasoning '.repeat(FIXTURE.reasoningCharacters).slice(0, FIXTURE.reasoningCharacters);
  const replayItems = [{ type: 'fixture.replay', opaque: { signature: 'dummy-private-signature', nested: ['한국어', null, { z: 2, a: true }] } }];
  const provider = new ScriptedProvider([{ events: [{ type: 'reasoning.delta', delta: reasoning },
    ...Array.from({ length: FIXTURE.textDeltas }, () => ({ type: 'text.delta', delta: text })),
    { type: 'usage', inputTokens: 23, outputTokens: 17 }, { type: 'finish', reason: 'stop', replayItems }] }]);
  const defaults = { providerId: 'scripted', modelId: 'history-cost-fixture', mode: 'plan', limits: {
    maxTurns: 2, maxToolCalls: 2, maxOutputBytes: 65536, maxDurationMs: 30000, toolTimeoutMs: 2000, maxContextBytes: 262144 } };
  const instrumentation = instrument();
  const writeCounters = instrumentation.start(), writeStart = performance.now(), heapStart = process.memoryUsage().heapUsed;
  let peakHeap = heapStart, engine;
  try {
    engine = createEngine({ dbPath, artifactDir, providers: [provider], tools: [], defaults });
    engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: FIXTURE.timestamp });
    engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Private dummy history fixture', createdAt: FIXTURE.timestamp });
    for (let index = 0; index < FIXTURE.runs; index++) {
      const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: `${FIXTURE.seed}:${index}`, prompt: `Dummy fixture input ${index}: 한국어`, config: defaults });
      assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed');
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    const writeMs = performance.now() - writeStart;
    instrumentation.stop();
    assert.equal(provider.callCount, FIXTURE.runs);
    const snapshot = engine.store.getSnapshot('session');
    assert.equal(snapshot.runs.length, FIXTURE.runs);
    assert.equal(snapshot.messages.length, FIXTURE.runs * 2);
    assert.equal(snapshot.tools.length, 0); assert.equal(snapshot.approvals.length, 0);
    for (const run of snapshot.runs) {
      const turns = engine.store.listTurns(run.id);
      assert.equal(turns.length, 1); assert.equal(turns[0].state, 'completed');
      const parts = engine.store.listParts(turns[0].id);
      assert.deepEqual(parts.map(part => part.type), ['reasoning', 'text']);
      assert.equal(parts[0].text, reasoning); assert.equal(parts[1].text, text.repeat(FIXTURE.textDeltas));
      assert.ok(parts.every(part => part.state === 'completed'));
    }
    const normalize = semanticNormalizer(root), model = engine.store.readModelHistory('session', FIXTURE.modelMessages, FIXTURE.modelBytes);
    assert.equal(model.snapshot.messages.length, FIXTURE.runs * 2);
    assert.ok(model.snapshot.messages.some(message => message.role === 'assistant' && stringify(message).includes('dummy-private-signature')));
    const publicHistory = engine.store.getHistory('session');
    assert.equal(stringify(publicHistory).includes('dummy-private-signature'), false, 'Public history keeps native replay private');
    const query = () => {
      const model = engine.store.readModelHistory('session', FIXTURE.modelMessages, FIXTURE.modelBytes);
      const history = engine.store.getHistory('session');
      const events = engine.store.readSessionEvents('session', 0);
      return { model, history, events };
    };
    for (let index = 0; index < FIXTURE.warmups; index++) query();
    const queryCounters = instrumentation.start(), samples = []; let selectedBytes = 0, eventPageRecords = 0;
    for (let index = 0; index < FIXTURE.querySamples; index++) {
      const start = performance.now(), result = query(); samples.push(performance.now() - start);
      selectedBytes = Buffer.byteLength(stringify(result)); eventPageRecords = result.events.length;
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    instrumentation.stop();
    const semantics = { modelSha256: hash(stringify(normalize(model))), publicHistorySha256: hash(stringify(normalize(publicHistory))),
      modelBytes: Buffer.byteLength(stringify(model)), publicHistoryBytes: Buffer.byteLength(stringify(publicHistory)) };
    await engine.close(); engine = undefined; instrumentation.restore();
    const records = readTables(dbPath, root);
    assert.equal(records.schema, 23);
    assert.equal(records.tables.session_turns.rows, FIXTURE.runs);
    assert.equal(records.tables.provider_attempts.rows, FIXTURE.runs);
    assert.equal(records.tables.message_parts.rows, FIXTURE.runs * 2);
    const archive = await exportEngineArchive({ dbPath, artifactDir, destination: join(root, 'archive') });
    const validated = validateEngineArchive({ directory: archive.directory, expectedManifestSha256: archive.manifestSha256 });
    assert.equal(validated.manifest.archiveVersion, 1);
    const archived = readTables(join(archive.directory, 'data', 'engine.sqlite'), root);
    assert.equal(archived.exactOrderedRowsSha256, records.exactOrderedRowsSha256, 'Archive must preserve every ordered row exactly');
    assert.equal(readTables(dbPath, root).exactOrderedRowsSha256, records.exactOrderedRowsSha256, 'Archive export must preserve source rows');
    const result = { fixture: FIXTURE, fixtureSha256: hash(stringify({ fixture: FIXTURE, text, reasoning, replayItems, defaults })), providerCalls: provider.callCount,
      writes: { ...writeCounters, elapsedMs: writeMs }, reads: { ...queryCounters, samples: samples.length, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95),
        maxMs: Math.max(...samples), selectedBytes, eventPageRecords }, resources: { peakHeapDeltaBytes: peakHeap - heapStart, rssBytes: process.memoryUsage().rss },
      records, semantics, archive: { exactOrderedRowsSha256: archived.exactOrderedRowsSha256, normalizedOrderedRowsSha256: archived.normalizedOrderedRowsSha256,
        primaryBytes: archived.primaryBytes, archiveVersion: 1, sourceRowsPreserved: true } };
    writeFileSync(output, stringify(result, null, 2) + '\n', { mode: 0o600 });
  } finally { instrumentation.restore(); await engine?.close(); }
}

export function compareResults(baseline, candidate) {
  assert.deepEqual(candidate.fixture, baseline.fixture);
  assert.equal(candidate.fixtureSha256, baseline.fixtureSha256);
  assert.equal(candidate.providerCalls, FIXTURE.runs);
  assert.deepEqual(candidate.records, baseline.records, 'Native counts, bytes, identities, schema and exact/normalized digests must match');
  assert.deepEqual(candidate.semantics, baseline.semantics, 'Public and model byte counts and normalized digests must match');
  assert.deepEqual(candidate.archive, baseline.archive, 'Independent archive ordered-row digests must match');
  for (const stage of ['writes', 'reads']) for (const key of ['sqlPrepareCalls', 'sqlExecCalls', 'sqlReadCalls', 'sqlWriteCalls', 'sqlReturnedRows', 'sqlReturnedJsonUtf8Bytes', 'nativeRowWrites', 'exactEventRecordCopies'])
    assert.equal(candidate[stage][key], baseline[stage][key], `Native ${stage} ${key} must match`);
  return { sameInputs: true, sameExactOrderedRows: true, sameNormalizedOrderedRows: true, samePublicAndModelHistory: true, sameArchiveRows: true,
    sameSqlReadAndWriteCounts: true, serializedUtf8BytesSaved: baseline.writes.serializedUtf8Bytes - candidate.writes.serializedUtf8Bytes,
    stringifyCallsSaved: baseline.writes.stringifyCalls - candidate.writes.stringifyCalls };
}

async function main(args) {
  if (args[0] === '--worker') return worker(resolve(args[1]), resolve(args[2]), resolve(args[3]));
  if (args.length !== 3) throw new Error('Usage: node scripts/compare-history-storage-cost.mjs <baseline-engine-dist> <candidate-engine-dist> <report.json>');
  const baselineRuntime = realpathSync(resolve(args[0])), candidateRuntime = realpathSync(resolve(args[1]));
  for (const runtime of [baselineRuntime, candidateRuntime]) assert.ok(existsSync(join(runtime, 'storage/native-records.js')));
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url))), artifacts = join(repositoryRoot, 'artifacts', 'next-history-cost');
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const directory = realpathSync(mkdtempSync(join(artifacts, 'comparison-'))), root = join(directory, 'fixture');
    const manifests = Object.fromEntries([['baseline', baselineRuntime], ['candidate', candidateRuntime]].map(([label, runtime]) => {
      const manifest = runtimeManifest(runtime); writeFileSync(join(directory, `${label}-runtime-manifest.json`), stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      return [label, { file: `${label}-runtime-manifest.json`, filesSha256: manifest.filesSha256, totalFiles: manifest.totalFiles, totalBytes: manifest.totalBytes }];
    }));
    const baselineCapturePath = join(dirname(baselineRuntime), 'capture.json');
    const baselineCapture = existsSync(baselineCapturePath) ? parse(readFileSync(baselineCapturePath, 'utf8')) : null;
    if (baselineCapture) assert.equal(baselineCapture.runtimeFilesSha256, manifests.baseline.filesSha256, 'Baseline runtime must match its independently established capture');
    const reports = [];
    for (const [label, runtime] of [['baseline', baselineRuntime], ['candidate', candidateRuntime]]) {
      const output = join(directory, `${label}.json`);
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', runtime, root, output], { timeout: 60000, encoding: 'utf8', maxBuffer: 65536 });
      writeFileSync(join(directory, `${label}.stdout.log`), child.stdout ?? '', { mode: 0o600 });
      writeFileSync(join(directory, `${label}.stderr.log`), child.stderr ?? '', { mode: 0o600 });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`${label} native fixture failed: ${child.stderr.slice(-12000)}`);
      reports.push(parse(readFileSync(output, 'utf8')));
      renameSync(root, join(directory, label));
    }
    const [baseline, candidate] = reports, equivalence = compareResults(baseline, candidate);
    const report = { version: 1, task: 'NEXT-01', timestamp: new Date().toISOString(), node: process.version,
      retainedFixtures: { directory: directory.slice(repositoryRoot.length + 1), baseline: 'baseline/engine.sqlite', candidate: 'candidate/engine.sqlite' },
      runtimeManifests: manifests,
      sourcePins: { baseline: baselineCapture?.sourceCommit ?? null,
        baselineProvenance: baselineCapture ? 'Independently established exact source checkout build captured before candidate edits; graph hash verified against retained capture.json.' : 'Caller-supplied runtime without a source capture; no baseline source commit is asserted.',
        candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8' }).trim(),
        baselineNativeRecordsCompiledSha256: hash(readFileSync(join(baselineRuntime, 'storage/native-records.js'))),
        candidateNativeRecordsCompiledSha256: hash(readFileSync(join(candidateRuntime, 'storage/native-records.js'))),
        candidateNativeRecordsSourceSha256: hash(readFileSync(new URL('../packages/engine/src/storage/native-records.ts', import.meta.url))),
        helperSha256: hash(readFileSync(fileURLToPath(import.meta.url))), packageLockSha256: hash(readFileSync(new URL('../package-lock.json', import.meta.url))) },
      qualification: ['Bounded native ScriptedProvider runs; no bulk SQL history manufacture.',
        'Fixture-only deterministic UUIDs and wall-clock timestamps allow exact cross-process SQL byte comparison; performance clocks and native SQL remain real.',
        'The independent semantic normalizer also removes fixture paths, UUIDs and timestamps before comparing record/public/model/archive digests.',
        'Serialized JSON byte counters measure CPU/allocation work, not SQLite disk growth. Durable bytes and SQL calls must remain identical.',
        'Heap/RSS and wall times are informational single-machine samples, not regression thresholds or a replacement for the prior 30-minute run.',
        'SQL returned JSON bytes count data-column materialization, not physical filesystem I/O.'], equivalence, baseline, candidate };
    writeFileSync(resolve(args[2]), stringify(report, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(directory, 'comparison.json'), stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(stringify({ report: resolve(args[2]), equivalence }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
