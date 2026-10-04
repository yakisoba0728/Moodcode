import { EngineError } from '@moodcode/contracts';
import { assessCommandPlatform, assessNodeVersion, checkAbort, probeArtifactParent, probeSqlite } from './checks.js';
import { probeGit, probeWorkspace } from './git.js';
import type { DiagnosticsOptions, DiagnosticsReport } from './types.js';

export type * from './types.js';

export const DIAGNOSTICS_LIMITS = Object.freeze({ defaultTimeoutMs: 3_000, maxTimeoutMs: 10_000, defaultReportBytes: 16_384, minReportBytes: 2_048, maxReportBytes: 65_536, maxPathBytes: 4_096, maxCredentialNames: 32, maxCredentialNameBytes: 128 });

function invalid(message: string): never { throw new EngineError('INVALID_DIAGNOSTICS_OPTIONS', message); }

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

function validate(options: DiagnosticsOptions): Required<Pick<DiagnosticsOptions, 'timeoutMs' | 'maxReportBytes' | 'gitExecutable' | 'credentialEnvNames'>> & DiagnosticsOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return invalid('Diagnostics options must be an object');
  const allowed = ['workspacePath', 'artifactParent', 'credentialEnvNames', 'gitExecutable', 'timeoutMs', 'maxReportBytes', 'signal'];
  if (Object.keys(options).some(key => !allowed.includes(key))) return invalid('Diagnostics options contain an unknown property');
  for (const value of [options.workspacePath, options.artifactParent, options.gitExecutable]) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > DIAGNOSTICS_LIMITS.maxPathBytes)) return invalid('Paths must be nonempty strings of at most 4096 UTF-8 bytes without NUL');
  }
  const timeoutMs = options.timeoutMs ?? DIAGNOSTICS_LIMITS.defaultTimeoutMs;
  const maxReportBytes = options.maxReportBytes ?? DIAGNOSTICS_LIMITS.defaultReportBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DIAGNOSTICS_LIMITS.maxTimeoutMs) return invalid('timeoutMs must be an integer from 1 to 10000');
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes < DIAGNOSTICS_LIMITS.minReportBytes || maxReportBytes > DIAGNOSTICS_LIMITS.maxReportBytes) return invalid('maxReportBytes must be an integer from 2048 to 65536');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return invalid('signal must be an AbortSignal');
  const names = options.credentialEnvNames ?? [];
  if (!Array.isArray(names) || names.length > DIAGNOSTICS_LIMITS.maxCredentialNames || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Buffer.byteLength(name) > DIAGNOSTICS_LIMITS.maxCredentialNameBytes)) return invalid('credentialEnvNames must contain at most 32 valid environment variable names');
  return { ...options, timeoutMs, maxReportBytes, gitExecutable: options.gitExecutable ?? 'git', credentialEnvNames: [...new Set(names)] };
}

function applyReportBudget(report: DiagnosticsReport, maxBytes: number): DiagnosticsReport {
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(report)) <= maxBytes;
  const omitted = (field: string): void => { report.truncated = true; if (!report.omittedDetails.includes(field)) report.omittedDetails.push(field); };
  if (fits()) return report;
  if (report.workspace !== undefined) {
    delete report.workspace.requestedPath;
    delete report.workspace.root;
    delete report.workspace.branch;
    omitted('workspace.pathsAndBranch');
  }
  if (fits()) return report;
  if (report.artifacts !== undefined) {
    delete report.artifacts.requestedParent;
    delete report.artifacts.existingAncestor;
    omitted('artifacts.paths');
  }
  if (fits()) return report;
  delete report.git.executable;
  omitted('git.executable');
  while (!fits() && report.warnings.length > 0) { report.warnings.pop(); report.warningsOmitted++; omitted('warnings'); }
  while (!fits() && report.credentials.checks.length > 0) { report.credentials.checks.pop(); report.credentials.omitted++; omitted('credentials.checks'); }
  if (!fits()) throw new EngineError('DIAGNOSTICS_REPORT_LIMIT', 'Diagnostics metadata exceeds the report byte budget');
  return report;
}

/** Read-only environment diagnostics. Existing engine databases and owner locks are never opened. */
export async function getDiagnostics(options: DiagnosticsOptions = {}): Promise<DiagnosticsReport> {
  const selected = validate(options);
  checkAbort(selected.signal);
  const probeOptions = { executable: selected.gitExecutable, timeoutMs: selected.timeoutMs, ...(selected.signal === undefined ? {} : { signal: selected.signal }) };
  const probes = await Promise.allSettled([
    probeSqlite(), probeGit(probeOptions), selected.artifactParent === undefined ? Promise.resolve(undefined) : probeArtifactParent(selected.artifactParent, selected.signal),
  ] as const);
  checkAbort(selected.signal);
  const sqlite = settledValue(probes[0]);
  const git = settledValue(probes[1]);
  const artifacts = settledValue(probes[2]);
  const workspace = selected.workspacePath === undefined ? undefined : await probeWorkspace(selected.workspacePath, git, probeOptions);
  checkAbort(selected.signal);
  const node = assessNodeVersion(process.version);
  const command = assessCommandPlatform(process.platform);
  const report: DiagnosticsReport = {
    schemaVersion: 1, observedAt: new Date().toISOString(),
    ok: node.meetsMinimum === true && sqlite.verified && git.available && command.supported === true && (workspace === undefined || workspace.status === 'available') && (artifacts === undefined || artifacts.createPossible === true),
    runtime: { node, platform: process.platform, architecture: process.arch, electron: { detected: typeof process.versions.electron === 'string', actualVersion: process.versions.electron ?? null }, command },
    sqlite, git, ...(workspace === undefined ? {} : { workspace }), ...(artifacts === undefined ? {} : { artifacts }),
    credentials: { assessment: 'environment_key_presence_only', checks: selected.credentialEnvNames.map(name => ({ name, configured: Object.hasOwn(process.env, name) })), omitted: 0 },
    warnings: [], warningsOmitted: 0, truncated: false, omittedDetails: [],
  };
  if (node.meetsMinimum !== true) report.warnings.push({ code: 'NODE_REQUIREMENT_NOT_CONFIRMED', message: 'Node version does not confirm the package minimum requirement.' });
  if (git.available && !git.versionRecognized) report.warnings.push({ code: 'GIT_VERSION_UNRECOGNIZED', message: 'Git version command succeeded, but its version format is unknown.' });
  if (sqlite.verified && !sqlite.versionRecognized) report.warnings.push({ code: 'SQLITE_VERSION_UNRECOGNIZED', message: 'The memory query succeeded, but the SQLite version format is unknown.' });
  if (artifacts !== undefined) report.warnings.push({ code: 'ARTIFACT_CREATION_INFERRED', message: 'Permission checks do not verify disk space, ACL races or an actual write. No parent directory was created.' });
  if (process.platform === 'win32') report.warnings.push({ code: 'COMMAND_PLATFORM_UNSUPPORTED', message: 'Windows command process-tree cleanup is unsupported. Git and SQLite are checked separately.' });
  if (git.status === 'timeout') report.warnings.push({ code: 'GIT_TIMEOUT', message: 'The Git version process exceeded its timeout.' });
  checkAbort(selected.signal);
  return applyReportBudget(report, selected.maxReportBytes);
}
