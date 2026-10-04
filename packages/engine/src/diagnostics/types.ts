export interface DiagnosticsOptions {
  workspacePath?: string;
  artifactParent?: string;
  credentialEnvNames?: readonly string[];
  gitExecutable?: string;
  /** Timeout for each shell-free Git process, from 1 to 10,000 milliseconds. */
  timeoutMs?: number;
  /** Maximum UTF-8 bytes of compact JSON, from 2,048 to 65,536. */
  maxReportBytes?: number;
  signal?: AbortSignal;
}

export interface NodeAssessment {
  actualVersion: string;
  versionRecognized: boolean;
  requiredVersion: '>=24.0.0';
  meetsMinimum: boolean | null;
  assessment: 'version_comparison';
}

export interface CommandPlatformAssessment {
  platform: string;
  supported: boolean | null;
  code: 'POSIX_PROCESS_GROUPS' | 'COMMAND_PLATFORM_UNSUPPORTED' | 'UNKNOWN_PLATFORM';
  assessment: 'implementation_policy';
}

export interface SqliteDiagnostic {
  available: boolean;
  verified: boolean;
  version: string | null;
  versionRecognized: boolean;
  probe: 'memory_database';
  code?: string;
}

export interface GitDiagnostic {
  available: boolean;
  version: string | null;
  versionRecognized: boolean;
  status: 'available' | 'unknown_version' | 'missing' | 'timeout' | 'failed';
  executable?: string;
  timeoutMs: number;
  configuration: 'system_and_global_disabled';
  automaticFetch: 'disabled';
  processCleanup: 'posix_process_group' | 'direct_child';
  code?: string;
}

export interface WorkspaceDiagnostic {
  status: 'available' | 'failed' | 'not_checked';
  requestedPath?: string;
  root?: string;
  branch?: string | null;
  dirty?: boolean | null;
  statusEntries?: number;
  untrackedEntries?: number;
  conflictedEntries?: number;
  code?: string;
}

export interface ArtifactDiagnostic {
  status: 'observed' | 'failed';
  requestedParent?: string;
  existingAncestor?: string;
  missingDirectories?: number;
  mode?: string;
  readable?: boolean;
  writable?: boolean;
  searchable?: boolean | null;
  createPossible: boolean | null;
  assessment: 'access_checks_only';
  code?: string;
}

export interface DiagnosticsReport {
  schemaVersion: 1;
  observedAt: string;
  ok: boolean;
  runtime: {
    node: NodeAssessment;
    platform: string;
    architecture: string;
    electron: { detected: boolean; actualVersion: string | null };
    command: CommandPlatformAssessment;
  };
  sqlite: SqliteDiagnostic;
  git: GitDiagnostic;
  workspace?: WorkspaceDiagnostic;
  artifacts?: ArtifactDiagnostic;
  credentials: {
    assessment: 'environment_key_presence_only';
    checks: { name: string; configured: boolean }[];
    omitted: number;
  };
  warnings: { code: string; message: string }[];
  warningsOmitted: number;
  truncated: boolean;
  omittedDetails: string[];
}
