import { types } from "node:util";
import { EngineError, type JsonObject, type Run } from "@moodcode/contracts";
import type { ToolContext } from "../ports.js";
import type { SqliteStore } from "../storage/index.js";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type { TeamOwnerPort } from "./input-port.js";
import { teamHostData, teamHostObject } from "./policy.js";
import { teamId, teamInteger } from "./validation.js";
import {
  parseTeamModelInput,
  type TeamModelActorSnapshot,
  type TeamModelExpectation,
  type TeamModelInput,
  type TeamModelOperation,
  type TeamModelToolHost,
} from "./model-tools.js";
import type { TeamService } from "./service.js";
import type {
  TeamMailboxCursor,
  TeamMailboxPage,
  TeamMemberOwnerProof,
  TeamMemberRevision,
  TeamRecord,
  TeamTaskRevision,
} from "./types.js";

export interface BindTeamModelToolsInput {
  readonly rootSessionId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly childTaskId?: string;
  /** Only these host-selected aliases may be addressed by the model. */
  readonly recipientAliases?: readonly string[];
}
export interface TeamModelExecution {
  readonly store: Pick<
    SqliteStore,
    | "getRun"
    | "getSession"
    | "getWorkspace"
    | "getSessionControl"
    | "getTurn"
    | "getAttempt"
    | "getToolCall"
    | "listParts"
    | "listToolApprovals"
  >;
  readonly coordinator: {
    activeRun(sessionId: string): Run | null | undefined;
    getRunCancellationSignal(runId: string): AbortSignal;
    assertWorkspaceCleanupConfirmed(workspaceId: string): void;
    /** Checks the ORIGINAL context produced for the actual executing operation. */
    assertTeamToolContext(
      context: ToolContext,
      phase: "prepare" | "execute",
    ): void;
  };
  readonly executionLockPath: string;
  readonly artifactDir: string;
}
export interface EngineTeamModelToolHostPorts {
  readonly owner: TeamOwnerPort;
  readonly service: Pick<
    TeamService,
    | "sendAgentMessage"
    | "readAgentMailbox"
    | "releasePage"
    | "claimTeamTask"
    | "completeTeamTask"
  >;
  rootSessionWorkspace(rootSessionId: string): string;
  getTeam(workspaceId: string, teamId: string): TeamRecord | undefined;
  getMember(
    workspaceId: string,
    teamId: string,
    memberId: string,
  ): TeamMemberRevision | undefined;
  getTask(
    workspaceId: string,
    teamId: string,
    taskId: string,
  ): TeamTaskRevision | undefined;
  getCursor(
    workspaceId: string,
    teamId: string,
    memberId: string,
    generation: number,
  ): TeamMailboxCursor;
  assertOwnerUnquarantined(
    workspaceId: string,
    proof: TeamMemberOwnerProof,
  ): void;
  /** Uses the private engine execution graph, never a caller-supplied database path. */
  resolveExecution(proof: TeamMemberOwnerProof): TeamModelExecution;
  assertEnabled(): void;
  readonly now?: () => number;
}
export interface TeamModelToolsBinding {
  readonly actor: JsonObject;
}
interface Binding {
  readonly original: TeamModelToolsBinding;
  readonly selection: BindTeamModelToolsInput;
  readonly workspaceId: string;
  readonly member: TeamMemberRevision;
  readonly teamSha256: string;
  readonly executionKey: string;
  released: boolean;
}
interface Invocation {
  readonly binding: Binding;
  readonly operation: TeamModelOperation;
  readonly input: TeamModelInput;
  readonly inputSha256: string;
  readonly contextIdentity: string;
  readonly snapshot: TeamModelActorSnapshot;
  readonly recipient?: TeamMemberRevision;
  readonly task?: TeamTaskRevision;
  readonly page?: TeamMailboxPage;
  readonly messageExpiresAt?: string;
  preparedFingerprint: string | null;
  released: boolean;
  invoked: boolean;
}
function fail(code = "TEAM_MODEL_OWNER_STALE"): never {
  throw new EngineError(
    code,
    "Team tools require their original selected member, live execution and exact current tool request",
  );
}
function executionKey(
  proof: Pick<TeamMemberOwnerProof, "workspaceId" | "sessionId" | "runId">,
): string {
  return JSON.stringify([proof.workspaceId, proof.sessionId, proof.runId]);
}
function contextIdentity(context: ToolContext): string {
  return JSON.stringify([
    context.workspace.id,
    context.workspace.root,
    context.workspace.gitRoot ?? null,
    context.sessionId,
    context.runId,
    context.toolCallId,
    context.turnId,
    context.attemptId,
    context.artifactDir,
    context.executionLockPath,
  ]);
}
function contextShape(context: ToolContext): void {
  teamHostObject(
    context,
    [
      "workspace",
      "sessionId",
      "runId",
      "toolCallId",
      "signal",
      "limits",
      "artifactDir",
      "recordCheckpoint",
    ],
    [
      "budgets",
      "turnId",
      "attemptId",
      "executionLockPath",
      "mcpExecutionObserver",
    ],
  );
  teamHostObject(context.workspace, [
    "id",
    "root",
    "gitRoot",
    "branch",
    "createdAt",
  ]);
  for (const value of [
    context.workspace.id,
    context.workspace.root,
    context.sessionId,
    context.runId,
    context.toolCallId,
    context.turnId,
    context.attemptId,
    context.artifactDir,
    context.executionLockPath,
  ])
    teamId(value);
  if (
    !context.signal ||
    types.isProxy(context.signal) ||
    !(context.signal instanceof AbortSignal)
  )
    fail();
}
function actorSnapshot(binding: Binding): JsonObject {
  const member = binding.member;
  return immutableKnowledgeJson({
    workspaceId: binding.workspaceId,
    teamId: member.teamId,
    memberId: member.memberId,
    generation: member.generation,
    memberRevisionId: member.id,
    memberSha256: member.sha256,
    role: member.role,
    permissions: { ...member.permissions },
    owner: {
      kind: member.owner.kind,
      sessionId: member.owner.sessionId,
      runId: member.owner.runId,
      rootSessionId: member.owner.rootSessionId,
      rootRunId: member.owner.rootRunId,
      childTaskId: member.owner.childTaskId,
      ownerEpoch: member.owner.ownerEpoch,
      sha256: member.owner.sha256,
    },
    recipientAliases: [...(binding.selection.recipientAliases ?? [])],
  });
}

/** Fixed tool definitions use port(); bindings select one exact member per actual execution.
 * Descriptions and stored IDs cannot select another actor or reopen an old owner.
 */
export class EngineTeamModelToolHost {
  private readonly bindings = new WeakMap<object, Binding>();
  private readonly selected = new Map<string, Binding>();
  private readonly originals = new WeakMap<object, Invocation>();
  private closed = false;
  constructor(private readonly ports: EngineTeamModelToolHostPorts) {}
  private open(): void {
    if (this.closed) fail("TEAM_MODEL_CLOSED");
    this.ports.assertEnabled();
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
  private observe(member: TeamMemberRevision): TeamMemberOwnerProof {
    const original = this.ports.owner.capture({
      workspaceId: member.workspaceId,
      rootSessionId: member.owner.rootSessionId,
      rootRunId: member.owner.rootRunId,
      ...(member.owner.childTaskId === null
        ? {}
        : { childTaskId: member.owner.childTaskId }),
    });
    try {
      this.ports.owner.assertCurrent(original, member);
      const proof = this.ports.owner.read(original);
      if (proof.cleanup !== "live" || proof.sha256 !== member.owner.sha256)
        fail();
      this.ports.assertOwnerUnquarantined(member.workspaceId, proof);
      return proof;
    } finally {
      this.ports.owner.release(original);
    }
  }
  private activeMember(
    workspaceId: string,
    teamId: string,
    memberId: string,
    generation: number,
  ): TeamMemberRevision {
    const member = this.ports.getMember(workspaceId, teamId, memberId);
    if (
      !member ||
      member.workspaceId !== workspaceId ||
      member.teamId !== teamId ||
      member.memberId !== memberId ||
      member.generation !== generation ||
      member.status !== "active" ||
      Date.parse(member.expiresAt) <= this.now()
    )
      fail("TEAM_MODEL_MEMBER_STALE");
    return member;
  }
  bind(input: BindTeamModelToolsInput): TeamModelToolsBinding {
    this.open();
    teamHostObject(
      input,
      ["rootSessionId", "teamId", "memberId", "generation"],
      ["childTaskId", "recipientAliases"],
    );
    for (const value of [input.rootSessionId, input.teamId, input.memberId])
      teamId(value);
    teamInteger(input.generation);
    if (input.generation < 1) fail("INVALID_TEAM_MODEL_BINDING");
    if (input.childTaskId !== undefined) teamId(input.childTaskId);
    const selection = teamHostData(input);
    const aliases = selection.recipientAliases ?? [];
    if (
      !Array.isArray(aliases) ||
      aliases.length > 32 ||
      new Set(aliases).size !== aliases.length
    )
      fail("INVALID_TEAM_MODEL_BINDING");
    for (const alias of aliases) teamId(alias);
    const workspaceId = this.ports.rootSessionWorkspace(
      selection.rootSessionId,
    );
    const team = this.ports.getTeam(workspaceId, selection.teamId);
    if (
      !team ||
      team.status !== "active" ||
      Date.parse(team.expiresAt) <= this.now()
    )
      fail("TEAM_MODEL_MEMBER_STALE");
    const member = this.activeMember(
      workspaceId,
      selection.teamId,
      selection.memberId,
      selection.generation,
    );
    if (
      member.owner.rootSessionId !== selection.rootSessionId ||
      member.owner.childTaskId !== (selection.childTaskId ?? null)
    )
      fail("TEAM_MODEL_MEMBER_STALE");
    const proof = this.observe(member),
      key = executionKey(proof);
    if (this.selected.has(key)) fail("TEAM_MODEL_BINDING_CONFLICT");
    if (this.selected.size >= 32) fail("TEAM_MODEL_LIMIT");
    const binding: Binding = {
      original: undefined!,
      selection,
      workspaceId,
      member,
      teamSha256: team.sha256,
      executionKey: key,
      released: false,
    };
    const original = Object.freeze({ actor: actorSnapshot(binding) });
    const actual: Binding = { ...binding, original };
    this.bindings.set(original, actual);
    this.selected.set(key, actual);
    return original;
  }
  private binding(original: object): Binding {
    if (!original || types.isProxy(original)) fail("TEAM_MODEL_BINDING_STALE");
    const binding = this.bindings.get(original);
    if (
      !binding ||
      binding.released ||
      this.selected.get(binding.executionKey) !== binding
    )
      fail("TEAM_MODEL_BINDING_STALE");
    return binding;
  }
  releaseBinding(original: TeamModelToolsBinding): void {
    if (!original || types.isProxy(original)) return;
    const binding = this.bindings.get(original);
    if (!binding || binding.released) return;
    binding.released = true;
    if (this.selected.get(binding.executionKey) === binding)
      this.selected.delete(binding.executionKey);
    this.bindings.delete(original);
  }
  private current(
    binding: Binding,
    context: ToolContext,
    operation: TeamModelOperation,
    phase: "prepare" | "execute",
    fingerprint?: string,
    input?: TeamModelInput,
  ): TeamModelExecution {
    this.open();
    this.binding(binding.original);
    const team = this.ports.getTeam(binding.workspaceId, binding.member.teamId);
    if (
      !team ||
      team.status !== "active" ||
      team.sha256 !== binding.teamSha256 ||
      Date.parse(team.expiresAt) <= this.now()
    )
      fail("TEAM_MODEL_MEMBER_STALE");
    const member = this.activeMember(
      binding.workspaceId,
      binding.member.teamId,
      binding.member.memberId,
      binding.member.generation,
    );
    if (
      member.id !== binding.member.id ||
      member.sha256 !== binding.member.sha256
    )
      fail("TEAM_MODEL_MEMBER_STALE");
    const proof = this.observe(member),
      execution = this.ports.resolveExecution(proof);
    // ORIGINAL provenance comes first; a caller cannot create a context by copying native IDs.
    execution.coordinator.assertTeamToolContext(context, phase);
    contextShape(context);
    if (
      context.signal.aborted ||
      execution.coordinator.getRunCancellationSignal(proof.runId).aborted
    )
      fail("CANCELLED");
    if (
      executionKey(proof) !== binding.executionKey ||
      context.workspace.id !== proof.workspaceId ||
      context.sessionId !== proof.sessionId ||
      context.runId !== proof.runId ||
      context.executionLockPath !== execution.executionLockPath ||
      context.artifactDir !== execution.artifactDir
    )
      fail();
    const run = execution.store.getRun(context.runId),
      session = execution.store.getSession(context.sessionId),
      workspace = execution.store.getWorkspace(run.workspaceId);
    if (
      run.state !== "running" ||
      run.id !== proof.runId ||
      run.sessionId !== proof.sessionId ||
      run.workspaceId !== proof.workspaceId ||
      session.workspaceId !== run.workspaceId ||
      execution.coordinator.activeRun(run.sessionId)?.id !== run.id ||
      execution.store.getSessionControl(run.sessionId).paused ||
      workspace.id !== context.workspace.id ||
      workspace.root !== context.workspace.root ||
      workspace.gitRoot !== context.workspace.gitRoot
    )
      fail();
    execution.coordinator.assertWorkspaceCleanupConfirmed(run.workspaceId);
    const tool = execution.store.getToolCall(context.toolCallId),
      turn = execution.store.getTurn(context.turnId!),
      attempt = execution.store.getAttempt(context.attemptId!);
    if (
      input !== undefined &&
      knowledgeHash(parseTeamModelInput(operation, tool.input)) !==
        knowledgeHash(input)
    )
      fail("TEAM_MODEL_PREPARED_STALE");
    if (
      tool.sessionId !== run.sessionId ||
      tool.runId !== run.id ||
      tool.name !== operation ||
      tool.state !== (phase === "prepare" ? "requested" : "running") ||
      turn.sessionId !== run.sessionId ||
      turn.runId !== run.id ||
      turn.state !== "awaiting_tools" ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== run.id ||
      attempt.turnId !== turn.id ||
      attempt.state !== "completed"
    )
      fail();
    const part = execution.store
      .listParts(turn.id)
      .find((value) => value.type === "tool" && value.toolCallId === tool.id);
    if (
      !part ||
      part.type !== "tool" ||
      part.state !== "open" ||
      part.name !== operation ||
      part.sessionId !== run.sessionId ||
      part.runId !== run.id ||
      part.turnId !== turn.id ||
      knowledgeHash(part.input) !== knowledgeHash(tool.input)
    )
      fail();
    if (
      !Number.isSafeInteger(context.limits.maxOutputBytes) ||
      context.limits.maxOutputBytes < 1024
    )
      fail("TEAM_MODEL_OUTPUT_LIMIT");
    if (
      operation === "read_agent_mailbox"
        ? !member.permissions.receive
        : operation === "send_agent_message"
          ? !member.permissions.send || member.role === "observer"
          : !member.permissions.claimTasks || member.role === "observer"
    )
      fail("TEAM_MODEL_PERMISSION_DENIED");
    if (phase === "execute" && operation !== "read_agent_mailbox") {
      if (
        run.config.mode !== "build" ||
        !fingerprint ||
        !execution.store
          .listToolApprovals(tool.id)
          .some(
            (approval) =>
              approval.status === "allowed" &&
              approval.sessionId === run.sessionId &&
              approval.runId === run.id &&
              approval.toolCallId === tool.id &&
              approval.toolName === operation &&
              approval.preview.teamModelRequestFingerprint === fingerprint,
          )
      )
        fail("TEAM_MODEL_APPROVAL_REQUIRED");
    }
    return execution;
  }
  private capture(
    binding: Binding,
    context: ToolContext,
    operation: TeamModelOperation,
    input: TeamModelInput,
  ): object {
    const parsed = parseTeamModelInput(operation, input);
    this.current(binding, context, operation, "prepare", undefined, parsed);
    let recipient: TeamMemberRevision | undefined,
      task: TeamTaskRevision | undefined,
      page: TeamMailboxPage | undefined,
      messageExpiresAt: string | undefined;
    let resources: JsonObject = {};
    if (operation === "send_agent_message") {
      const send = parsed as {
        requestId: string;
        recipient: string;
        text: string;
      };
      if (!binding.selection.recipientAliases?.includes(send.recipient))
        fail("TEAM_MODEL_RECIPIENT_DENIED");
      const selected = this.ports.getMember(
        binding.workspaceId,
        binding.member.teamId,
        send.recipient,
      );
      if (!selected) fail("TEAM_MODEL_RECIPIENT_STALE");
      recipient = this.activeMember(
        binding.workspaceId,
        binding.member.teamId,
        selected.memberId,
        selected.generation,
      );
      if (!recipient.permissions.receive) fail("TEAM_MODEL_RECIPIENT_DENIED");
      this.observe(recipient);
      messageExpiresAt = new Date(
        Math.min(
          Date.parse(binding.member.expiresAt),
          Date.parse(recipient.expiresAt),
          Date.parse(
            this.ports.getTeam(binding.workspaceId, binding.member.teamId)!
              .expiresAt,
          ),
        ),
      ).toISOString();
      resources = {
        recipient: {
          memberId: recipient.memberId,
          generation: recipient.generation,
          revisionId: recipient.id,
          sha256: recipient.sha256,
          ownerSha256: recipient.owner.sha256,
        },
        expiresAt: messageExpiresAt,
      };
    } else if (operation === "read_agent_mailbox") {
      const original = this.ports.service.readAgentMailbox({
        workspaceId: binding.workspaceId,
        teamId: binding.member.teamId,
        memberId: binding.member.memberId,
        generation: binding.member.generation,
        limit: (parsed as { limit?: number }).limit ?? 4,
        signal: context.signal,
      });
      try {
        page = immutableKnowledgeJson(original);
      } finally {
        this.ports.service.releasePage(original);
      }
      if (
        Buffer.byteLength(JSON.stringify(page)) >
        Math.min(31744, context.limits.maxOutputBytes - 1024)
      )
        fail("TEAM_MODEL_OUTPUT_LIMIT");
      resources = {
        pageSha256: page.sha256,
        cursor: {
          revision: page.cursor.revision,
          claimedSeq: page.cursor.claimedSeq,
          pendingDeliveryId: page.cursor.pendingDeliveryId,
        },
        messageIds: page.messages.map((message) => message.id),
        hasMore: page.hasMore,
      };
    } else {
      const mutation = parsed as {
        requestId: string;
        taskId: string;
        expectedRevision: number;
      };
      task = this.ports.getTask(
        binding.workspaceId,
        binding.member.teamId,
        mutation.taskId,
      );
      if (
        !task ||
        task.revision !== mutation.expectedRevision ||
        Date.parse(task.expiresAt) <= this.now()
      )
        fail("TEAM_MODEL_TASK_STALE");
      if (
        operation === "complete_team_task" &&
        (!task.owner ||
          task.owner.memberId !== binding.member.memberId ||
          task.owner.generation !== binding.member.generation ||
          task.owner.memberRevisionId !== binding.member.id ||
          task.owner.memberSha256 !== binding.member.sha256)
      )
        fail("TEAM_MODEL_PERMISSION_DENIED");
      resources = {
        taskId: task.taskId,
        revisionId: task.id,
        revision: task.revision,
        sha256: task.sha256,
        state: task.state,
      };
    }
    const original = Object.freeze({});
    this.originals.set(original, {
      binding,
      operation,
      input: parsed,
      inputSha256: knowledgeHash(parsed),
      contextIdentity: contextIdentity(context),
      snapshot: immutableKnowledgeJson({
        actor: actorSnapshot(binding),
        resources,
      }),
      ...(recipient ? { recipient } : {}),
      ...(task ? { task } : {}),
      ...(page ? { page } : {}),
      ...(messageExpiresAt ? { messageExpiresAt } : {}),
      preparedFingerprint: null,
      released: false,
      invoked: false,
    });
    return original;
  }
  private invocation(original: object): Invocation {
    if (!original || types.isProxy(original)) fail("TEAM_MODEL_PREPARED_STALE");
    const captured = this.originals.get(original);
    if (!captured || captured.released) fail("TEAM_MODEL_PREPARED_STALE");
    return captured;
  }
  private assertCurrent(
    original: object,
    context: ToolContext,
    phase: "prepare" | "execute",
    expected: TeamModelExpectation,
  ): void {
    const captured = this.invocation(original);
    teamHostObject(expected, ["operation", "input"], ["fingerprint"]);
    if (phase !== "prepare" && phase !== "execute")
      fail("TEAM_MODEL_PREPARED_STALE");
    const input = parseTeamModelInput(expected.operation, expected.input);
    if (
      captured.operation !== expected.operation ||
      captured.inputSha256 !== knowledgeHash(input)
    )
      fail("TEAM_MODEL_PREPARED_STALE");
    if (
      typeof expected.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.fingerprint) ||
      (captured.preparedFingerprint !== null &&
        captured.preparedFingerprint !== expected.fingerprint) ||
      (phase === "execute" && captured.preparedFingerprint === null)
    )
      fail("TEAM_MODEL_PREPARED_STALE");
    this.current(
      captured.binding,
      context,
      captured.operation,
      phase,
      expected.fingerprint,
      captured.input,
    );
    if (contextIdentity(context) !== captured.contextIdentity)
      fail("TEAM_MODEL_PREPARED_STALE");
    if (captured.recipient) {
      const member = this.activeMember(
        captured.binding.workspaceId,
        captured.binding.member.teamId,
        captured.recipient.memberId,
        captured.recipient.generation,
      );
      if (
        member.id !== captured.recipient.id ||
        member.sha256 !== captured.recipient.sha256
      )
        fail("TEAM_MODEL_RECIPIENT_STALE");
      this.observe(member);
    }
    if (captured.task) {
      const task = this.ports.getTask(
        captured.binding.workspaceId,
        captured.binding.member.teamId,
        captured.task.taskId,
      );
      if (
        !task ||
        task.id !== captured.task.id ||
        task.sha256 !== captured.task.sha256
      )
        fail("TEAM_MODEL_TASK_STALE");
    }
    if (captured.page) {
      if (
        captured.page.messages.some(
          (message) => Date.parse(message.expiresAt) <= this.now(),
        )
      )
        fail("TEAM_MODEL_PAGE_STALE");
      const cursor = this.ports.getCursor(
        captured.binding.workspaceId,
        captured.binding.member.teamId,
        captured.binding.member.memberId,
        captured.binding.member.generation,
      );
      // New arrivals may extend the mailbox, but cannot rewrite the captured page.
      if (
        cursor.claimedSeq !== captured.page.cursor.claimedSeq ||
        cursor.pendingDeliveryId !== captured.page.cursor.pendingDeliveryId
      )
        fail("TEAM_MODEL_PAGE_STALE");
    }
    if (phase === "prepare")
      captured.preparedFingerprint = expected.fingerprint;
  }
  private invoke(
    original: object,
    operation: TeamModelOperation,
    input: TeamModelInput,
    context: ToolContext,
    fingerprint: string,
  ): JsonObject {
    const captured = this.invocation(original);
    if (captured.invoked) fail("TEAM_MODEL_PREPARED_REUSED");
    this.assertCurrent(original, context, "execute", {
      operation,
      input,
      fingerprint,
    });
    captured.invoked = true;
    const member = captured.binding.member;
    if (operation === "read_agent_mailbox")
      return immutableKnowledgeJson(captured.page!) as unknown as JsonObject;
    const result =
      operation === "send_agent_message"
        ? this.ports.service.sendAgentMessage({
            workspaceId: captured.binding.workspaceId,
            teamId: member.teamId,
            senderMemberId: member.memberId,
            senderGeneration: member.generation,
            recipientMemberId: captured.recipient!.memberId,
            recipientGeneration: captured.recipient!.generation,
            requestId: (captured.input as { requestId: string }).requestId,
            text: (captured.input as { text: string }).text,
            expiresAt: captured.messageExpiresAt!,
          })
        : this.ports.service[
            operation === "claim_team_task"
              ? "claimTeamTask"
              : "completeTeamTask"
          ]({
            workspaceId: captured.binding.workspaceId,
            teamId: member.teamId,
            memberId: member.memberId,
            generation: member.generation,
            requestId: (captured.input as { requestId: string }).requestId,
            taskId: (captured.input as { taskId: string }).taskId,
            expectedRevision: (captured.input as { expectedRevision: number })
              .expectedRevision,
          });
    return immutableKnowledgeJson({
      recordId: result.record.id,
      recordSha256: result.record.sha256,
      receiptId: result.receipt.id,
      receiptSha256: result.receipt.sha256,
      duplicate: result.duplicate,
      ...(operation === "send_agent_message"
        ? {}
        : {
            state: (result.record as TeamTaskRevision).state,
            revision: (result.record as TeamTaskRevision).revision,
          }),
    });
  }
  private release(original: object): void {
    if (!original || types.isProxy(original)) return;
    const captured = this.originals.get(original);
    if (captured) {
      captured.released = true;
      this.originals.delete(original);
    }
  }
  scope(original: TeamModelToolsBinding): TeamModelToolHost {
    const binding = this.binding(original);
    const scoped = (capture: object): Invocation => {
      const invocation = this.invocation(capture);
      if (invocation.binding !== binding) fail("TEAM_MODEL_BINDING_STALE");
      return invocation;
    };
    return {
      capture: (context, operation, input) =>
        this.capture(binding, context, operation, input),
      read: (originalCapture) => scoped(originalCapture).snapshot,
      assertCurrent: (originalCapture, context, phase, expected) => {
        scoped(originalCapture);
        this.assertCurrent(originalCapture, context, phase, expected);
      },
      invoke: (originalCapture, operation, input, context, fingerprint) => {
        scoped(originalCapture);
        return this.invoke(
          originalCapture,
          operation,
          input,
          context,
          fingerprint,
        );
      },
      release: (originalCapture) => {
        scoped(originalCapture);
        this.release(originalCapture);
      },
    };
  }
  /** One aggregate port supports fixed catalogues before any selected binding exists. */
  port(): TeamModelToolHost {
    return {
      capture: (context, operation, input) => {
        this.open();
        contextShape(context);
        const binding = this.selected.get(
          JSON.stringify([
            context.workspace.id,
            context.sessionId,
            context.runId,
          ]),
        );
        if (!binding) fail("TEAM_MODEL_BINDING_REQUIRED");
        return this.capture(binding, context, operation, input);
      },
      read: (original) => this.invocation(original).snapshot,
      assertCurrent: (original, context, phase, expected) =>
        this.assertCurrent(original, context, phase, expected),
      invoke: (original, operation, input, context, fingerprint) =>
        this.invoke(original, operation, input, context, fingerprint),
      release: (original) => this.release(original),
    };
  }
  close(): void {
    this.closed = true;
    for (const binding of this.selected.values()) binding.released = true;
    this.selected.clear();
  }
}
