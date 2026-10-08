import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coordinatorPermissions,
  workerPermissions,
} from "../teams/fixtures/native-team.js";
import { gate, teamFixture } from "../teams/fixtures/engine-team.js";
import { residentUntil } from "../teams/fixtures/resident.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { createEngine } from "../engine.js";
import type { ProviderEvent } from "../ports.js";

test(
  "resident mailbox continuation keeps inherited kernel scope, native command owner and paused archive lineage",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async (t) => {
    const firstRelease = gate();
    t.after(() => firstRelease.resolve());
    const commandRuns = new Set<string>();
    let parentPath = "";
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const f = await teamFixture(t, {
      engine: {
        teams: true,
        residentTeams: true,
        teamModelTools: true,
        osSandbox: true,
        jobs: true,
        hostCommands: true,
        commandJobModelTools: true,
      },
      resident: {
        idleTimeoutMs: 10000,
        allocation: {
          turns: 6,
          toolCalls: 3,
          outputBytes: 32768,
          durationMs: 20000,
        },
      },
      childTools: ["run_command", "read_agent_mailbox"],
      streamChild: async function* (
        request,
        signal,
      ): AsyncIterable<ProviderEvent> {
        const mailbox = request.messages.some(
          (m) =>
            m.role === "user" && m.content.startsWith("[Moodcode team mailbox"),
        );
        if (!mailbox) {
          yield { type: "progress" };
          await firstRelease.promise;
          if (!signal.aborted) yield { type: "finish", reason: "stop" };
          return;
        }
        if (!commandRuns.has(request.runId)) {
          commandRuns.add(request.runId);
          yield {
            type: "tool.call",
            call: {
              id: "resident-kernel-command",
              name: "run_command",
              input: {
                command: `cat ${quote(parentPath)}; printf resident-kernel > resident-effect`,
              },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text.delta",
            delta: "Observed resident command receipt.",
          };
          yield { type: "finish", reason: "stop" };
        }
      },
    });
    parentPath = join(f.root, "seed.txt");
    await f.engine.registerSandboxBackend();
    const config = f.engine.profiles.apply(f.session.id, {
      ...f.engine.getCapabilities().defaults,
      agentProfileId: "actual-team-observer",
    });
    const grant = await f.engine.previewSandboxGrant({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      config,
      readPaths: [f.root],
      writePaths: [f.root],
      network: "deny",
    });
    await f.engine.approveSandboxGrant({
      workspaceId: f.workspace.id,
      requestId: "joint-resident-grant",
      expectedRevision: 0,
      preview: grant,
      fingerprint: f.engine.readSandboxGrant(grant).sha256,
      approved: true,
    });
    const startingParent = f.startParent();
    await residentUntil(
      () =>
        f.requests.length > 0 ||
        f.engine.store
          .getSnapshot(f.session.id)
          .runs.some((run) => run.state === "failed"),
      "parent provider or failure must become observable",
      5000,
    );
    assert.ok(
      f.requests.length > 0,
      JSON.stringify(f.engine.store.getSnapshot(f.session.id).runs),
    );
    const parent = await startingParent;
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const team = f.engine.createTeam({
      workspaceId: f.workspace.id,
      requestId: "joint-team-create",
      teamId: "joint-resident-team",
      expiresAt,
    }).record;
    const joinMember = (
      memberId: string,
      role: "coordinator" | "worker",
      childTaskId?: string,
    ) => {
      const preview = f.engine.previewTeamMember({
        workspaceId: f.workspace.id,
        teamId: team.id,
        memberId,
        expectedRevision: 0,
        role,
        permissions:
          role === "coordinator" ? coordinatorPermissions : workerPermissions,
        expiresAt,
        rootSessionId: f.session.id,
        ...(childTaskId ? { childTaskId } : {}),
      });
      return f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: `joint-join-${memberId}`,
        approved: true,
        preview,
      }).record;
    };
    const coordinator = joinMember("joint-coordinator", "coordinator");
    const startingChild = f.startChild();
    await residentUntil(
      () =>
        f.requests.length > 1 ||
        f.engine.children.tasks
          .list(f.session.id)
          .some((task) => ["failed", "uncertain"].includes(task.state)),
      "child provider or native failure must become observable",
      5000,
    );
    assert.ok(
      f.requests.length > 1,
      JSON.stringify(f.engine.children.tasks.list(f.session.id)),
    );
    const x = await startingChild;
    const member = joinMember("joint-worker", "worker", x.task.id);
    f.engine.bindTeamModelTools({
      rootSessionId: f.session.id,
      teamId: team.id,
      memberId: member.memberId,
      generation: member.generation,
      childTaskId: x.task.id,
    });
    firstRelease.resolve();
    await residentUntil(
      () =>
        f.engine.inspectResidentChildTask(f.session.id, x.task.id)?.state ===
        "idle",
      "initial resident Run must settle",
    );
    const initialRunId = x.task.childRunId!;
    f.engine.sendAgentMessage({
      workspaceId: f.workspace.id,
      teamId: team.id,
      senderMemberId: coordinator.memberId,
      senderGeneration: coordinator.generation,
      recipientMemberId: member.memberId,
      recipientGeneration: member.generation,
      text: "Run the explicit isolated command and preserve original approval.",
      requestId: "joint-resident-message",
      expiresAt,
    });
    const page = f.engine.readAgentMailbox({
      workspaceId: f.workspace.id,
      teamId: team.id,
      memberId: member.memberId,
      generation: member.generation,
    });
    const receipt = f.engine.resumeChildTurn({
      workspaceId: f.workspace.id,
      requestId: "joint-resident-delivery",
      approved: true,
      page,
      expectedCursorRevision: page.cursor.revision,
    });
    await residentUntil(
      () =>
        f.engine.children
          .approvals(f.session.id, x.task.id)
          .some((a) => a.status === "pending"),
      "continued native command approval",
      10000,
    );
    const approval = f.engine.children
      .approvals(f.session.id, x.task.id)
      .find((a) => a.status === "pending")!;
    f.engine.children.decide(
      f.session.id,
      x.task.id,
      approval.id,
      approval.fingerprint,
      "allow",
    );
    await residentUntil(
      () => {
        const current = f.engine.inspectResidentChildTask(
          f.session.id,
          x.task.id,
        );
        return current?.state === "idle" && current.runs.length === 2;
      },
      "actual continued resident Run must settle",
      10000,
    );
    const current = f.engine.inspectResidentChildTask(f.session.id, x.task.id)!;
    const runId = current.runs[1]!.runId;
    assert.notEqual(runId, initialRunId);
    assert.equal(
      f.engine.children.tasks.get(f.session.id, x.task.id).childRunId,
      initialRunId,
    );
    assert.equal(receipt.receipt!.input.runId, runId);
    assert.equal(x.child.store.getRun(initialRunId).state, "completed");
    assert.equal(x.child.store.getRun(runId).state, "completed");
    const tool = x.child.store
      .getSnapshot(x.child.store.getRun(runId).sessionId)
      .tools.find(
        (tool) => tool.runId === runId && tool.name === "run_command",
      )!;
    assert.equal(tool.state, "completed");
    assert.match(tool.output!, /Operation not permitted/);
    assert.doesNotMatch(tool.output!, /Committed actual isolated team fixture/);
    assert.equal(
      readFileSync(join(x.worktree.root, "resident-effect"), "utf8"),
      "resident-kernel",
    );
    assert.equal(existsSync(join(f.root, "resident-effect")), false);
    const enforcement = x.child
      .observeEnforcement(x.child.store.getRun(runId).workspaceId)
      .find((record) => record.kind === "command")!;
    assert.equal(enforcement.state, "closed");
    assert.equal(
      (enforcement.completion!.outcome as { cleanupConfirmed: boolean })
        .cleanupConfirmed,
      true,
    );
    assert.equal(enforcement.owner!.runId, runId);
    assert.equal(enforcement.owner!.toolCallId, tool.id);
    assert.throws(() => process.kill(enforcement.groupPid!, 0));
    assert.ok(
      x.child.store
        .listCheckpoints(runId)
        .some(
          (checkpoint) =>
            checkpoint.id === enforcement.completion!.checkpointId,
        ),
    );
    assert.equal(commandRuns.size, 1);
    await f.engine.stopResidentChildTask(f.session.id, x.task.id);
    f.parentRelease.resolve();
    await f.engine.waitForRun(parent.runId);
    await f.engine.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "joint-archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "joint-import"),
    });
    const calls = f.requests.length;
    const reopened = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
    });
    f.engines.add(reopened);
    assert.equal(
      reopened.inspectResidentChildTask(f.session.id, x.task.id)?.state,
      "paused-import",
    );
    assert.equal(f.requests.length, calls);
    assert.equal(commandRuns.size, 1);
    await reopened.close();
  },
);
