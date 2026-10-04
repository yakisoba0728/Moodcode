'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPORT_TYPE = 'moodcode.electron.engine.report';
const EXPECTED_REPLY = 'Moodcode scripted Electron utility smoke completed.';
const COMMAND_MARKER = 'moodcode-electron-command';
const EXPECTED_COMMAND = "printf 'moodcode-electron-command\\n'";
const COMMAND_TIMEOUT_MS = 5_000;
const PROVIDER_TOOL_CALL_ID = 'electron-smoke-command';

function smokeFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// This is a test fixture allow path, never a harness or engine approval policy.
function verifyFixtureApproval(event, snapshot, workspace, sessionId, runId) {
  assert.equal(event.type, 'approval.requested');
  assert.equal(event.sessionId, sessionId, 'Approval event must belong to the fixture session');
  assert.equal(event.runId, runId, 'Approval event must belong to the fixture run');
  const payload = event.payload;
  assert.equal(payload?.toolName, 'run_command');
  assert.equal(payload.status, 'pending');
  assert.equal(typeof payload.approvalId, 'string');
  assert(payload.approvalId.length > 0, 'Approval ID must be present');
  assert.equal(typeof payload.fingerprint, 'string');
  assert(payload.fingerprint.length > 0, 'Approval fingerprint must be present');
  assert.equal(typeof payload.toolCallId, 'string');
  assert(payload.toolCallId.length > 0, 'Approval tool binding must be present');
  const preview = payload.preview;
  assert.equal(preview?.command, EXPECTED_COMMAND, 'Only the exact smoke command may be approved');
  assert.equal(preview.cwd, workspace.root, 'Smoke command cwd must be the temporary fixture root');
  assert.equal(preview.timeoutMs, COMMAND_TIMEOUT_MS, 'Smoke command timeout must match the fixture');
  assert.equal(preview.workspaceId, workspace.id);
  assert.equal(preview.runId, runId);
  assert.equal(preview.toolCallId, payload.toolCallId);
  assert.equal(preview.termination, 'posix-process-group');

  const approvals = snapshot.approvals.filter((item) => item.id === payload.approvalId);
  assert.equal(approvals.length, 1, 'A single matching durable approval is required');
  const approval = approvals[0];
  assert.equal(approval.status, 'pending');
  assert.equal(approval.sessionId, sessionId);
  assert.equal(approval.runId, runId);
  assert.equal(approval.toolName, 'run_command');
  assert.equal(approval.toolCallId, payload.toolCallId);
  assert.equal(approval.fingerprint, payload.fingerprint);
  assert.deepEqual(approval.preview, preview);
  const tools = snapshot.tools.filter((item) => item.id === payload.toolCallId);
  assert.equal(tools.length, 1, 'Approval must reference a durable fixture tool call');
  assert.equal(tools[0].state, 'awaiting_approval');
  assert.equal(tools[0].sessionId, sessionId);
  assert.equal(tools[0].runId, runId);
  assert.equal(tools[0].name, 'run_command');
  assert.equal(tools[0].input.command, EXPECTED_COMMAND);
  assert.equal(tools[0].input.timeoutMs, COMMAND_TIMEOUT_MS);
  return approval;
}

function verifyCompletedCommand(snapshot, approval, runId) {
  const recordedApproval = snapshot.approvals.find((item) => item.id === approval.id);
  assert(recordedApproval, 'Command approval must remain recorded');
  assert.equal(recordedApproval.status, 'allowed');
  assert.equal(recordedApproval.fingerprint, approval.fingerprint);
  assert.equal(recordedApproval.toolCallId, approval.toolCallId);
  assert.equal(recordedApproval.runId, runId);
  const tools = snapshot.tools.filter((item) => item.id === approval.toolCallId);
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'run_command');
  assert.equal(tool.runId, runId);
  assert.equal(tool.state, 'completed', 'Approved command must actually complete');
  assert.equal(tool.input.command, EXPECTED_COMMAND);
  assert.equal(tool.error, undefined, 'A completed command must not hide a tool error');
  assert.equal(typeof tool.output, 'string');
  assert(tool.output.includes(COMMAND_MARKER + '\n'), 'Command output must contain the printed marker');
  assert(tool.output.includes('cleanupConfirmed=true'), 'Command output must report confirmed cleanup');
  return tool;
}

function verifyCommandCheckpoint(diff, runId, toolCallId) {
  assert.equal(diff.runId, runId);
  const checkpoints = diff.checkpoints.filter((item) => item.kind === 'command' && item.runId === runId && item.toolCallId === toolCallId);
  assert.equal(checkpoints.length, 1, 'A single matching command checkpoint is required');
  const checkpoint = checkpoints[0];
  assert.equal(typeof checkpoint.id, 'string');
  assert(checkpoint.id.length > 0);
  assert.equal(checkpoint.incomplete, false, 'Smoke command checkpoint must confirm complete observation');
  assert.deepEqual(checkpoint.files, [], 'Printing the fixture marker must not alter workspace files');
  assert.deepEqual(diff.files, []);
  return checkpoint;
}

function runtime() {
  return {
    processType: process.type ?? 'node',
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    platform: process.platform,
    arch: process.arch,
  };
}

function failure(error, stage) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'SMOKE_FAILED',
    message: String(error?.message ?? error).slice(0, 2_048),
    stage,
  };
}

function deadline(promise, timeoutMs, stage) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Electron engine smoke timed out during ${stage}`);
        error.code = 'SMOKE_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Exported for local fixture checks. The executable entry below additionally
// requires a real Electron utility runtime; Node fixture checks cannot pass it.
async function runEngineProbe(options) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const report = {
    schemaVersion: 1,
    type: REPORT_TYPE,
    ok: false,
    runtime: runtime(),
    checks: {
      sqliteAvailable: false,
      sqliteQuery: false,
      compiledEngineImported: false,
      workspaceOpened: false,
      sessionCreated: false,
      commandApprovalRequested: false,
      commandApprovalVerified: false,
      commandApproved: false,
      commandCompleted: false,
      commandOutputVerified: false,
      commandCleanupConfirmed: false,
      commandCheckpointVerified: false,
      scriptedRunCompleted: false,
      snapshotVerified: false,
      journalReplayed: false,
      engineClosed: false,
      persistedSnapshotVerified: false,
      commandEvidencePersisted: false,
      reopenedEngineClosed: false,
    },
  };
  let engine;
  let stage = 'sqlite';
  let commandNumber = 0;
  const cleanupErrors = [];
  async function step(name, operation) {
    stage = name;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      const error = new Error(`Electron engine smoke timed out during ${name}`);
      error.code = 'SMOKE_TIMEOUT';
      throw error;
    }
    return deadline(Promise.resolve().then(operation), remaining, name);
  }
  async function dispatch(type, payload) {
    const result = await step(type, () => engine.dispatch({
      schemaVersion: 1,
      commandId: `electron-smoke-${++commandNumber}`,
      type,
      payload,
    }));
    if (!result?.ok) {
      const error = new Error(result?.error?.message ?? `Command ${type} did not succeed`);
      error.code = result?.error?.code ?? 'COMMAND_FAILED';
      throw error;
    }
    return result.result;
  }
  try {
    // Probe the utility's actual built-in first, before importing engine storage.
    // A system Node probe would not establish Electron compatibility.
    const { DatabaseSync } = require('node:sqlite');
    report.checks.sqliteAvailable = true;
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
      sqlite.prepare('INSERT INTO smoke (value) VALUES (?)').run('utility-sqlite');
      assert.equal(sqlite.prepare('SELECT value FROM smoke').get().value, 'utility-sqlite');
      report.checks.sqliteQuery = true;
    } finally {
      sqlite.close();
    }

    const { createEngine, ScriptedProvider } = await step('engine.import', () =>
      import(pathToFileURL(path.resolve(options.engineEntry)).href));
    assert.equal(typeof createEngine, 'function', 'Compiled engine must export createEngine');
    assert.equal(typeof ScriptedProvider, 'function', 'Compiled engine must export ScriptedProvider');
    report.checks.compiledEngineImported = true;
    const engineOptions = {
      dbPath: path.resolve(options.dbPath),
      artifactDir: path.resolve(options.artifactDir),
      providers: [new ScriptedProvider([
        { events: [
          { type: 'tool.call', call: { id: PROVIDER_TOOL_CALL_ID, name: 'run_command', input: { command: EXPECTED_COMMAND, timeoutMs: COMMAND_TIMEOUT_MS } } },
          { type: 'finish', reason: 'tool_calls' },
        ] },
        { events: [
          { type: 'text.delta', delta: EXPECTED_REPLY },
          { type: 'finish', reason: 'stop' },
        ] },
      ])],
    };
    engine = await step('engine.create', () => createEngine(engineOptions));
    const workspace = await dispatch('workspace.open', { path: path.resolve(options.workspace) });
    assert.equal(typeof workspace?.id, 'string');
    report.checks.workspaceOpened = true;
    const session = await dispatch('session.create', { workspaceId: workspace.id, title: 'Electron utility smoke' });
    assert.equal(typeof session?.id, 'string');
    report.checks.sessionCreated = true;
    const receipt = await dispatch('run.submit', {
      sessionId: session.id,
      requestId: 'electron-smoke-scripted-request',
      prompt: 'Verify the local scripted engine in the Electron utility process.',
      config: { mode: 'build' },
    });
    assert.equal(typeof receipt?.runId, 'string');
    const approvalController = new AbortController();
    let approvalEvent;
    try {
      approvalEvent = await step('approval.wait', async () => {
        let observed = 0;
        for await (const event of engine.subscribe(session.id, 0, approvalController.signal)) {
          assert(++observed <= 100, 'Fixture approval replay must remain bounded');
          if (event.type === 'approval.requested') return event;
          if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) {
            throw smokeFailure('COMMAND_APPROVAL_MISSING', 'Fixture run ended before requesting command approval');
          }
        }
        throw smokeFailure('COMMAND_APPROVAL_MISSING', 'Fixture journal ended before requesting command approval');
      });
    } finally { approvalController.abort(); }
    report.checks.commandApprovalRequested = true;
    const pending = await dispatch('session.getSnapshot', { sessionId: session.id });
    const approval = await step('approval.verify', () => verifyFixtureApproval(approvalEvent, pending, workspace, session.id, receipt.runId));
    report.checks.commandApprovalVerified = true;
    const decision = await dispatch('approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
    await step('approval.decision.verify', () => {
      assert.equal(decision.id, approval.id);
      assert.equal(decision.status, 'allowed');
      assert.equal(decision.fingerprint, approval.fingerprint);
    });
    report.checks.commandApproved = true;
    const run = await step('run.wait', () => engine.waitForRun(receipt.runId));
    assert.equal(run.state, 'completed', 'Scripted run must complete');
    report.checks.scriptedRunCompleted = true;
    const snapshot = await dispatch('session.getSnapshot', { sessionId: session.id });
    assert.equal(snapshot.session.id, session.id);
    assert.equal(snapshot.runs.find((item) => item.id === receipt.runId)?.state, 'completed');
    assert(snapshot.messages.some((message) =>
      message.runId === receipt.runId && message.role === 'assistant' && message.content === EXPECTED_REPLY),
    'Snapshot must contain the scripted assistant reply');
    assert(snapshot.lastSeq > 0, 'Snapshot must include committed journal events');
    report.checks.snapshotVerified = true;
    const commandTool = await step('command.verify', () => verifyCompletedCommand(snapshot, approval, receipt.runId));
    report.checks.commandCompleted = true;
    report.checks.commandOutputVerified = true;

    const controller = new AbortController();
    const events = [];
    try {
      await step('events.replay', async () => {
        for await (const event of engine.subscribe(session.id, 0, controller.signal)) {
          assert.equal(event.sessionId, session.id);
          assert(event.seq > (events.at(-1)?.seq ?? 0), 'Replayed sequence must increase');
          events.push(event);
          assert(events.length <= 100, 'Scripted smoke event replay must remain bounded');
          if (event.seq >= snapshot.lastSeq) break;
        }
      });
    } finally {
      controller.abort();
    }
    assert.equal(events.at(-1)?.seq, snapshot.lastSeq, 'Replay must reach the snapshot cursor');
    report.checks.journalReplayed = true;
    const diff = await dispatch('review.getDiff', { runId: receipt.runId });
    let commandEvent;
    const checkpoint = await step('command.evidence.verify', () => {
      const completions = events.filter((event) => event.type === 'tool.completed' && event.runId === receipt.runId && event.payload.toolCallId === commandTool.id);
      assert.equal(completions.length, 1, 'The journal must contain one command completion');
      commandEvent = completions[0];
      assert.equal(commandEvent.payload.name, 'run_command');
      assert.equal(commandEvent.payload.providerToolCallId, PROVIDER_TOOL_CALL_ID);
      assert.equal(commandEvent.payload.cleanupConfirmed, true, 'The journal must confirm process cleanup');
      assert.equal(commandEvent.payload.isError, false);
      assert.equal(commandEvent.payload.truncated, false);
      assert.equal(commandEvent.payload.output, commandTool.output);
      report.checks.commandCleanupConfirmed = true;
      const recorded = verifyCommandCheckpoint(diff, receipt.runId, commandTool.id);
      const changed = events.filter((event) => event.type === 'workspace.changed' && event.runId === receipt.runId && event.payload.checkpointId === recorded.id);
      assert.equal(changed.length, 1, 'The journal must reference the command checkpoint');
      assert.equal(changed[0].payload.toolCallId, commandTool.id);
      assert.equal(changed[0].payload.kind, 'command');
      assert.equal(changed[0].payload.incomplete, false);
      return recorded;
    });
    report.checks.commandCheckpointVerified = true;
    report.run = { runId: receipt.runId, state: run.state, lastSeq: snapshot.lastSeq, replayedEvents: events.length };
    report.command = { command: EXPECTED_COMMAND, marker: COMMAND_MARKER, approvalId: approval.id, toolCallId: commandTool.id, checkpointId: checkpoint.id, cleanupConfirmed: true };

    await step('engine.close', () => engine.close());
    engine = undefined;
    report.checks.engineClosed = true;
    engine = await step('engine.reopen', () => createEngine(engineOptions));
    const persisted = await dispatch('session.getSnapshot', { sessionId: session.id });
    assert.equal(persisted.lastSeq, snapshot.lastSeq, 'Reopening must preserve the committed cursor');
    assert.equal(persisted.runs.find((item) => item.id === receipt.runId)?.state, 'completed');
    assert(persisted.messages.some((message) => message.role === 'assistant' && message.content === EXPECTED_REPLY));
    report.checks.persistedSnapshotVerified = true;
    const persistedDiff = await dispatch('review.getDiff', { runId: receipt.runId });
    await step('command.persisted.verify', () => {
      assert.deepEqual(verifyCompletedCommand(persisted, approval, receipt.runId), commandTool);
      assert.deepEqual(verifyCommandCheckpoint(persistedDiff, receipt.runId, commandTool.id), checkpoint);
    });
    const persistedController = new AbortController();
    try {
      await step('command.persisted.replay', async () => {
        for await (const event of engine.subscribe(session.id, commandEvent.seq - 1, persistedController.signal)) {
          assert.deepEqual(event, commandEvent, 'The persisted journal must retain confirmed command cleanup');
          return;
        }
        throw smokeFailure('COMMAND_EVENT_MISSING', 'The persisted command completion event was not replayed');
      });
    } finally { persistedController.abort(); }
    report.checks.commandEvidencePersisted = true;
    await step('engine.reopened.close', () => engine.close());
    engine = undefined;
    report.checks.reopenedEngineClosed = true;
    report.ok = true;
  } catch (error) {
    report.error = failure(error, stage);
    if (stage === 'sqlite' && !report.checks.sqliteAvailable) report.error.code = 'SQLITE_UNAVAILABLE';
  } finally {
    if (engine) {
      try {
        await deadline(Promise.resolve().then(() => engine.close()), 2_000, 'engine.cleanup');
      } catch (error) {
        cleanupErrors.push(failure(error, 'engine.cleanup'));
      }
    }
    if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
    report.elapsedMs = Date.now() - started;
  }
  return report;
}

function parseArguments(args) {
  const names = new Map([
    ['--engine-entry', 'engineEntry'],
    ['--workspace', 'workspace'],
    ['--db', 'dbPath'],
    ['--artifacts', 'artifactDir'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    if (!name || !args[index + 1] || result[name] !== undefined) throw new Error('Invalid Electron smoke child arguments');
    result[name] = args[index + 1];
  }
  for (const name of ['engineEntry', 'workspace', 'dbPath', 'artifactDir']) {
    if (!result[name]) throw new Error(`Missing Electron smoke child option: ${name}`);
  }
  if (result.timeoutMs !== undefined) {
    const value = Number(result.timeoutMs);
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error('Invalid Electron smoke timeout');
    result.timeoutMs = value;
  }
  return result;
}

async function main() {
  let report;
  try {
    if (process.type !== 'utility' || !process.parentPort) {
      const error = new Error('This entry must run through Electron utilityProcess.fork');
      error.code = 'UTILITY_RUNTIME_REQUIRED';
      throw error;
    }
    report = await runEngineProbe(parseArguments(process.argv.slice(2)));
  } catch (error) {
    report = { schemaVersion: 1, type: REPORT_TYPE, ok: false, runtime: runtime(), error: failure(error, 'child.startup') };
  }
  if (process.parentPort) process.parentPort.postMessage(report);
  else process.stdout.write(`${JSON.stringify(report)}\n`);
  // The parent IPC port may keep a utility alive after all engine resources close.
  // Delay exit briefly so the final message is delivered before termination.
  setTimeout(() => process.exit(report.ok ? 0 : 1), 25);
}

module.exports = { REPORT_TYPE, EXPECTED_REPLY, EXPECTED_COMMAND, COMMAND_MARKER, COMMAND_TIMEOUT_MS, runEngineProbe, parseArguments };
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
