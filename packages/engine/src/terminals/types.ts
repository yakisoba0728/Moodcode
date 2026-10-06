export type TerminalState = 'starting' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'uncertain';
export interface TerminalOwner { authority: 'user'; workspaceId: string; sessionId: string }
export interface TerminalOutput { seq: number; data: string; bytes: number }
export interface TerminalRecord {
  version: 1; id: string; owner: TerminalOwner; cwd: string; file: string; args: string[];
  cols: number; rows: number; state: TerminalState; createdAt: string; updatedAt: string;
  outputSeq: number; oldestSeq: number; observedBytes: number; retainedBytes: number;
  cleanupConfirmed: boolean | null; exitCode: number | null; reason?: string;
}
export interface TerminalSnapshot { record: TerminalRecord; output: TerminalOutput[] }
export interface TerminalReplay { terminal: TerminalRecord; output: TerminalOutput[]; nextSeq: number; gap: boolean; hasMore: boolean }
export type TerminalEvent = { type: 'output'; terminalId: string; output: TerminalOutput } | { type: 'state'; terminal: TerminalRecord };
export interface TerminalAttachment { id: string; replay: TerminalReplay; events: AsyncIterable<TerminalEvent>; detach(): void }
export interface TerminalCreateRequest { owner: TerminalOwner; cwd?: string; file?: string; args?: string[]; cols?: number; rows?: number; signal?: AbortSignal }
export interface PtySpawnInput { file: string; args: string[]; cwd: string; cols: number; rows: number; maxDurationMs: number }
export interface PtyOutcome { exitCode: number | null; cancelled: boolean; timedOut: boolean; cleanupConfirmed: boolean; reason?: string }
export interface PtyProcess { readonly pid: number; readonly closed: Promise<PtyOutcome>; write(data: string): Promise<void>; resize(cols: number, rows: number): Promise<void>; cancel(): Promise<PtyOutcome> }
export interface PtyCapability { available: boolean; platform: string; backend: 'posix-pty-supervisor' | 'unavailable'; processTree: 'posix-group' | 'unsupported'; isolation: 'host-user'; code?: string }
export interface PtyBackend { capability(): Promise<PtyCapability>; spawn(input: PtySpawnInput, output: (data: string) => void): Promise<PtyProcess> }
export interface TerminalJournal { load(): TerminalSnapshot[]; save(snapshot: TerminalSnapshot): void; remove(id: string): void }

export const TERMINAL_LIMITS = Object.freeze({
  maxTerminals: 16, maxTerminalsPerSession: 4, maxRecords: 128, maxAttachments: 4,
  bufferBytes: 262_144, eventBytes: 16_384, attachmentBytes: 65_536,
  maxWriteBytes: 16_384, maxPendingWrites: 4, maxDurationMs: 3_600_000,
  startupMs: 10_000, cleanupMs: 4_000, maxCols: 512, maxRows: 256,
});
