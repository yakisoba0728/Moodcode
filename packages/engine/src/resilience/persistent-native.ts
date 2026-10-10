import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MoodcodeEngine } from "../engine.js";
import {
  ownedCommandJobKind,
  type OwnedCommandJobSource,
} from "../jobs/owned-command-records.js";
import { hash } from "./fixture.js";

const TABLES = [
  "runs",
  "messages",
  "tools",
  "approvals",
  "checkpoints",
  "session_inputs",
  "session_turns",
  "provider_attempts",
  "message_parts",
  "attempt_cleanup",
  "session_documents",
  "session_events",
] as const;
export function persistentNativeCounts(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      TABLES.map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
      ]),
    );
  } finally {
    db.close();
  }
}
export function persistentNativeDigest(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const digest = createHash("sha256");
    for (const table of TABLES) {
      digest.update(table + "\n");
      for (const row of db
        .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
        .iterate())
        digest.update(String(row.data) + "\n");
    }
    const integrity = db.prepare("PRAGMA integrity_check").all();
    assert.deepEqual(
      integrity.map((row) => row.integrity_check),
      ["ok"],
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    return {
      counts: persistentNativeCounts(dbPath),
      recordsSha256: digest.digest("hex"),
      integrity: "ok" as const,
      foreignKeyViolations: 0,
    };
  } finally {
    db.close();
  }
}
export function persistentRecoveryEvents(
  dbPath: string,
  beforeEventCount: number,
) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT data FROM session_events ORDER BY rowid LIMIT 9 OFFSET ?",
      )
      .all(beforeEventCount)
      .map(
        (row) =>
          JSON.parse(String(row.data)) as {
            type: string;
            sessionId: string;
            runId?: string;
            turnId?: string;
            attemptId?: string;
            payload: Record<string, unknown>;
          },
      );
  } finally {
    db.close();
  }
}
export function assertPersistentRecoveryEvidence(
  engine: MoodcodeEngine,
  source: OwnedCommandJobSource,
  proposalPartId: string,
  events: ReturnType<typeof persistentRecoveryEvents>,
  jobId: string,
) {
  assert.equal(events.length, 5);
  for (const event of events) assert.equal(event.sessionId, source.sessionId);
  for (const event of events.slice(0, 3)) {
    assert.equal(event.runId, source.runId);
    assert.equal(event.turnId, source.turnId);
  }
  assert.equal(events[0]!.attemptId, source.attemptId);
  const frontier = events[0]!.payload.frontier as Record<string, unknown>;
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "toolCallId",
  ] as const)
    assert.equal(frontier[key], source[key]);
  assert.equal(frontier.proposalPartId, proposalPartId);
  assert.equal(frontier.toolName, "run_command");
  assert.equal(frontier.originalToolState, "running");
  assert.equal(frontier.effectOutcome, "unknown");
  assert.equal(frontier.callbackEntry, "unverified");
  const part = engine.store
    .listParts(source.turnId)
    .find((value) => value.id === proposalPartId)!;
  assert.ok(part && part.type === "tool");
  assert.equal(part.toolCallId, source.toolCallId);
  assert.equal(part.state, "interrupted");
  assert.deepEqual(events[1]!.payload.part, part);
  const turn = engine.store.getTurn(source.turnId);
  assert.equal(turn.state, "uncertain");
  assert.equal(turn.uncertainty?.kind, "tool_effect");
  assert.equal(turn.uncertainty?.requiresRecovery, true);
  assert.deepEqual(events[2]!.payload.turn, turn);
  const control = engine.store.getSessionControl(source.sessionId);
  assert.equal(control.paused, true);
  assert.equal(control.reason, "recovery_required");
  assert.deepEqual(events[3]!.payload.control, control);
  const kind = ownedCommandJobKind(jobId),
    document = engine.store.getSessionDocument(source.sessionId, kind)!;
  assert.ok(document);
  assert.equal(events[4]!.payload.kind, kind);
  assert.equal(events[4]!.payload.revision, document.revision);
  assert.equal(events[4]!.payload.sha256, hash(document.data));
}
export function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4_194_304,
  });
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid, state, command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        state: state!,
        command: command!,
      };
    });
}
function descendants(pid: number) {
  const rows = processRows(),
    ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
  }
  return rows.filter(
    (row) =>
      row.pid !== pid &&
      ids.has(row.pid) &&
      !(row.ppid === pid && /(?:^|\/)ps$/.test(row.command)),
  );
}
function descriptorCount(pid = process.pid): {
  count: number;
  source: string;
} {
  if (process.platform === "linux")
    return {
      count: readdirSync(`/proc/${pid}/fd`).length,
      source: "/proc/pid/fd",
    };
  const output = execFileSync("lsof", ["-nP", "-p", String(pid), "-Ff"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4_194_304,
  });
  return {
    count: output.split("\n").filter((line) => /^f\d+(?:[a-z]+)?$/i.test(line))
      .length,
    source: "lsof-numeric-file-descriptors",
  };
}
function artifactMeasure(root: string) {
  const digest = createHash("sha256"),
    content = createHash("sha256");
  let files = 0,
    bytes = 0;
  function walk(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert.ok(
          entry.isFile(),
          "Private artifact tree contains an unexpected link",
        );
        const size = statSync(path).size;
        files++;
        bytes += size;
        digest.update(path.slice(root.length) + ":" + size + "\n");
        content.update(path.slice(root.length) + "\n");
        content.update(
          createHash("sha256").update(readFileSync(path)).digest("hex") + "\n",
        );
      }
    }
  }
  walk(root);
  return {
    files,
    bytes,
    pathsAndSizesSha256: digest.digest("hex"),
    contentSha256: content.digest("hex"),
  };
}
export function samplePersistentResources(
  dbPath: string,
  artifactDir: string,
  phase: string,
  elapsedMs: number,
  engineInstance: number,
  cycles: number,
) {
  const memory = process.memoryUsage(),
    children = descendants(process.pid);
  const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);
  return {
    phase,
    elapsedMs: Math.round(elapsedMs),
    engineInstance,
    cycles,
    pid: process.pid,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    descriptors: descriptorCount(),
    processes: {
      descendants: children.length,
      liveDescendants: children.filter((row) => !row.state.startsWith("Z"))
        .length,
      pids: children.slice(0, 32).map((row) => row.pid),
      truncated: children.length > 32,
      source: "ps-pid-ppid-pgid-stat",
    },
    sqlite: {
      primaryBytes: size(dbPath),
      walBytes: size(dbPath + "-wal"),
      shmBytes: size(dbPath + "-shm"),
      effectsBytes: size(dbPath + ".effects.sqlite"),
      counts: persistentNativeCounts(dbPath),
    },
    artifacts: artifactMeasure(artifactDir),
  };
}
export type PersistentResourceSample = ReturnType<
  typeof samplePersistentResources
>;
