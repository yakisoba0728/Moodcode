import { createHash, type Hash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EngineError } from "@moodcode/contracts";
import {
  COMMAND_OBSERVATION_LIMITS,
  validateCommandArtifactDescriptor,
  type CommandArtifactDescriptor,
  type CommandOutputStream,
} from "./observation.js";
import { errorText, type ProcessOutcome } from "./process-control.js";

/** Capture and artifact budgets are shared by stdout and stderr. */
export const COMMAND_LIMITS = Object.freeze({
  maxCommandBytes: 16_384,
  maxTimeoutMs: 300_000,
  captureBytes: 262_144,
  modelBytes: 65_536,
  artifactBytes: COMMAND_OBSERVATION_LIMITS.artifactBytes,
  checkpointTimeoutMs: 2_000,
  supervisorStartupMs: 5_000,
});

export interface Capture {
  totalBytes: number;
  capturedBytes: number;
  buffers: Buffer[];
  artifactBytes: number;
  fd: number;
  path: string;
  hash: Hash;
  device: string;
  inode: string;
  closedStat?: { size: number; mtimeNs: string };
  sealFailed?: boolean;
}
export interface Captures {
  readonly stdout: Capture;
  readonly stderr: Capture;
}
export interface OutputData {
  text: string;
  totalBytes: number;
  observedBytes: number;
  capturedBytes: number;
  captureTruncatedBytes: number;
  modelBytes: number;
  modelSourceBytes: number;
  modelTruncatedBytes: number;
  artifactBytes: number;
  artifactTruncatedBytes: number;
}
export interface CaptureOutput {
  consume(stream: CommandOutputStream, chunk: Buffer | string): void;
  recordArtifactFailure(outcome: ProcessOutcome): void;
}

function newCapture(path: string): Capture {
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    return {
      totalBytes: 0,
      capturedBytes: 0,
      buffers: [],
      artifactBytes: 0,
      fd,
      path,
      hash: createHash("sha256"),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function createCaptures(artifactDir: string): Promise<Captures> {
  const root = resolve(artifactDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(await realpath(root), "command-"));
  await chmod(directory, 0o700);
  let stdout: Capture | undefined;
  try {
    stdout = newCapture(join(directory, "stdout.log"));
    return { stdout, stderr: newCapture(join(directory, "stderr.log")) };
  } catch (error) {
    if (stdout) closeSync(stdout.fd);
    throw error;
  }
}

export function captureOutput(
  captures: Captures,
  warnings: string[],
): CaptureOutput {
  let remainingCaptureBytes: number = COMMAND_LIMITS.captureBytes;
  let remainingArtifactBytes: number = COMMAND_LIMITS.artifactBytes;
  let artifactFailure = false;
  return {
    consume(stream, chunk) {
      const capture = captures[stream];
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      capture.totalBytes += bytes.byteLength;
      const capturedBytes = Math.min(bytes.byteLength, remainingCaptureBytes);
      if (capturedBytes > 0) {
        capture.buffers.push(Buffer.from(bytes.subarray(0, capturedBytes)));
        capture.capturedBytes += capturedBytes;
        remainingCaptureBytes -= capturedBytes;
      }
      const artifactBytes = Math.min(bytes.byteLength, remainingArtifactBytes);
      if (artifactBytes > 0 && !artifactFailure) {
        try {
          let offset = 0;
          while (offset < artifactBytes) {
            const written = writeSync(
              capture.fd,
              bytes,
              offset,
              artifactBytes - offset,
            );
            if (written < 1) throw new Error("Artifact write made no progress.");
            offset += written;
            capture.hash.update(bytes.subarray(offset - written, offset));
            capture.artifactBytes += written;
            remainingArtifactBytes -= written;
          }
        } catch (error) {
          artifactFailure = true;
          warnings.push(`Output artifact write failed: ${errorText(error)}`);
        }
      }
    },
    recordArtifactFailure(outcome) {
      if (artifactFailure)
        outcome.error ??=
          "Output artifact storage failed after the command started.";
    },
  };
}

function sealStat(capture: Capture, fd: number, message: string): void {
  const stat = fstatSync(fd, { bigint: true });
  if (
    !stat.isFile() ||
    stat.dev.toString() !== capture.device ||
    stat.ino.toString() !== capture.inode ||
    stat.size !== BigInt(capture.artifactBytes)
  )
    throw new EngineError("COMMAND_ARTIFACT_CHANGED", message);
  capture.closedStat = {
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

export function closeCaptures(
  captures: Captures,
  warnings: string[],
  seal = false,
): void {
  for (const capture of Object.values(captures)) {
    if (capture.fd < 0) continue;
    try {
      if (seal)
        sealStat(
          capture,
          capture.fd,
          "The actual command output file changed before sealing",
        );
    } catch (error) {
      capture.sealFailed = true;
      warnings.push(`Could not seal output artifact: ${errorText(error)}`);
    }
    try {
      closeSync(capture.fd);
    } catch (error) {
      capture.sealFailed = true;
      warnings.push(`Could not close output artifact: ${errorText(error)}`);
    }
    capture.fd = -1;
    if (seal && !capture.sealFailed && process.platform === "win32") {
      // Windows commits the last-write time on handle close: pin it afterwards, keeping the original identity and producer hash.
      let readFd: number | undefined;
      try {
        readFd = openSync(capture.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        sealStat(capture, readFd, "The output file changed while its write handle closed");
      } catch (error) {
        capture.sealFailed = true;
        warnings.push(`Could not seal closed output artifact: ${errorText(error)}`);
      } finally {
        if (readFd !== undefined) try { closeSync(readFd); }
        catch (error) { capture.sealFailed = true; warnings.push(`Could not close output seal reader: ${errorText(error)}`); }
      }
    }
  }
}

export function sealedArtifact(capture: Capture): CommandArtifactDescriptor {
  if (!capture.closedStat || capture.sealFailed || capture.fd >= 0)
    throw new EngineError(
      "COMMAND_ARTIFACT_UNSEALED",
      "The command output file has no confirmed original seal",
    );
  const fd = openSync(
    capture.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    const current = () => {
      const st = fstatSync(fd, { bigint: true });
      return (
        st.isFile() &&
        st.dev.toString() === capture.device &&
        st.ino.toString() === capture.inode &&
        st.size === BigInt(capture.closedStat!.size) &&
        st.mtimeNs.toString() === capture.closedStat!.mtimeNs
      );
    };
    if (!before.isFile() || !current())
      throw new EngineError(
        "COMMAND_ARTIFACT_CHANGED",
        "The current command output source differs from its original sealed file",
      );
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(16_384);
    for (let at = 0; at < capture.artifactBytes;) {
      const size = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.byteLength, capture.artifactBytes - at),
        at,
      );
      if (size < 1)
        throw new EngineError(
          "COMMAND_ARTIFACT_CHANGED",
          "The current command output source is incomplete",
        );
      hash.update(buffer.subarray(0, size));
      at += size;
    }
    const sha256 = hash.digest("hex");
    if (!current() || sha256 !== capture.hash.copy().digest("hex"))
      throw new EngineError(
        "COMMAND_ARTIFACT_CHANGED",
        "The current command output bytes differ from the actual producer writes",
      );
    return validateCommandArtifactDescriptor({
      version: 1,
      path: capture.path,
      sha256,
      device: capture.device,
      inode: capture.inode,
      size: capture.closedStat.size,
      mtimeNs: capture.closedStat.mtimeNs,
      observedBytes: capture.totalBytes,
      artifactBytes: capture.artifactBytes,
      truncated: capture.totalBytes > capture.artifactBytes,
    });
  } finally {
    closeSync(fd);
  }
}

/** A complete UTF-8 prefix, with replacement characters for invalid output. */
export function modelPrefix(
  capture: Capture,
  budget: number,
): { text: string; sourceBytes: number } {
  const bytes = Buffer.concat(capture.buffers, capture.capturedBytes);
  if (budget <= 0) return { text: "", sourceBytes: 0 };
  let end = 0;
  let renderedBytes = 0;
  while (end < bytes.byteLength) {
    const first = bytes[end]!;
    let length =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    let valid = length > 0 && end + length <= bytes.byteLength;
    for (let index = 1; valid && index < length; index++)
      valid = (bytes[end + index]! & 0xc0) === 0x80;
    const second = bytes[end + 1];
    if (
      (first === 0xe0 && second! < 0xa0) ||
      (first === 0xed && second! >= 0xa0) ||
      (first === 0xf0 && second! < 0x90) ||
      (first === 0xf4 && second! > 0x8f)
    )
      valid = false;
    // Invalid bytes render as U+FFFD; counting each is conservative when the decoder merges a malformed sequence.
    const renderedLength = valid ? length : 3;
    if (renderedBytes + renderedLength > budget) break;
    if (!valid) length = 1;
    renderedBytes += renderedLength;
    end += length;
  }
  const text = bytes.subarray(0, end).toString("utf8");
  return { text, sourceBytes: end };
}

export function outputData(
  capture: Capture,
  text: string,
  sourceBytes: number,
): OutputData {
  return {
    text,
    totalBytes: capture.totalBytes,
    observedBytes: capture.totalBytes,
    capturedBytes: capture.capturedBytes,
    captureTruncatedBytes: capture.totalBytes - capture.capturedBytes,
    modelBytes: Buffer.byteLength(text),
    modelSourceBytes: sourceBytes,
    modelTruncatedBytes: capture.totalBytes - sourceBytes,
    artifactBytes: capture.artifactBytes,
    artifactTruncatedBytes: capture.totalBytes - capture.artifactBytes,
  };
}
