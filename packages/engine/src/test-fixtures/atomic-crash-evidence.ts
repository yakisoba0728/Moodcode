import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";

/** Publish captured evidence; the caller owns native reads and crash signals. */
export function publishCrashEvidence(
  readyPath: string,
  evidence: object,
): void {
  const stagingPath = `${readyPath}.tmp`;
  const payload = Buffer.from(JSON.stringify(evidence));
  const fd = openSync(stagingPath, "wx", 0o600);
  try {
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  renameSync(stagingPath, readyPath);
}
