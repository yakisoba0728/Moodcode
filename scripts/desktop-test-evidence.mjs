import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DESKTOP_EVIDENCE_LIMITS = Object.freeze({ files: 64, bytes: 16 * 1024 * 1024, manifestBytes: 128 * 1024, records: 32, depth: 12 });
export function mayDeleteDesktopTestDirectory({ outcome, cleanup }) {
  return outcome === 'passed' && cleanup?.state === 'confirmed' && cleanup.nativeConfirmed === true && cleanup.forcedStop !== true
    && cleanup.utilityScope === 'all-fixture-utilities' && cleanup.utilityAcknowledged === true && cleanup.utilityExitObserved === true;
}
const sources = new Map();
const captures = new WeakSet();
const states = new Set(['created','running','awaiting_approval','cancelling','completed','cancelled','failed','interrupted','uncertain','requested','streaming','awaiting_tools','pending','allowed','denied','expired','settled','prepared','dispatched','not-dispatched','dispatch-intent','response-terminal','closed','open','starting','started','exited','draining','unknown','active','stopping','terminated','waiting','ready','confirmed','unconfirmed','unavailable']);
const containers = new Set(['runs','tools','parts','turns','children','terminals','attempts','attemptCleanup','mcpExecutions','executionObservations','executionLock','reviewOperations','records','record','resident','cleanup','nativeExit','groupCleanup','supervisor','utility','mainUtility','connections','applicationClose','outcome','source','sourceBefore','sourceAfter','diagnostics','events','error','errors']);
const booleans = new Set(['available','observed','active','spawnAttempted','spawnUnobserved','cleanupConfirmed','cleanupUncertain','effectsUncertain','transportCleanupConfirmed','executionBlocked','remoteResponseObserved','nativeConfirmed','utilityAcknowledged','utilityExitObserved','utilityExitObservable','engineCloseAcknowledged','acknowledged','exitObserved','closeObserved','resultObserved','stopRequested','stopSendFailed','forcedStop','requested','settled','nativeExitObserved','resultComplete','incomplete','complete','confirmed','exited','closed','cancelled','timedOut']);
const numeric = new Set(['exitCode','ordinal','revision','turnIndex','activeProcessCount','fileCount','bytes','schemaVersion','generation','evictedCount','userVersion']);
const ids = new Set(['id','runId','sessionId','toolCallId','turnId','attemptId','workspaceId','childRunId','connectionId']);
const forbidden = /(?:^|\/)(?:accounts?|auth|credentials?|settings\.json|cookies|cache|local storage|session storage|indexeddb|browser|profile|\.git)(?:\/|$)|(?:token|secret|credential|\.pem$|\.p12$|\.key$)/iu;
function errorCode(code) { return { code }; }
function within(parent, child) { const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function projection(input, budget = { nodes: 0, truncated: false }, depth = 0) {
  if (++budget.nodes > 2048 || depth > 8) { budget.truncated = true; return null; }
  if (!input || typeof input !== 'object') return null;
  if (Array.isArray(input)) {
    if (input.length > DESKTOP_EVIDENCE_LIMITS.records) budget.truncated = true;
    return input.slice(0, DESKTOP_EVIDENCE_LIMITS.records).map(item => projection(item, budget, depth + 1));
  }
  const output = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (++budget.nodes > 2048) { budget.truncated = true; break; }
    if (!('value' in descriptor)) continue;
    const value = descriptor.value;
    if (booleans.has(key) && (typeof value === 'boolean' || value === null)) output[key] = value;
    else if (numeric.has(key) && (value === null || (Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000))) output[key] = value;
    else if (ids.has(key) && typeof value === 'string' && /^(?:(?:fixture-(?:read|patch|command)-)|(?:(?:child|worktree|terminal|attempt|part|run|turn)_))?[a-f0-9-]{32,36}$/iu.test(value)) output[key] = value;
    else if (['state','cleanupState','outcome'].includes(key) && typeof value === 'string' && states.has(value)) output[key] = value;
    else if (['sha256','fingerprint'].includes(key) && typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) output[key] = value;
    else if (['code','errorCode'].includes(key) && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) output[key] = value;
    else if (['signal','exitSignal'].includes(key) && (value === null || ['SIGINT','SIGTERM','SIGKILL','SIGHUP','SIGABRT','SIGSEGV'].includes(value))) output[key] = value;
    else if (key === 'platform' && ['darwin','linux','win32'].includes(value)) output[key] = value;
    else if (key === 'source' && ['original-supervisor','actual-engine-utility','actual-native-IPC','read-only-native-sqlite','driver-protocol','driver-lifecycle','driver-deadline','original-electron-utility','utility-transport','unavailable'].includes(value)) output[key] = value;
    else if (key === 'scope' && ['engine','storage'].includes(value)) output[key] = value;
    else if (key === 'utilityScope' && ['all-fixture-utilities','private-coding-utility','main-utility','main-utilities','unknown'].includes(value)) output[key] = value;
    else if (key === 'reason' && (value === null || ['natural-done','error','consumer-close','cancel','restart','timeout','descendants','close-failed','not-observed','close-error','close-timeout','exit-timeout','exit-without-ack','nonzero-exit','exit-status-unknown','exit-unobservable','observation-limit'].includes(value))) output[key] = value;
    else if (key === 'completeness' && ['full','unknown'].includes(value)) output[key] = value;
    else if (key === 'kind' && ['command-supervisor','pty-supervisor','ready','started','result','diagnostics','exit','close','error','deadline','stop-requested','native-exit','group-probe','group-snapshot','group-cleanup','signal','supervisor-exit','supervisor-close','supervisor-lost'].includes(value)) output[key] = value;
    else if (key === 'presence' && ['present','absent','unknown'].includes(value)) output[key] = value;
    else if (key === 'method' && ['iterator-next-done','iterator-return-done','return-missing','return-rejected','return-timeout','return-not-done','iterator-unavailable','recovery','no-dispatch'].includes(value)) output[key] = value;
    else if (key === 'name' && typeof value === 'string' && ['read_file','apply_patch','run_command','ask_user','child_task','mcp_fixture_echo'].includes(value)) output[key] = value;
    else if (containers.has(key) && value && typeof value === 'object') output[key] = projection(value, budget, depth + 1);
  }
  return output;
}
function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) immutable(item); Object.freeze(value); }
  return value;
}

/** Registration proves this process generated an empty private fixture, rather than borrowing user data. */
export async function createDesktopTestDirectory(scenario) {
  assert.match(scenario, /^[a-z][a-z0-9-]{0,47}$/u);
  const directory = await realpath(await mkdtemp(join(tmpdir(), `moodcode-desktop-test-${scenario}-`)));
  const info = await lstat(directory);
  sources.set(directory, { dev: info.dev, ino: info.ino, uid: info.uid });
  return directory;
}
async function sourceDirectory(input) {
  assert.ok(typeof input === 'string' && isAbsolute(input), 'Evidence source must be a registered generated fixture.');
  const directory = resolve(input), registered = sources.get(directory), info = await lstat(directory);
  assert.ok(registered && info.isDirectory() && !info.isSymbolicLink() && info.dev === registered.dev && info.ino === registered.ino && info.uid === registered.uid,
    'Evidence source must remain the original registered generated fixture.');
  assert.equal(await realpath(directory), directory, 'Evidence source must not be redirected.');
  return directory;
}
function allowedFile(path) {
  const normalized = path.split(sep).join('/');
  if (normalized.length > 512 || forbidden.test(normalized)) return false;
  if (/^(?:userData\/)?(?:engine|coding|state|packaged\.effects)\.sqlite(?:\.(?:effects|owner|review)\.sqlite){0,3}(?:-(?:wal|shm))?$/u.test(normalized)) return true;
  return /^(?:userData\/)?(?:artifacts|coding-artifacts)\//u.test(normalized);
}
async function nativeFiles(root) {
  const files = [], errors = [];
  let truncated = false, visited = 0;
  async function visit(directory, depth) {
    if (depth > DESKTOP_EVIDENCE_LIMITS.depth || visited > 512) { truncated = true; return; }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => { errors.push(errorCode('DIRECTORY_READ_FAILED')); return []; });
    const priority = name => /\.sqlite(?:-(?:wal|shm))?$/u.test(name) ? 0 : name === 'userData' ? 1 : 2;
    for (const entry of entries.sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name))) {
      if (++visited > 512) { truncated = true; break; }
      const path = join(directory, entry.name), name = relative(root, path), normalized = name.split(sep).join('/');
      if (forbidden.test(normalized)) continue;
      const info = await lstat(path).catch(() => undefined);
      if (!info) { errors.push(errorCode('SOURCE_FILE_DISAPPEARED')); continue; }
      if (info.isSymbolicLink()) { errors.push(errorCode('SOURCE_LINK_REJECTED')); continue; }
      if (info.isDirectory()) {
        if (normalized === 'userData' || /^(?:userData\/)?(?:artifacts|coding-artifacts)(?:\/|$)/u.test(normalized)) await visit(path, depth + 1);
      } else if (info.isFile() && allowedFile(name)) {
        if (info.nlink !== 1 || info.uid !== sources.get(root).uid) { errors.push(errorCode('SOURCE_IDENTITY_REJECTED')); continue; }
        if (files.length >= DESKTOP_EVIDENCE_LIMITS.files) { truncated = true; continue; }
        files.push({ path, name, info });
      }
    }
  }
  await visit(root, 0);
  return { files, errors: errors.slice(0, 32), truncated };
}
async function observeFile(root, file, limit) {
  let handle;
  try {
    assert.ok(within(root, await realpath(file.path)), 'Native evidence path escaped its fixture.');
    handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    assert.ok(before.isFile() && before.nlink === 1 && before.uid === sources.get(root).uid && before.dev === file.info.dev && before.ino === file.info.ino, 'Native evidence identity changed.');
    if (before.size > limit) return { omitted: 'BYTE_LIMIT', bytes: before.size };
    const bytes = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < bytes.length) { const part = await handle.read(bytes, read, bytes.length - read, read); if (!part.bytesRead) break; read += part.bytesRead; }
    const after = await handle.stat(), pathAfter = await lstat(file.path);
    assert.ok(within(root, await realpath(file.path)) && !pathAfter.isSymbolicLink(), 'Native evidence path was redirected.');
    if (read > limit) return { omitted: 'BYTE_LIMIT', bytes: read };
    const content = bytes.subarray(0, read);
    return { content, bytes: read, sha256: createHash('sha256').update(content).digest('hex'), observedStable: same(before, after) && same(after, pathAfter) && read === before.size };
  } catch { return { omitted: 'SOURCE_READ_OR_IDENTITY_FAILED' }; }
  finally { await handle?.close(); }
}

export async function captureDesktopNativeEvidence({ sourceDirectory: input, phase, liveSnapshot, close = {} }) {
  assert.ok(['before-close','after-close'].includes(phase));
  const root = await sourceDirectory(input), listing = await nativeFiles(root), sqlite = [];
  const tables = { runs: 'runs', tools: 'tools', parts: 'message_parts', turns: 'session_turns', attempts: 'provider_attempts', attemptCleanup: 'attempt_cleanup',
    mcpExecutions: 'mcp_executions', terminals: 'terminals', executionObservations: 'diagnostic_execution_observations' };
  const cloneRoot = await mkdtemp(join(tmpdir(), 'moodcode-native-evidence-clone-'));
  let bytesObserved = 0;
  const budget = { nodes: 0, truncated: false };
  const observations = new Map();
  let sqliteTruncated = listing.files.filter(file => file.name.endsWith('.sqlite')).length > 16;
  try {
    for (const file of listing.files.filter(file => /\.sqlite(?:-(?:wal|shm))?$/u.test(file.name))) {
      const observation = await observeFile(root, file, DESKTOP_EVIDENCE_LIMITS.bytes - bytesObserved);
      observations.set(file.name, observation);
      if (!observation.omitted) {
        bytesObserved += observation.bytes;
        const target = join(cloneRoot, file.name);
        await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
        await writeFile(target, observation.content, { mode: 0o600, flag: 'wx' });
      }
    }
    for (const file of listing.files.filter(file => file.name.endsWith('.sqlite')).slice(0, 16)) {
      const observation = observations.get(file.name);
      const item = { file: file.name.split(sep).join('/'), available: false, records: {}, errors: [],
        nativeCoverage: 'unrecognized',
        readSource: 'bounded-observed-file-clone', originalSQLiteOpened: false,
        fileObservation: { bytes: observation.bytes ?? null, sha256: observation.sha256 ?? null, observedStable: observation.observedStable ?? false } };
      let db;
      if (!observation.omitted) try {
      db = new DatabaseSync(join(cloneRoot, file.name), { readOnly: true, timeout: 0 });
      item.userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
      const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 64").all();
      if (!userTables.length && item.userVersion === 0 && observation.bytes === 0 && /\.(?:effects|owner)\.sqlite$/u.test(file.name)) {
        item.nativeCoverage = 'empty-execution-lock';
        item.records.executionLock = { available: true, active: false };
      }
      for (const [key, table] of Object.entries(tables)) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(value => value.name);
        const column = columns.includes('data') ? 'data' : columns.includes('payload') ? 'payload' : undefined;
        if (!column) continue;
        item.nativeCoverage = 'engine-records';
        if (Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count) > DESKTOP_EVIDENCE_LIMITS.records) sqliteTruncated = true;
        const rows = db.prepare(`SELECT substr(${column},1,16384) AS data FROM ${table} LIMIT 32`).all();
        item.records[key] = rows.map(row => { try {
          const original = JSON.parse(row.data), projected = projection(original, budget);
          if (key === 'tools' && original.name === 'run_command' && typeof original.output === 'string') {
            const receipt = /^Command completed; exitCode=(-?\d+|null); signal=(null|SIG[A-Z]+); cleanupConfirmed=(true|false)\./u.exec(original.output);
            if (receipt) { projected.cleanupConfirmed = receipt[3] === 'true'; projected.exitCode = receipt[1] === 'null' ? null : Number(receipt[1]); }
          }
          return projected;
        } catch { return { code: 'ROW_PROJECTION_UNAVAILABLE' }; } });
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='command_execution'").get()) {
        item.nativeCoverage = 'execution-lock';
        const markers = db.prepare('SELECT id,active FROM command_execution LIMIT 2').all();
        if (item.userVersion !== 0 || markers.length > 1 || markers.some(marker => marker.id !== 1 || ![0, 1].includes(marker.active))) {
          item.records.executionLock = { available: false, active: null, error: { code: 'EXECUTION_LOCK_PROJECTION_UNAVAILABLE' } };
        } else item.records.executionLock = { available: true, active: markers[0]?.active === 1 };
      }
      if (item.userVersion === 1 && Number(db.prepare('PRAGMA application_id').get().application_id) === 0x4d43524a
          && userTables.length === 1 && userTables[0].name === 'review_operations') {
        item.nativeCoverage = 'review-journal';
        if (Number(db.prepare('SELECT count(*) AS count FROM review_operations').get().count) > DESKTOP_EVIDENCE_LIMITS.records) sqliteTruncated = true;
        item.records.reviewOperations = db.prepare('SELECT state,substr(result,1,16384) AS result,substr(error,1,16384) AS error FROM review_operations LIMIT 32').all().map(row => {
          try {
            const result = row.result === null ? null : JSON.parse(row.result), error = row.error === null ? null : JSON.parse(row.error);
            if (!['started','completed','failed','interrupted'].includes(row.state)) throw new Error();
            return { state: row.state, effectsUncertain: row.state !== 'completed' || result?.truncated === true || result?.failed?.length > 0 || result?.totals?.failed > 0,
              ...(error ? { error: projection(error, budget) } : {}) };
          } catch { return { code: 'ROW_PROJECTION_UNAVAILABLE' }; }
        });
      }
      item.available = true;
      } catch { item.errors.push(errorCode('SQLITE_CLONE_READ_FAILED')); }
      else item.errors.push(errorCode(observation.omitted));
      db?.close();
      const after = await observeFile(root, file, observation.bytes ?? 0);
      item.fileObservation.after = { bytes: after.bytes ?? null, sha256: after.sha256 ?? null, observedStable: after.observedStable ?? false };
      item.fileObservation.stableAcrossCapture = observation.observedStable === true && after.observedStable === true && observation.sha256 === after.sha256;
      item.fileObservation.companions = [];
      for (const suffix of ['-wal','-shm']) {
        const companionFile = listing.files.find(item => item.name === `${file.name}${suffix}`);
        if (!companionFile) continue;
        const original = observations.get(companionFile.name), companionAfter = await observeFile(root, companionFile, original.bytes ?? 0);
        const stable = original.observedStable === true && companionAfter.observedStable === true && original.sha256 === companionAfter.sha256;
        item.fileObservation.companions.push({ suffix, bytes: original.bytes ?? null, sha256: original.sha256 ?? null, observedStable: original.observedStable ?? false,
          after: { bytes: companionAfter.bytes ?? null, sha256: companionAfter.sha256 ?? null, observedStable: companionAfter.observedStable ?? false }, stableAcrossCapture: stable });
        item.fileObservation.stableAcrossCapture &&= stable;
      }
      sqlite.push(item);
    }
  } finally { await rm(cloneRoot, { recursive: true, force: true }); }
  const live = projection(liveSnapshot, budget) ?? {};
  const captured = { schemaVersion: 1, phase, live: { available: liveSnapshot !== undefined, source: liveSnapshot === undefined ? 'unavailable' : 'actual-native-IPC', records: live },
    close: projection(close, budget), sqlite, errors: listing.errors, truncated: listing.truncated || budget.truncated || sqliteTruncated,
    qualification: { cleanupAuthority: 'original-native-source-only', physicalAbsenceEstablishesCleanup: false, coherentRecoveryBackup: false, nativeReadSource: 'bounded-observed-file-clones', originalSQLiteOpened: false } };
  if (Buffer.byteLength(JSON.stringify(captured)) > DESKTOP_EVIDENCE_LIMITS.manifestBytes / 4) {
    captured.live.records = {};
    for (const item of captured.sqlite) { item.records = {}; item.errors.push(errorCode('METADATA_LIMIT')); }
    captured.truncated = true;
  }
  captures.add(captured);
  return immutable(captured);
}

export async function preserveDesktopTestEvidence({ sourceDirectory: input, artifactDirectory, scenario, outcome, cleanup, nativeBeforeClose, nativeAfterClose }) {
  const root = await sourceDirectory(input);
  assert.match(scenario, /^[a-z][a-z0-9-]{0,47}$/u);
  assert.ok(['failed','unknown'].includes(outcome), 'Only failed or uncertain fixture evidence is preserved.');
  assert.ok(isAbsolute(artifactDirectory) && !within(root, resolve(artifactDirectory)), 'Evidence destination must be outside its original fixture.');
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const destination = await realpath(artifactDirectory), directory = await mkdtemp(join(destination, `${scenario}-`));
  const listing = await nativeFiles(root), files = [], errors = [...listing.errors];
  let totalBytes = 0, truncated = listing.truncated;
  for (const file of listing.files) {
    const observed = await observeFile(root, file, DESKTOP_EVIDENCE_LIMITS.bytes - totalBytes);
    const record = { file: file.name.split(sep).join('/'), bytes: observed.bytes ?? null, sha256: observed.sha256 ?? null,
      observedStable: observed.observedStable ?? false, copied: false };
    if (observed.omitted) { record.omitted = observed.omitted; truncated = true; }
    else {
      const target = join(directory, 'native', file.name);
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, observed.content, { mode: 0o600, flag: 'wx' });
      record.copied = true; totalBytes += observed.bytes;
    }
    files.push(record);
  }
  const cleanupState = ['confirmed','unconfirmed','unknown'].includes(cleanup?.state) ? cleanup.state : 'unknown';
  const manifest = { schemaVersion: 1, scenario, outcome, sourceFixture: basename(root), originalSourceRetained: true,
    cleanup: { state: cleanupState, nativeConfirmed: typeof cleanup?.nativeConfirmed === 'boolean' ? cleanup.nativeConfirmed : null,
      utilityAcknowledged: typeof cleanup?.utilityAcknowledged === 'boolean' ? cleanup.utilityAcknowledged : null,
      utilityExitObserved: typeof cleanup?.utilityExitObserved === 'boolean' ? cleanup.utilityExitObserved : null, forcedStop: cleanup?.forcedStop === true,
      utilityScope: ['all-fixture-utilities','private-coding-utility','main-utility'].includes(cleanup?.utilityScope) ? cleanup.utilityScope : 'unknown' },
    nativeBeforeClose, nativeAfterClose, files, errors, totalBytes, truncated,
    qualification: { rawCopies: 'observed-bytes-and-hashes-only', coherentRecoveryBackup: false, cleanupAuthority: 'original-native-source-only', physicalAbsenceEstablishesCleanup: false } };
  // Captures contain only this helper's bounded native metadata; caller objects are projected again.
  for (const key of ['nativeBeforeClose','nativeAfterClose']) {
    const value = manifest[key];
    if (value && captures.has(value)) {
      manifest[key] = { ...value, live: { available: value.live?.available === true, source: value.live?.available === true ? 'actual-native-IPC' : 'unavailable', records: projection(value.live?.records) }, close: projection(value.close) };
    } else manifest[key] = projection(value);
  }
  let serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > DESKTOP_EVIDENCE_LIMITS.manifestBytes) {
    manifest.nativeBeforeClose = { code: 'METADATA_LIMIT', phase: 'before-close' }; manifest.nativeAfterClose = { code: 'METADATA_LIMIT', phase: 'after-close' };
    manifest.truncated = true; serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  assert.ok(Buffer.byteLength(serialized) <= DESKTOP_EVIDENCE_LIMITS.manifestBytes);
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, serialized, { mode: 0o600, flag: 'wx' });
  return { directory, manifestPath, copiedFiles: files.filter(file => file.copied).length, totalBytes, truncated: manifest.truncated, originalSourceRetained: true, originalSourceDirectory: root };
}
