import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  type RunConfig,
  type Workspace,
  type Session,
  type RunReceipt,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { createEngine, type EngineOptions } from "../../engine.js";
import type { ProviderAdapter, TurnRequest } from "../../ports.js";
const evidenceTables = [
  "runs",
  "session_turns",
  "provider_attempts",
  "attempt_cleanup",
  "tools",
  "approvals",
  "checkpoints",
  "message_parts",
  "session_documents",
  "session_events",
] as const;
function nativeEvidence(
  dbPath: string,
): Record<string, Record<string, unknown>[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let bytes = 0;
  try {
    return Object.fromEntries(
      evidenceTables.map((table) => {
        const rows = db
          .prepare(`SELECT data FROM ${table} ORDER BY rowid LIMIT 1025`)
          .all();
        assert.ok(
          rows.length <= 1024,
          "Fixture native evidence row ceiling exceeded",
        );
        return [
          table,
          rows.map((row) => {
            const raw = String(row.data);
            bytes += Buffer.byteLength(raw);
            assert.ok(
              bytes <= 8_388_608,
              "Fixture native evidence byte ceiling exceeded",
            );
            return JSON.parse(raw) as Record<string, unknown>;
          }),
        ];
      }),
    );
  } finally {
    db.close();
  }
}
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function until(
  p: () => boolean,
  message = "fixture wait",
  ms = 20000,
) {
  const end = Date.now() + ms;
  while (!p()) {
    assert.ok(Date.now() < end, message);
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const literal = (value: any) => ({ op: "literal", value });
export const variable = (name: string) => ({ op: "var", name });
export const program = (statements: any[]) =>
  JSON.stringify({ version: 1, statements });
export const call = (id: string, tool: string, input: any, result = id) => ({
  op: "call",
  id,
  tool,
  input: literal(input),
  result,
});
export async function fixture(
  t: TestContext,
  extra: Partial<EngineOptions> = {},
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-code-mode-"))),
    root = join(base, "repo"),
    dbPath = join(base, "db.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  writeFileSync(join(root, "seed"), "actual seed");
  execFileSync("git", ["init", "-q", "--template=", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "seed",
  ]);
  let source = program([{ op: "return", value: literal(7) }]);
  const seen = new Set<string>(),
    requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "code-mode-fixture",
    async *streamTurn(request) {
      requests.push(request);
      if (!seen.has(request.runId)) {
        seen.add(request.runId);
        yield {
          type: "tool.call",
          call: {
            id: "original-code",
            name: "execute_code",
            input: {
              source,
              allocation: {
                maxSteps: 512,
                maxNestedCalls: 8,
                maxResultBytes: 8192,
                maxDurationMs: 7000,
              },
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text.delta", delta: "actual code result observed" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 2,
      maxToolCalls: 10,
      maxOutputBytes: 131072,
      maxDurationMs: 20000,
      toolTimeoutMs: 10000,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 2,
      maxProviderAttempts: 1,
      maxToolCallsPerTurn: 10,
    }),
  };
  const options: EngineOptions = {
    dbPath,
    artifactDir,
    providers: [provider],
    defaults: config,
    codeMode: true,
    ...extra,
  };
  let engine = createEngine(options);
  const engines = new Set([engine]);
  t.after(async () => {
    let retained = false,
      closeError: unknown;
    const save = (phase: string) => {
      const native = nativeEvidence(dbPath);
      writeFileSync(
        join(base, `${phase}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            kind: "code-mode-fixture-native-evidence",
            phase,
            noLive: true,
            retainedEvidencePath: base,
            dbPath,
            artifactDir,
            source: {
              path: fileURLToPath(import.meta.url),
              sha256: digest(readFileSync(fileURLToPath(import.meta.url))),
            },
            native,
            nativeRecordsSha256: digest(JSON.stringify(native)),
            requests: requests.map((request) => ({
              runId: request.runId,
              turnIndex: request.turnIndex,
              attemptId: request.attemptId,
            })),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    };
    try {
      retained = Object.entries(nativeEvidence(dbPath)).some(
        ([table, records]) =>
          table !== "session_events" &&
          records.some(
            (record) =>
              ["failed", "uncertain", "interrupted"].includes(
                String(record.state),
              ) || record.cleanupConfirmed === false,
          ),
      );
      if (retained) save("before-close");
    } catch (error) {
      retained = true;
      t.diagnostic(`Native evidence capture failed: ${String(error)}`);
    }
    for (const e of engines) {
      try {
        await e.close();
      } catch (error) {
        retained = true;
        closeError ??= error;
      }
    }
    if (retained) {
      try {
        save("after-close");
      } catch (error) {
        t.diagnostic(`Native evidence capture failed: ${String(error)}`);
      }
      t.diagnostic(`Retained native code-mode fixture: ${base}`);
    } else rmSync(base, { force: true, recursive: true });
    if (closeError) throw closeError;
  });
  const dispatch = async <T>(type: string, payload: any) => {
    const r = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type,
      payload,
    });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return r.result as unknown as T;
  };
  const workspace = await dispatch<Workspace>("workspace.open", { path: root }),
    session = await dispatch<Session>("session.create", {
      workspaceId: workspace.id,
    });
  const grant = async () => {
    await engine.registerCodeModeHost();
    const original = engine.previewCodeModeGrant({
      workspaceId: workspace.id,
      sessionId: session.id,
      config,
    });
    const proof = engine.readCodeModeGrant(original);
    engine.approveCodeModeGrant({
      preview: original,
      fingerprint: proof.sha256,
      approved: true,
    });
    return original;
  };
  const submit = async (text = source) => {
    source = text;
    return dispatch<RunReceipt>("run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "Execute real restricted code",
      config,
    });
  };
  const approval = async (r: RunReceipt) => {
    await until(() => {
      const run = engine.store.getRun(r.runId);
      if (
        ["failed", "interrupted", "cancelled", "completed"].includes(run.state)
      )
        throw new Error(JSON.stringify(run));
      return engine.store
        .getSnapshot(session.id)
        .approvals.some((a) => a.runId === r.runId && a.status === "pending");
    }, "actual native approval");
    return engine.store
      .getSnapshot(session.id)
      .approvals.find((a) => a.runId === r.runId && a.status === "pending")!;
  };
  const allow = async (r: RunReceipt) => {
    const a = await approval(r);
    engine.approvals.decide(a.id, "allow", a.fingerprint);
    return a;
  };
  const wait = async (r: RunReceipt) => {
    await until(
      () =>
        ["completed", "failed", "interrupted", "cancelled"].includes(
          engine.store.getRun(r.runId).state,
        ),
      "actual Run terminal",
    );
    return engine.store.getRun(r.runId);
  };
  return {
    base,
    root,
    dbPath,
    artifactDir,
    workspace,
    session,
    config,
    options,
    requests,
    get engine() {
      return engine;
    },
    grant,
    submit,
    approval,
    allow,
    wait,
    dispatch,
    reopen: async (extra: Partial<EngineOptions> = {}) => {
      await engine.close();
      engine = createEngine({ ...options, ...extra });
      engines.add(engine);
      return engine;
    },
  };
}
