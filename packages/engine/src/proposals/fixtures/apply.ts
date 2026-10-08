import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import type { ProviderAdapter } from "../../ports.js";
import type { AppendProposalRevisionResult } from "../types.js";
import type {
  ApplyProposalResult,
  ProposalApplyPreview,
} from "../apply-service.js";
import type {
  ProposalApplyHistory,
  ProposalApplyRecoveryPreview,
  ProposalApplyRecoveryDecision,
} from "../apply-types.js";

export const BEFORE =
  "Original first target body, independently captured user content. 한글😀\n";
export const AFTER = "Approved first postimage. 한글😀\n";
export const SECOND_BEFORE =
  "Second original is deliberately longer than the desired prefix and must be accounted exactly.\n";
export const SECOND_AFTER = "short second\n";
export const CREATED = "Exact newly created nested target.\n";
export const REMOVED = "Original removable file.\n";
export const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export type Engine = ReturnType<typeof createEngine>;
export function api<T>(engine: Engine, method: string, ...args: unknown[]): T {
  const implementation = Reflect.get(engine, method);
  assert.equal(
    typeof implementation,
    "function",
    `Actual Engine must expose ${method}`,
  );
  return Reflect.apply(implementation, engine, args) as T;
}
export function failure(...codes: string[]) {
  return (error: unknown) => {
    assert.ok(error instanceof EngineError, String(error));
    if (codes.length)
      assert.ok(
        codes.includes(error.code),
        `Expected ${codes.join("|")}, observed ${error.code}`,
      );
    return true;
  };
}
export function readDb<T>(
  dbPath: string,
  operation: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
export function nativeRows(dbPath: string, tables: readonly string[]) {
  return readDb(dbPath, (db) =>
    Object.fromEntries(
      tables.map((table) => {
        assert.match(table, /^[a-z_]+$/);
        return [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()];
      }),
    ),
  );
}
export const APPLY_TABLES = [
  "proposal_apply_owners",
  "proposal_apply_checkpoints",
  "proposal_effect_blobs",
  "proposal_apply_receipts",
  "proposal_apply_recovery_decisions",
  "proposal_apply_execution_guards",
] as const;
export async function applyFixture(t: TestContext, enabled = true) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-apply-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "first.ts"), BEFORE);
  writeFileSync(join(root, "second.ts"), SECOND_BEFORE);
  writeFileSync(join(root, "remove.txt"), REMOVED);
  writeFileSync(join(root, "untouched.txt"), "Unrelated user bytes.\n");
  let providerCalls = 0;
  const provider: ProviderAdapter = {
    id: "proposal-apply-zero-provider",
    async *streamTurn() {
      providerCalls++;
      throw new Error("Host proposal apply must not call a coding producer");
    },
  };
  const options: EngineOptions = {
    dbPath,
    artifactDir,
    providers: [provider],
    tools: [],
    proposals: true,
    proposalApply: enabled,
  };
  const engine = createEngine(options),
    engines = new Set([engine]);
  let allowedUncertainClose = false;
  t.after(async () => {
    try {
      for (const current of engines) {
        try {
          await current.close();
        } catch (error) {
          if (!allowedUncertainClose) throw error;
          failure("CLEANUP_UNCERTAIN", "PATCH_CLEANUP_UNCERTAIN")(error);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const opened = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "workspace.open",
    payload: { path: root },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  const workspace = opened.result as unknown as Workspace;
  const changes: {
    path: string;
    expectedHash: string | null;
    content: string | null;
  }[] = [
    { path: "first.ts", expectedHash: sha(BEFORE), content: AFTER },
    {
      path: "second.ts",
      expectedHash: sha(SECOND_BEFORE),
      content: SECOND_AFTER,
    },
    { path: "new/nested.ts", expectedHash: null, content: CREATED },
    { path: "remove.txt", expectedHash: sha(REMOVED), content: null },
  ];
  function stage(
    input: {
      proposalId?: string;
      requestId?: string;
      expectedRevision?: number;
      changes?: typeof changes;
    } = {},
    current = engine,
  ) {
    return api<Promise<AppendProposalRevisionResult>>(
      current,
      "createProposalSet",
      {
        workspaceId: workspace.id,
        requestId: input.requestId ?? randomUUID(),
        proposalId: input.proposalId ?? "actual-apply-set",
        expectedRevision: input.expectedRevision ?? 0,
        changes: input.changes ?? changes,
      },
    );
  }
  function preview(
    proposalId = "actual-apply-set",
    current = engine,
    signal?: AbortSignal,
  ) {
    return api<Promise<ProposalApplyPreview>>(current, "previewProposalApply", {
      workspaceId: workspace.id,
      proposalId,
      ...(signal ? { signal } : {}),
    });
  }
  function apply(
    preview: ProposalApplyPreview,
    requestId: string = randomUUID(),
    current = engine,
    signal?: AbortSignal,
  ) {
    return api<Promise<ApplyProposalResult>>(current, "applyProposal", {
      workspaceId: workspace.id,
      requestId,
      approved: true,
      preview,
      ...(signal ? { signal } : {}),
    });
  }
  function history(requestId: string, current = engine) {
    return api<ProposalApplyHistory | undefined>(
      current,
      "getProposalApplyRequest",
      workspace.id,
      requestId,
    );
  }
  function userBytes() {
    return Object.fromEntries(
      [
        "first.ts",
        "second.ts",
        "new/nested.ts",
        "remove.txt",
        "untouched.txt",
      ].map((path) => [
        path,
        existsSync(join(root, path))
          ? readFileSync(join(root, path), "utf8")
          : null,
      ]),
    );
  }
  function assertNoCoding() {
    assert.equal(providerCalls, 0);
    readDb(dbPath, (db) => {
      for (const table of [
        "sessions",
        "runs",
        "messages",
        "tools",
        "approvals",
        "checkpoints",
        "session_turns",
        "provider_attempts",
        "summary_attempts",
        "knowledge_generations",
      ])
        assert.equal(
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          0,
          table,
        );
    });
  }
  function reopen(overrides: Partial<EngineOptions> = {}) {
    const next = createEngine({ ...options, ...overrides });
    engines.add(next);
    return next;
  }
  function recovery(current = engine) {
    return api<ProposalApplyRecoveryPreview>(
      current,
      "previewProposalApplyRecovery",
      workspace.id,
    );
  }
  function acknowledge(
    preview: ProposalApplyRecoveryPreview,
    current = engine,
    requestId: string = randomUUID(),
  ) {
    return api<Promise<ProposalApplyRecoveryDecision>>(
      current,
      "acknowledgeProposalApplyRecovery",
      {
        workspaceId: workspace.id,
        requestId,
        preview,
        reason: "Explicit original frontier acknowledgment; no retry.",
      },
    );
  }
  function resume(
    preview: ProposalApplyRecoveryPreview,
    current = engine,
    requestId: string = randomUUID(),
  ) {
    return api<Promise<ProposalApplyRecoveryDecision>>(
      current,
      "resumeProposalApplyRecovery",
      {
        workspaceId: workspace.id,
        requestId,
        preview,
        reason: "Explicit separate resume; original effects retained.",
      },
    );
  }
  return {
    base,
    root,
    dbPath,
    artifactDir,
    engine,
    engines,
    options,
    workspace,
    changes,
    stage,
    preview,
    apply,
    history,
    userBytes,
    assertNoCoding,
    reopen,
    recovery,
    acknowledge,
    resume,
    allowUncertainClose() {
      allowedUncertainClose = true;
    },
  };
}
