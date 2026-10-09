import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeFixtureData } from "../../test-fixtures/native-data.js";

const tables = [
  "runs",
  "session_turns",
  "provider_attempts",
  "attempt_cleanup",
  "tools",
  "approvals",
  "checkpoints",
  "session_documents",
  "session_events",
] as const;
const detail = (error: unknown) => String(error).slice(0, 2048);

// Joining the original child and closing a reopened engine are observations.
// Neither supplies the crashed owner's Original cleanup authority.
export async function retainCrashFixture(input: {
  base?: string;
  dbPath?: string;
  boundary: string;
  stderr: string;
  settleChild: () => Promise<void>;
  closeEngine?: () => Promise<void>;
  diagnostic: (message: string) => void;
}): Promise<void> {
  const failures: unknown[] = [],
    diagnostic = (message: string) => {
      try {
        input.diagnostic(message.slice(0, 4096));
      } catch {
        // Diagnostic failure cannot replace a body or owned close failure.
      }
    };
  let childJoined = false,
    engineClosed: boolean | null = null;
  try {
    await input.settleChild();
    childJoined = true;
  } catch (error) {
    failures.push(error);
  }
  if (input.closeEngine) {
    try {
      await input.closeEngine();
      engineClosed = true;
    } catch (error) {
      engineClosed = false;
      failures.push(error);
    }
  }
  if (input.base) {
    let native: ReturnType<typeof nativeFixtureData> | undefined,
      nativeError: string | undefined;
    if (input.dbPath) {
      try {
        native = nativeFixtureData(input.dbPath, tables);
      } catch (error) {
        nativeError = detail(error);
        diagnostic(`Crash native observation failed: ${nativeError}`);
      }
    }
    try {
      await writeFile(
        join(input.base, "crash-retention.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            boundary: input.boundary.slice(0, 256),
            retainedEvidencePath: input.base,
            cleanupAuthority: "unavailable-after-owner-crash",
            observations: { childJoined, engineClosed },
            stderr: input.stderr.slice(-8192),
            closeFailures: failures.map(detail),
            ...(native
              ? {
                  native,
                  nativeRecordsSha256: createHash("sha256")
                    .update(JSON.stringify(native))
                    .digest("hex"),
                }
              : {}),
            ...(nativeError ? { nativeError } : {}),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      diagnostic(`Crash retention report failed: ${detail(error)}`);
    }
    diagnostic(`Retained original crash fixture: ${input.base}`);
  } else
    diagnostic(
      `Crash boundary supplied no evidence path: ${input.stderr.slice(-8192)}`,
    );
  for (const error of failures.slice(1))
    diagnostic(`Additional owned close failure: ${detail(error)}`);
  if (failures.length) throw failures[0];
}
