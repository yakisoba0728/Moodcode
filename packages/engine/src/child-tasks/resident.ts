import {
  teamObject,
  teamId,
  teamInteger,
  teamSha,
  teamDate,
} from "../teams/validation.js";
import { randomUUID } from "node:crypto";
import {
  EngineError,
  type JsonObject,
  type Run,
  type RunConfig,
  type RunState,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { ChildBudget, ChildOutcome, ChildTaskRecord } from "./index.js";
import {
  CHILD_BUDGET_KEYS,
  CHILD_BUDGET_MAX,
  CHILD_OUTCOME_STATES,
  CHILD_USAGE_KEYS,
} from "./journal.js";
import {
  knowledgeHash,
  immutableKnowledgeJson,
} from "../knowledge/validation.js";
import { reseal } from "../shared/canonical.js";

export const RESIDENT_KIND_PREFIX = "resident.child.";
export interface ResidentRunEvidence {
  runId: string;
  inputId: string | null;
  inputSha256: string | null;
  configSha256: string;
  promptSha256: string;
  state: "running" | "completed" | "failed" | "cancelled" | "uncertain";
  usage: Omit<ChildBudget, "durationMs"> | null;
  outcomeSha256: string | null;
}
export interface ResidentChildRecord {
  version: 1;
  taskId: string;
  rootSessionId: string;
  parentRunId: string;
  initialRunId: string;
  childSessionId: string;
  storageSha256: string;
  runtimeEpoch: string;
  revision: number;
  state: "running" | "idle" | "closed" | "uncertain" | "paused-import";
  allocation: ChildBudget;
  idleTimeoutMs: number;
  expiresAt: string;
  sourceConfigSha256: string;
  profileSha256: string;
  catalogueSha256: string;
  runs: ResidentRunEvidence[];
  sha256: string;
}
export function validateResidentRecord(value: unknown): ResidentChildRecord {
  const r = immutableKnowledgeJson(value) as unknown as ResidentChildRecord;
  teamObject(r, [
    "version",
    "taskId",
    "rootSessionId",
    "parentRunId",
    "initialRunId",
    "childSessionId",
    "storageSha256",
    "runtimeEpoch",
    "revision",
    "state",
    "allocation",
    "idleTimeoutMs",
    "expiresAt",
    "sourceConfigSha256",
    "profileSha256",
    "catalogueSha256",
    "runs",
    "sha256",
  ]);
  for (const k of [
    "rootSessionId",
    "parentRunId",
    "initialRunId",
    "childSessionId",
    "runtimeEpoch",
  ] as const)
    teamId(r[k]);
  for (const k of [
    "storageSha256",
    "sourceConfigSha256",
    "profileSha256",
    "catalogueSha256",
    "sha256",
  ] as const)
    teamSha(r[k]);
  teamDate(r.expiresAt);
  teamObject(r.allocation, CHILD_BUDGET_KEYS);
  for (const k of CHILD_BUDGET_KEYS) {
    teamInteger(r.allocation[k], CHILD_BUDGET_MAX[k]);
    if (r.allocation[k] < 1)
      throw new EngineError(
        "RESIDENT_RECORD_INVALID",
        "Resident allocation must be positive",
      );
  }
  if (Array.isArray(r.runs))
    for (const [index, x] of r.runs.entries()) {
      teamObject(x, [
        "runId",
        "inputId",
        "inputSha256",
        "configSha256",
        "promptSha256",
        "state",
        "usage",
        "outcomeSha256",
      ]);
      teamId(x.runId);
      teamSha(x.configSha256);
      teamSha(x.promptSha256);
      if (index === 0) {
        if (x.inputId !== null || x.inputSha256 !== null)
          throw new EngineError(
            "RESIDENT_RECORD_INVALID",
            "Initial resident Run is the original host admission",
          );
      } else {
        teamId(x.inputId);
        teamSha(x.inputSha256);
      }
      if (x.usage !== null) {
        teamObject(x.usage, CHILD_USAGE_KEYS);
        for (const k of CHILD_USAGE_KEYS)
          teamInteger(x.usage[k], r.allocation[k]);
        teamSha(x.outcomeSha256);
      } else if (
        !["running", "uncertain"].includes(x.state) ||
        x.outcomeSha256 !== null
      )
        throw new EngineError(
          "RESIDENT_RECORD_INVALID",
          "Resident terminal outcome requires genuine measured usage",
        );
      if (x.state === "running" && index !== r.runs.length - 1)
        throw new EngineError(
          "RESIDENT_RECORD_INVALID",
          "Only the last resident Run may be active",
        );
    }
  if (
    ["idle", "closed"].includes(r.state) &&
    r.runs.some((x) => !CHILD_OUTCOME_STATES.includes(x.state))
  )
    throw new EngineError(
      "RESIDENT_RECORD_INVALID",
      "Settled resident cannot retain an unconfirmed Run",
    );

  if (
    !r ||
    r.version !== 1 ||
    !/^child_[a-f0-9]{32}$/.test(r.taskId) ||
    !["running", "idle", "closed", "uncertain", "paused-import"].includes(
      r.state,
    ) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !Array.isArray(r.runs) ||
    r.runs.length < 1 ||
    r.runs.length > 32 ||
    new Set(r.runs.map((x) => x.runId)).size !== r.runs.length ||
    r.runs[0]?.runId !== r.initialRunId ||
    !Number.isSafeInteger(r.idleTimeoutMs) ||
    r.idleTimeoutMs < 25 ||
    r.idleTimeoutMs > 300000 ||
    !Number.isFinite(Date.parse(r.expiresAt))
  )
    throw new EngineError(
      "RESIDENT_RECORD_INVALID",
      "Resident child history is invalid",
    );
  const { sha256, ...body } = r;
  if (knowledgeHash(body) !== sha256)
    throw new EngineError(
      "RESIDENT_RECORD_INVALID",
      "Resident history digest changed",
    );
  for (const x of r.runs)
    if (
      !["running", "completed", "failed", "cancelled", "uncertain"].includes(
        x.state,
      ) ||
      !/^[a-f0-9]{64}$/.test(x.configSha256) ||
      (x.usage &&
        CHILD_USAGE_KEYS.some(
          (k) => !Number.isSafeInteger(x.usage![k]) || x.usage![k] < 0,
        ))
    )
      throw new EngineError(
        "RESIDENT_RECORD_INVALID",
        "Resident Run evidence is invalid",
      );
  for (const k of CHILD_USAGE_KEYS)
    if (r.runs.reduce((a, x) => a + (x.usage?.[k] ?? 0), 0) > r.allocation[k])
      throw new EngineError(
        "RESIDENT_BUDGET_EXCEEDED",
        "Resident measured history exceeded its reservation",
      );
  return r;
}
type ResidentPatch = Partial<Omit<ResidentChildRecord, "sha256">>;
/** The next sealed revision, validated before any store writes it. */
export function nextResidentRecord(
  record: ResidentChildRecord,
  patch: ResidentPatch,
): ResidentChildRecord {
  return reseal(
    record,
    { ...patch, revision: record.revision + 1 },
    validateResidentRecord,
  );
}
export function uncertainResidentPatch(
  record: ResidentChildRecord,
): ResidentPatch {
  return {
    state: "uncertain",
    runs: record.runs.map((x) =>
      x.state === "running" ? { ...x, state: "uncertain" } : x,
    ),
  };
}
export function childRunConfig(
  config: RunConfig,
  budget: ChildBudget,
): RunConfig {
  const inherited = normalizeEngineBudgets(config.budgets);
  return {
    ...config,
    limits: {
      ...config.limits,
      maxTurns: budget.turns,
      maxToolCalls: budget.toolCalls,
      maxOutputBytes: budget.outputBytes,
      maxDurationMs: budget.durationMs,
      toolTimeoutMs: Math.min(config.limits.toolTimeoutMs, budget.durationMs),
    },
    budgets: {
      ...inherited,
      turnAllowance: Math.min(inherited.turnAllowance, budget.turns),
      maxToolCallsPerTurn: Math.min(
        inherited.maxToolCallsPerTurn,
        budget.toolCalls,
      ),
    },
  };
}
export const childOutcomeState = (state: RunState): ChildOutcome["state"] =>
  state === "completed"
    ? "completed"
    : state === "cancelled"
      ? "cancelled"
      : "failed";
export interface ResidentPorts {
  assertCurrent(): void;
  close(): Promise<void>;
}
/** One actual child engine, one fixed reservation, and sequential genuinely admitted Runs. */
export class ResidentChild {
  private record: ResidentChildRecord;
  private pending: Promise<void> = Promise.resolve();
  private stopping = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private idleDeadline: number | null = null;
  private resolve!: (outcome: ChildOutcome) => void;
  private reject!: (error: unknown) => void;
  readonly finished: Promise<ChildOutcome>;
  private lastContent = "";
  private mirrorRevision = 0;
  constructor(
    private readonly root: MoodcodeEngine,
    readonly engine: MoodcodeEngine,
    readonly task: ChildTaskRecord,
    readonly config: RunConfig,
    initial: Run,
    storageSha256: string,
    idleTimeoutMs: number,
    private readonly ports: ResidentPorts,
  ) {
    this.finished = new Promise((a, b) => {
      this.resolve = a;
      this.reject = b;
    });
    void this.finished.catch(() => {});
    const profile = engine.profiles.forRun(initial.sessionId, initial.config);
    const body = {
      version: 1 as const,
      taskId: task.id,
      rootSessionId: task.sessionId,
      parentRunId: task.parentRunId,
      initialRunId: initial.id,
      childSessionId: initial.sessionId,
      storageSha256,
      runtimeEpoch: randomUUID(),
      revision: 1,
      state: "running" as const,
      allocation: { ...task.budget },
      idleTimeoutMs,
      expiresAt: new Date(
        Date.parse(task.createdAt) + task.budget.durationMs,
      ).toISOString(),
      sourceConfigSha256: knowledgeHash(config),
      profileSha256: knowledgeHash(profile ?? null),
      catalogueSha256: knowledgeHash(
        engine.toolRuntime.catalogue("engine", config.mode, profile?.tools),
      ),
      runs: [
        {
          runId: initial.id,
          inputId: null,
          inputSha256: null,
          configSha256: knowledgeHash(initial.config),
          promptSha256: knowledgeHash(initial.prompt),
          state: "running" as const,
          usage: null,
          outcomeSha256: null,
        },
      ],
    };
    this.record = validateResidentRecord({
      ...body,
      sha256: knowledgeHash(body),
    });
    this.root.store.putResidentDocument(
      task.sessionId,
      RESIDENT_KIND_PREFIX + task.id,
      0,
      this.record as unknown as JsonObject,
    );
    this.engine.store.putSessionDocument(
      initial.sessionId,
      "engine.resident_child",
      0,
      this.record as unknown as JsonObject,
    );
    this.mirrorRevision = 1;
    this.watch(initial.id);
    this.deadlineTimer = setTimeout(
      () => void this.stop("cancelled"),
      Math.max(1, Date.parse(this.record.expiresAt) - Date.now()),
    );
  }
  read(): ResidentChildRecord {
    const d = this.root.store.getSessionDocument(
      this.task.sessionId,
      RESIDENT_KIND_PREFIX + this.task.id,
    );
    if (!d || knowledgeHash(d.data) !== knowledgeHash(this.record))
      throw new EngineError(
        "RESIDENT_SOURCE_STALE",
        "Resident native journal changed",
      );
    return validateResidentRecord(d.data);
  }
  private save(patch: ResidentPatch): void {
    const current = this.read();
    const next = nextResidentRecord(current, patch);
    if (patch.state !== "closed" && patch.state !== "uncertain") {
      this.engine.store.putSessionDocument(
        this.record.childSessionId,
        "engine.resident_child",
        this.mirrorRevision,
        next as unknown as JsonObject,
      );
      this.mirrorRevision++;
    }
    this.root.store.putResidentDocument(
      this.task.sessionId,
      RESIDENT_KIND_PREFIX + this.task.id,
      current.revision,
      next as unknown as JsonObject,
    );
    this.record = next;
  }
  get currentRunId(): string {
    return this.record.runs.at(-1)!.runId;
  }
  assertCurrent(): void {
    if (
      this.stopping ||
      !["running", "idle"].includes(this.read().state) ||
      Date.now() >= Date.parse(this.record.expiresAt) ||
      (this.record.state === "idle" &&
        this.idleDeadline !== null &&
        Date.now() >= this.idleDeadline)
    )
      throw new EngineError(
        "RESIDENT_CHILD_STALE",
        "Resident lifetime is unavailable",
      );
    this.ports.assertCurrent();
    const p = this.engine.profiles.forRun(
      this.record.childSessionId,
      this.config,
    );
    if (
      p &&
      this.engine.profiles.list().find((x) => x.id === p.id)?.revision !==
        p.revision
    )
      throw new EngineError(
        "RESIDENT_SOURCE_STALE",
        "Registered child profile changed",
      );
    if (
      knowledgeHash(p ?? null) !== this.record.profileSha256 ||
      knowledgeHash(
        this.engine.toolRuntime.catalogue("engine", this.config.mode, p?.tools),
      ) !== this.record.catalogueSha256
    )
      throw new EngineError(
        "RESIDENT_SOURCE_STALE",
        "Resident profile/catalogue changed",
      );
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(
      this.engine.store.getSession(this.record.childSessionId).workspaceId,
    );
  }
  assertProvider(run: Run): void {
    this.assertCurrent();
    const native = this.record.runs.at(-1)!;
    if (
      native.runId !== run.id ||
      knowledgeHash(run.config) !== native.configSha256 ||
      knowledgeHash(run.prompt) !== native.promptSha256 ||
      run.sessionId !== this.record.childSessionId
    )
      throw new EngineError(
        "RESIDENT_RUN_STALE",
        "Resident provider admission changed",
      );
  }
  private usage() {
    return this.record.runs.reduce(
      (a, x) => ({
        turns: a.turns + (x.usage?.turns ?? 0),
        toolCalls: a.toolCalls + (x.usage?.toolCalls ?? 0),
        outputBytes: a.outputBytes + (x.usage?.outputBytes ?? 0),
      }),
      { turns: 0, toolCalls: 0, outputBytes: 0 },
    );
  }
  remaining(): ChildBudget {
    const u = this.usage();
    if (this.record.runs.at(-1)?.state === "running") {
      const current = this.engine.coordinator.getRunUsage(this.currentRunId);
      for (const k of CHILD_USAGE_KEYS) u[k] += current[k];
    }
    return {
      turns: this.task.budget.turns - u.turns,
      toolCalls: this.task.budget.toolCalls - u.toolCalls,
      outputBytes: this.task.budget.outputBytes - u.outputBytes,
      durationMs: Math.max(
        0,
        Math.min(
          this.task.budget.durationMs,
          Date.parse(this.record.expiresAt) - Date.now(),
        ),
      ),
    };
  }
  private watch(runId: string): void {
    this.pending = this.engine
      .waitForRun(runId)
      .then(async (run) => {
        const uncertain =
          run.state === "interrupted" ||
          [
            "CLEANUP_UNCERTAIN",
            "PROVIDER_TIMEOUT",
            "PROVIDER_TRANSPORT_ERROR",
            "PROVIDER_REQUEST_TIMEOUT",
            "PROVIDER_INACTIVITY_TIMEOUT",
          ].includes(run.error?.code ?? "");
        if (uncertain)
          throw new EngineError(
            "RESIDENT_CLEANUP_UNCERTAIN",
            "Resident physical cleanup is unknown",
          );
        this.engine.coordinator.assertWorkspaceCleanupConfirmed(
          run.workspaceId,
        );
        const usage = this.engine.coordinator.getRunUsage(run.id);
        this.lastContent = this.engine.store.getLastRunAssistantContent(run.id);
        this.save({
          state: "idle",
          runs: this.record.runs.map((x) =>
            x.runId === run.id
              ? {
                  ...x,
                  state: childOutcomeState(run.state),
                  usage: { ...usage },
                  outcomeSha256: knowledgeHash({
                    run,
                    usage,
                    content: this.lastContent,
                  }),
                }
              : x,
          ),
        });
        const r = this.remaining();
        if (
          this.stopping ||
          run.state !== "completed" ||
          r.turns < 1 ||
          r.toolCalls < 1 ||
          r.outputBytes < 1024 ||
          r.durationMs < 1 ||
          this.record.runs.length >= 32
        ) {
          queueMicrotask(() => void this.stop(childOutcomeState(run.state)));
          return;
        }
        this.idleDeadline =
          Date.now() + Math.min(this.record.idleTimeoutMs, r.durationMs);
        this.idleTimer = setTimeout(
          () => void this.stop("completed"),
          Math.min(this.record.idleTimeoutMs, r.durationMs),
        );
      })
      .catch((error) => {
        void this.fail(error);
      });
    void this.pending.catch(() => {});
  }
  /** Rejects a new Run before any input exists; it never abandons the resident. */
  assertAdmissible(): ChildBudget {
    this.assertCurrent();
    if (this.record.runs.length >= 32)
      throw new EngineError(
        "RESIDENT_HISTORY_LIMIT",
        "Lifetime Run admission is full",
      );
    if (this.record.state !== "idle")
      throw new EngineError(
        "RESIDENT_BUSY",
        "A resident accepts a new Run only after prior physical settlement",
      );
    const r = this.remaining();
    if (
      r.turns < 1 ||
      r.toolCalls < 1 ||
      r.outputBytes < 1024 ||
      r.durationMs < 1
    )
      throw new EngineError(
        "RESIDENT_BUDGET_EXCEEDED",
        "Resident allocation is exhausted",
      );
    return r;
  }
  accept(input: { requestId: string; prompt: string }): {
    run: Run;
    input: import("@moodcode/contracts").InputRecord;
    admittedSeq: number;
    inputSha256: string;
    release(): void;
  } {
    const config = childRunConfig(this.config, this.assertAdmissible());
    const accepted = {
      sessionId: this.record.childSessionId,
      requestId: input.requestId,
      prompt: input.prompt,
      delivery: "queue" as const,
      config,
    };
    try {
      const receipt = this.engine.store.acceptInput(accepted);
      if (receipt.duplicate)
        throw new EngineError(
          "RESIDENT_REQUEST_REUSED",
          "Resident input already exists and must be inspected",
        );
      const promoted = this.engine.store.promoteInput(receipt.inputId);
      const native = this.engine.store.getInput(receipt.inputId);
      this.save({
        state: "running",
        runs: [
          ...this.record.runs,
          {
            runId: promoted.run.id,
            inputId: native.id,
            inputSha256: knowledgeHash(accepted),
            configSha256: knowledgeHash(config),
            promptSha256: knowledgeHash(promoted.run.prompt),
            state: "running",
            usage: null,
            outcomeSha256: null,
          },
        ],
      });
      clearTimeout(this.idleTimer);
      this.idleDeadline = null;
      // No native scheduler wake occurs until the caller has saved its Team receipt/ACK.
      return {
        run: promoted.run,
        input: native,
        admittedSeq: receipt.admittedSeq,
        inputSha256: knowledgeHash(accepted),
        release: () => {
          if (this.stopping) return;
          this.assertProvider(promoted.run);
          void this.engine.coordinator.startPromoted(promoted.run.id);
          this.watch(promoted.run.id);
          void this.engine.scheduler.wake(native.sessionId).catch(() => {});
        },
      };
    } catch (error) {
      this.abandon();
      throw error;
    }
  }
  async stop(
    state: "completed" | "failed" | "cancelled" = "cancelled",
  ): Promise<void> {
    if (this.stopping)
      return this.finished.then(
        () => {},
        () => {},
      );
    this.stopping = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.deadlineTimer);
    try {
      const active = this.engine.coordinator.activeRun(
        this.record.childSessionId,
      );
      if (active) await this.engine.coordinator.cancel(active.id);
      await this.pending;
      await this.ports.close();
      this.save({ state: "closed" });
      this.resolve({ state, content: this.lastContent, usage: this.usage() });
    } catch (error) {
      await this.fail(error);
    }
  }
  abandon(): void {
    void this.fail(
      new EngineError(
        "RESIDENT_DELIVERY_UNCERTAIN",
        "Resident input lacks confirmed native mailbox receipt",
      ),
    );
  }
  private async fail(error: unknown): Promise<void> {
    this.stopping = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.deadlineTimer);
    try {
      await this.ports.close();
    } catch {}
    try {
      this.save(uncertainResidentPatch(this.record));
    } catch {}
    this.reject(error);
  }
}

const guards = new WeakMap<object, (run: Run) => void>();
export function bindResidentProviderGuard(
  engine: object,
  guard: (run: Run) => void,
): void {
  guards.set(engine, guard);
}
export function assertResidentProviderDispatch(
  engine: object,
  run: Run,
): boolean {
  const guard = guards.get(engine);
  if (!guard) return false;
  guard(run);
  return true;
}
