import { hostCommandSourceSha } from "./host-command-result.js";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import { sameCanonical } from "../shared/canonical.js";
import { jobJson } from "./validation.js";
import type { EngineJobProducer } from "./engine-producer.js";
import type {
  CommandJobReadSelection,
  CommandReadSource,
  CommandReadEvent,
  CommandReadSnapshot,
} from "./command-model-tools.js";
function fail(): never {
  throw new EngineError(
    "COMMAND_JOB_SOURCE_UNAVAILABLE",
    "The actual retained command source is unavailable, uncertain or imported",
  );
}
type CommandReadRuntime = Pick<
  MoodcodeEngine,
  | "readTerminalJobSource"
  | "getCommandJob"
  | "getOwnedCommandJob"
  | "captureOwnedCommandJobOutput"
  | "readOwnedCommandJobOutput"
  | "releaseOwnedCommandJobHandle"
  | "getHostCommand"
  | "captureHostCommandOutput"
  | "readHostCommandOutput"
  | "readHostCommandArtifacts"
  | "releaseHostCommandHandle"
>;
/** All routes begin with current private producers; historical DTOs cannot supply source authority. */
export function captureCommandReadSource(
  engine: CommandReadRuntime,
  terminal: EngineJobProducer,
  selection: CommandJobReadSelection,
  workspaceId: string,
): CommandReadSource {
  if (selection.kind === "user-terminal") {
    if (!selection.source) fail();
    const original = selection.source,
      proof = engine.readTerminalJobSource(original),
      job = engine.getCommandJob(workspaceId, selection.jobId);
    if (
      !job ||
      job.sourceSha256 !== proof.sha256 ||
      job.workspaceId !== workspaceId ||
      ["uncertain", "paused-import"].includes(job.state)
    )
      fail();
    const current = () => {
      const p = engine.readTerminalJobSource(original),
        j = engine.getCommandJob(workspaceId, selection.jobId);
      if (
        !j ||
        !sameCanonical(p, proof) ||
        j.sourceSha256 !== proof.sha256 ||
        ["uncertain", "paused-import"].includes(j.state)
      )
        fail();
      return j;
    };
    return {
      workspaceId,
      sessionId: proof.sessionId,
      kind: selection.kind,
      jobId: selection.jobId,
      sourceSha256: proof.sha256,
      assertCurrent: () => {
        current();
      },
      summary: () => {
        const j = current();
        return jobJson({
          jobId: j.jobId,
          sourceKind: selection.kind,
          state: j.state,
          sourceSha256: proof.sha256,
          cleanupConfirmed: j.outcome?.cleanupConfirmed ?? null,
        }) as JsonObject;
      },
      capture: () => {
        current();
        const handle = terminal.captureModelSnapshot(original, selection.jobId);
        try {
          const s = terminal.readModelSnapshot(original, handle);
          return {
            original: handle,
            snapshot: {
              sourceSha256: proof.sha256,
              throughSeq: s.throughSeq,
              oldestSeq: s.oldestSeq,
              observedBytes: s.observedBytes,
              output: s.output.map((e) => ({
                seq: e.seq,
                stream: "pty",
                data: e.data,
                bytes: e.bytes,
              })),
              nativeSnapshotSha256: s.sha256,
            },
          };
        } catch (e) {
          terminal.releaseModelSnapshot(original, handle);
          throw e;
        }
      },
      release: (handle) => {
        if (handle) terminal.releaseModelSnapshot(original, handle);
      },
    };
  }
  if (selection.source !== undefined) fail();
  if (selection.kind === "run-command") {
    const job = engine.getOwnedCommandJob(workspaceId, selection.jobId);
    if (!job || ["uncertain", "paused-import"].includes(job.state)) fail();
    const witness = engine.captureOwnedCommandJobOutput({
      workspaceId,
      jobId: selection.jobId,
    });
    try {
      const first = engine.readOwnedCommandJobOutput(witness, {
        maxBytes: 16384,
      });
      if (first.sourceSha256 !== job.source.sha256) fail();
    } catch (e) {
      engine.releaseOwnedCommandJobHandle(witness);
      throw e;
    }
    const current = () => {
      const j = engine.getOwnedCommandJob(workspaceId, selection.jobId);
      if (
        !j ||
        !sameCanonical(j.source, job.source) ||
        ["uncertain", "paused-import"].includes(j.state)
      )
        fail();
      engine.readOwnedCommandJobOutput(witness, { maxBytes: 16384 });
      return j;
    };
    return {
      workspaceId,
      sessionId: job.source.sessionId,
      kind: selection.kind,
      jobId: selection.jobId,
      sourceSha256: job.source.sha256,
      assertCurrent: () => {
        current();
      },
      summary: () => {
        const j = current();
        return jobJson({
          jobId: j.jobId,
          sourceKind: selection.kind,
          state: j.state,
          sourceSha256: j.source.sha256,
          cleanupConfirmed: j.completion?.outcome.cleanupConfirmed ?? null,
        }) as JsonObject;
      },
      capture: () => {
        current();
        const original = engine.captureOwnedCommandJobOutput({
          workspaceId,
          jobId: selection.jobId,
        });
        try {
          const output: CommandReadEvent[] = [];
          let afterSeq = 0,
            page = engine.readOwnedCommandJobOutput(original, {
              maxBytes: 65536,
            }),
            count = 0;
          const sha = page.snapshotSha256;
          while (true) {
            if (++count > 64 || page.snapshotSha256 !== sha) fail();
            output.push(...page.output);
            if (!page.hasMore) break;
            if (page.nextAfterSeq <= afterSeq) fail();
            afterSeq = page.nextAfterSeq;
            page = engine.readOwnedCommandJobOutput(original, {
              afterSeq,
              maxBytes: 65536,
            });
          }
          const snapshot: CommandReadSnapshot = {
            sourceSha256: job.source.sha256,
            throughSeq: page.throughSeq,
            oldestSeq: page.oldestSeq,
            observedBytes: page.observedBytes,
            output,
            nativeSnapshotSha256: sha,
          };
          return { original, snapshot };
        } catch (e) {
          engine.releaseOwnedCommandJobHandle(original);
          throw e;
        }
      },
      release: (original) =>
        engine.releaseOwnedCommandJobHandle(original ?? witness),
    };
  }
  if (selection.kind !== "host-command") fail();
  const job = engine.getHostCommand(workspaceId, selection.jobId);
  if (!job || ["uncertain", "paused-import", "denied"].includes(job.state))
    fail();
  const witness = engine.captureHostCommandOutput({
    workspaceId,
    jobId: selection.jobId,
  });
  let sourceSha256: string;
  try {
    engine.readHostCommandOutput(witness);
    sourceSha256 = hostCommandSourceSha(job);
  } catch (e) {
    engine.releaseHostCommandHandle(witness);
    throw e;
  }
  const current = () => {
    const j = engine.getHostCommand(workspaceId, selection.jobId);
    if (
      !j ||
      !sameCanonical(j.owner, job.owner) ||
      !sameCanonical(j.preview, job.preview) ||
      j.pid !== job.pid ||
      ["uncertain", "paused-import", "denied"].includes(j.state)
    )
      fail();
    const page = engine.readHostCommandOutput(witness);
    if (page.jobId !== job.jobId) fail();
    if (j.completion)
      engine.readHostCommandArtifacts({ workspaceId, jobId: selection.jobId });
    return j;
  };
  return {
    workspaceId,
    sessionId: job.sessionId,
    kind: selection.kind,
    jobId: selection.jobId,
    sourceSha256,
    assertCurrent: () => {
      current();
    },
    summary: () => {
      const j = current();
      return jobJson({
        jobId: j.jobId,
        sourceKind: selection.kind,
        state: j.state,
        sourceSha256,
        cleanupConfirmed: j.completion?.outcome.cleanupConfirmed ?? null,
      }) as JsonObject;
    },
    capture: () => {
      const observed = current();
      const original = engine.captureHostCommandOutput({
        workspaceId,
        jobId: selection.jobId,
      });
      try {
        const output: CommandReadEvent[] = [];
        let page = engine.readHostCommandOutput(original),
          count = 0,
          oldestSeq = page.gap ? Number(page.gap.throughSeq) + 1 : 1;
        const sha = page.snapshotSha256;
        while (true) {
          if (++count > 128 || page.snapshotSha256 !== sha) fail();
          for (const f of page.fragments) {
            const previous = output.at(-1);
            if (previous?.seq === f.seq) {
              if (
                previous.stream !== f.stream ||
                previous.bytes !== f.byteOffset
              )
                fail();
              output[output.length - 1] = {
                ...previous,
                data: previous.data + f.data,
                bytes: previous.bytes + f.bytes,
              };
            } else {
              if (f.byteOffset !== 0) fail();
              output.push({
                seq: f.seq,
                stream: f.stream,
                data: f.data,
                bytes: f.bytes,
              });
            }
          }
          if (!page.hasMore) break;
          const next = engine.readHostCommandOutput(original, {
            cursor: page.nextCursor,
          });
          if (sameCanonical(next.nextCursor, page.nextCursor)) fail();
          page = next;
        }
        return {
          original,
          snapshot: {
            sourceSha256,
            throughSeq: page.nextCursor.eventSeq - 1,
            oldestSeq,
            observedBytes: observed.outputObservedBytes,
            output,
            nativeSnapshotSha256: sha,
          },
        };
      } catch (e) {
        engine.releaseHostCommandHandle(original);
        throw e;
      }
    },
    release: (original) => engine.releaseHostCommandHandle(original ?? witness),
  };
}
