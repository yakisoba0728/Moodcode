export interface WindowsJobSpawnInput {
  command: string;
  cwd: string;
  environment: Record<string, string>;
}
export interface WindowsJobOutput {
  stdout: Buffer;
  stderr: Buffer;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  exited: boolean;
  exitCode: number | null;
}
export interface WindowsJobProcess {
  readonly pid: number;
  /** Nonblocking read, bounded to 0..65536 bytes per stream. Zero only polls. */
  readOutput(maxBytes?: number): WindowsJobOutput;
  terminate(): void;
  /** Idempotent; unread output is discarded, a running primary is terminated. */
  close(): void;
}
export interface WindowsNativeJob {
  spawnSuspended(input: WindowsJobSpawnInput): WindowsJobProcess;
  assign(child: WindowsJobProcess): void;
  resume(child: WindowsJobProcess): void;
  terminate(): void;
  activeProcessCount(): number;
  /** Idempotent; closing the sole owner handle kills all owned descendants. */
  close(): void;
}
export interface WindowsJobNativeInfo {
  bindingVersion: 1;
  napiVersion: 8;
  platform: 'win32';
  arch: 'x64' | 'arm64';
  atomicJobAssignment: true;
}
export interface WindowsJobBinding {
  createJob(): WindowsNativeJob;
  nativeInfo(): WindowsJobNativeInfo;
  currentProcessHandleCount(): number;
}
export function loadBinding(): WindowsJobBinding;
export function isAvailable(): boolean;
export function createJob(): WindowsNativeJob;
export function nativeInfo(): WindowsJobNativeInfo;
export function currentProcessHandleCount(): number;
