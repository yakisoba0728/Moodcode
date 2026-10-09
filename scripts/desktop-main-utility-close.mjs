import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAIN_UTILITY_CLOSE_EVENT = 'moodcode:utility-close';

/** Exact allowlist shared by the driver and its original Electron main listener. */
export function projectMainUtilityClose(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.utilityScope !== 'main-utilities') return null;
  const boolean = item => typeof item === 'boolean' ? item : null;
  const number = item => Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000 ? item : null;
  const reasons = ['close-error', 'close-timeout', 'exit-timeout', 'exit-without-ack', 'nonzero-exit', 'exit-status-unknown', 'exit-unobservable', 'observation-limit'];
  const connections = Array.isArray(value.connections) ? value.connections.slice(0, 64).map(item => ({
    connectionId: typeof item?.connectionId === 'string' && /^[a-f0-9-]{36}$/iu.test(item.connectionId) ? item.connectionId : null,
    scope: ['engine', 'storage'].includes(item?.scope) ? item.scope : null,
    source: ['original-electron-utility', 'utility-transport'].includes(item?.source) ? item.source : null,
    generation: number(item?.generation),
    utilityExitObservable: boolean(item?.utilityExitObservable),
    engineCloseAcknowledged: boolean(item?.engineCloseAcknowledged),
    utilityExitObserved: boolean(item?.utilityExitObserved),
    exitCode: Number.isInteger(item?.exitCode) && Math.abs(item.exitCode) <= 1_000_000 ? item.exitCode : null,
    cleanupConfirmed: boolean(item?.cleanupConfirmed),
    forcedStop: boolean(item?.forcedStop),
    reason: reasons.includes(item?.reason) ? item.reason : item?.reason === null ? null : 'observation-limit',
  })) : [];
  const complete = value.complete === true && value.spawnUnobserved === false && Array.isArray(value.connections) && value.connections.length <= 64;
  return { schemaVersion: 1, utilityScope: 'main-utilities', complete, spawnAttempted: boolean(value.spawnAttempted), spawnUnobserved: boolean(value.spawnUnobserved), evictedCount: number(value.evictedCount), connections,
    utilityAcknowledged: boolean(value.utilityAcknowledged), utilityExitObserved: boolean(value.utilityExitObserved),
    cleanupConfirmed: boolean(value.cleanupConfirmed), forcedStop: boolean(value.forcedStop) };
}

/** Only fixture code binds this read-only event; production main has no test file writer. */
export async function bindMainUtilityClose(application, directory) {
  const path = join(directory, 'main-utility-close.json');
  await application.evaluate(({ app }, { path, source, event }) => {
    const { writeFileSync } = process.getBuiltinModule('node:fs');
    const project = (0, eval)(`(${source})`);
    app.on(event, value => {
      const safe = project(value);
      if (safe) try { writeFileSync(path, `${JSON.stringify(safe)}\n`, { mode: 0o600 }); } catch { /* A missing receipt remains unknown. */ }
    });
  }, { path, source: projectMainUtilityClose.toString(), event: MAIN_UTILITY_CLOSE_EVENT });
  return path;
}

export async function readMainUtilityClose(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024) return null;
    return projectMainUtilityClose(JSON.parse(bytes));
  } catch { return null; }
}

export function qualifyMainUtilityClose(receipt) {
  const safe = projectMainUtilityClose(receipt);
  const covered = safe?.complete === true && safe.evictedCount === 0 && safe.connections.length > 0
    && new Set(safe.connections.map(item => item.connectionId)).size === safe.connections.length
    && safe.connections.every(item => item.connectionId && item.scope && item.source === 'original-electron-utility' && item.utilityExitObservable === true);
  const acknowledged = covered ? safe.connections.every(item => item.engineCloseAcknowledged === true) : null;
  const exitObserved = covered ? safe.connections.every(item => item.utilityExitObserved === true) : null;
  const confirmed = covered && acknowledged && exitObserved && safe.spawnAttempted === true && safe.forcedStop === false
    && safe.connections.every(item => item.exitCode === 0 && item.cleanupConfirmed === true && item.forcedStop === false && item.reason === null)
    && safe.utilityAcknowledged === true && safe.utilityExitObserved === true && safe.cleanupConfirmed === true;
  return { state: confirmed ? 'confirmed' : 'unknown', utilityAcknowledged: acknowledged, utilityExitObserved: exitObserved,
    forcedStop: safe?.forcedStop === true || safe?.connections.some(item => item.forcedStop) === true, utilityScope: 'main-utility', receipt: safe };
}

/** Native cleanup must be recorded in bounded clones; utility or app exit cannot supply it. */
export function qualifyDesktopNativeCleanup(capture) {
  if (!capture) return null;
  let uncertain = false;
  const visit = (value, context = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, context); return; }
    if (value.cleanupUncertain === true || value.effectsUncertain === true || value.cleanupConfirmed === false || value.nativeConfirmed === false
        || value.transportCleanupConfirmed === false || value.executionBlocked === true || value.state === 'uncertain') uncertain = true;
    if (context === 'executionLock' && value.active === true) uncertain = true;
    if ([value.code, value.errorCode].some(code => typeof code === 'string' && /(?:^|_)CLEANUP_UNCERTAIN$/u.test(code))) uncertain = true;
    for (const [key, child] of Object.entries(value)) if (key !== 'events' && child && typeof child === 'object') visit(child, key);
  };
  // After-close persisted records provide the terminal states. A before-close
  // running record is retained for evidence, never reused as final cleanup proof.
  for (const item of capture.sqlite ?? []) if (item.available === true && item.fileObservation?.stableAcrossCapture === true) visit(item.records);
  visit(capture.live?.records);
  // This bounded projection does not cover every native store/document (for
  // example persisted child and resident ownership). Observed uncertainty is
  // meaningful; an absence in this partial projection cannot prove full cleanup.
  return uncertain ? false : null;
}

export function aggregateFixtureCleanup({ mainReceipt, nativeConfirmed, privateUtilities = [], privateUtilitiesExpected = 0 }) {
  const main = qualifyMainUtilityClose(mainReceipt);
  const privateCovered = privateUtilities.length === privateUtilitiesExpected
    && privateUtilities.every(item => item?.utilityScope === 'private-coding-utility');
  const observed = field => main[field] === false || privateUtilities.some(item => item?.[field] === false) ? false
    : main[field] === true && privateCovered && privateUtilities.every(item => item?.[field] === true) ? true : null;
  const utilityAcknowledged = observed('utilityAcknowledged');
  const utilityExitObserved = observed('utilityExitObserved');
  const forcedStop = main.forcedStop || privateUtilities.some(item => item?.forcedStop === true);
  const native = nativeConfirmed === false || privateUtilities.some(item => item?.nativeConfirmed === false) ? false
    : nativeConfirmed === true && privateCovered && privateUtilities.every(item => item?.nativeConfirmed === true) ? true : null;
  const privateCloseConfirmed = privateCovered && privateUtilities.every(item => item?.state === 'confirmed' || item?.utilityExitCode === 0);
  const confirmed = main.state === 'confirmed' && privateCloseConfirmed && utilityAcknowledged === true && utilityExitObserved === true && native === true && !forcedStop;
  return { state: confirmed ? 'confirmed' : native === false ? 'unconfirmed' : 'unknown', nativeConfirmed: native,
    utilityAcknowledged, utilityExitObserved, forcedStop, utilityScope: confirmed ? 'all-fixture-utilities' : 'main-utility' };
}
