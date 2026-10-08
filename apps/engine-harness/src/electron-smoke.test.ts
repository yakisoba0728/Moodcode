import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const mainEntry = fileURLToPath(new URL('../../../scripts/electron-smoke.cjs', import.meta.url));
const childEntry = fileURLToPath(new URL('../../../scripts/electron-engine-child.cjs', import.meta.url));
const commandEvidenceChecks = [
  'commandApprovalRequested', 'commandApprovalVerified', 'commandApproved', 'commandCompleted',
  'commandOutputVerified', 'commandCleanupConfirmed', 'commandCheckpointVerified', 'commandEvidencePersisted',
] as const;

interface SmokeError { code: string; message: string; stage: string }
interface ChildReport {
  schemaVersion: 1;
  type: string;
  ok: boolean;
  runtime: { processType: string };
  checks?: Record<string, boolean>;
  run?: { replayedEvents: number };
  error?: SmokeError;
  cleanupErrors?: SmokeError[];
  elapsedMs?: number;
}
interface MainReport {
  ok: boolean;
  main: { windowsCreated: number; windowCount: number };
  fixtureRemoved?: boolean;
  error?: SmokeError;
  diagnosticsBytes?: number;
  diagnosticsTruncated?: boolean;
}
interface Fixture {
  root: string;
  engineEntry: string;
  workspace: string;
  dbPath: string;
  artifactDir: string;
  timeoutMs: number;
}
interface FixtureAudit {
  approvalDecisions: { approvalId: string; decision: string; fingerprint: string }[];
  closedEngines: number;
  submittedModes: string[];
}
const main = require(mainEntry) as {
  runSmoke(electron: unknown, options?: { timeoutMs?: number; engineEntry?: string }): Promise<MainReport>;
  timeoutFromEnvironment(value?: string): number;
};
const child = require(childEntry) as {
  REPORT_TYPE: string;
  runEngineProbe(options: Partial<Fixture>): Promise<ChildReport>;
  parseArguments(args: string[]): object;
};

// This double tests smoke orchestration. Engine SQLite persistence and actual
// Electron execution are verified by the separate test:electron command.
const fixtureSource = String.raw`
import assert from 'node:assert/strict';
export class ScriptedProvider {
  constructor(turns) { this.id = 'scripted'; this.turns = turns; }
}
const fixtureFault = null;
const expectedCommand = "printf 'moodcode-electron-command\\n'";
const commandMarker = 'moodcode-electron-command';
export const audit = {approvalDecisions: [], closedEngines: 0, submittedModes: []};
const snapshots = new Map();
const journals = new Map();
const checkpoints = new Map();
let workspace;
export function createEngine(options) {
  let closed = false;
  if (audit.closedEngines > 0) {
    const persisted = snapshots.get('session-fixture');
    if (fixtureFault === 'reopen-approval') persisted.approvals[0].status = 'pending';
    if (fixtureFault === 'reopen-tool') persisted.tools[0].state = 'interrupted';
    if (fixtureFault === 'reopen-checkpoint') checkpoints.set('run-fixture', []);
    if (fixtureFault === 'reopen-cleanup') journals.get('session-fixture').find(event => event.type === 'tool.completed').payload.cleanupConfirmed = false;
  }
  const turns = options.providers[0].turns;
  const call = turns[0].events.find(event => event.type === 'tool.call').call;
  const reply = turns[1].events.find(event => event.type === 'text.delta').delta;
  assert.equal(call.name, 'run_command');
  assert.equal(call.input.command, expectedCommand);
  assert.equal(call.input.timeoutMs, 5000);
  assert.equal(turns[0].events.at(-1).reason, 'tool_calls');
  assert.equal(turns[1].events.at(-1).reason, 'stop');
  return {
    async dispatch(command) {
      if (closed) throw new Error('closed engine used');
      let result;
      if (command.type === 'workspace.open') {
        workspace = {id: 'workspace-fixture', root: command.payload.path};
        result = workspace;
      }
      if (command.type === 'session.create') {
        result = {id: 'session-fixture', workspaceId: workspace.id};
        snapshots.set(result.id, {session: result, runs: [], messages: [], tools: [], approvals: [], lastSeq: 0});
      }
      if (command.type === 'run.submit') {
        audit.submittedModes.push(command.payload.config.mode);
        assert.equal(command.payload.config.mode, 'build');
        result = {runId: 'run-fixture'};
        const preview = {
          command: expectedCommand, cwd: workspace.root, timeoutMs: 5000,
          workspaceId: workspace.id, runId: result.runId, toolCallId: 'tool-fixture',
          platform: process.platform, termination: 'posix-process-group',
        };
        if (fixtureFault === 'preview-command') preview.command = 'printf different-command';
        if (fixtureFault === 'preview-cwd') preview.cwd = workspace.root + '/other';
        if (fixtureFault === 'preview-timeout') preview.timeoutMs = 6000;
        if (fixtureFault === 'preview-workspace') preview.workspaceId = 'other-workspace';
        if (fixtureFault === 'preview-run') preview.runId = 'other-run';
        if (fixtureFault === 'preview-tool-call') preview.toolCallId = 'other-tool';
        if (fixtureFault === 'preview-termination') preview.termination = 'unknown-process-tree';
        const approval = {
          id: 'approval-fixture', sessionId: 'session-fixture', runId: result.runId,
          toolCallId: 'tool-fixture', toolName: 'run_command', fingerprint: 'fixture-fingerprint',
          status: 'pending', preview,
        };
        const tool = {
          id: 'tool-fixture', runId: result.runId, sessionId: 'session-fixture',
          name: 'run_command', state: 'awaiting_approval', input: {command: expectedCommand, cwd: workspace.root, timeoutMs: 5000},
        };
        if (fixtureFault === 'tool-input') tool.input.command = 'printf different-command';
        if (fixtureFault === 'tool-timeout') tool.input.timeoutMs = 6000;
        const snapshot = snapshots.get('session-fixture');
        Object.assign(snapshot, {
          runs: [{id: result.runId, state: 'awaiting_approval'}],
          tools: [tool], approvals: [approval], lastSeq: 2,
        });
        const approvalPayload = {
          approvalId: approval.id, toolCallId: approval.toolCallId, toolName: approval.toolName,
          fingerprint: approval.fingerprint, status: approval.status, preview: structuredClone(preview),
        };
        if (fixtureFault === 'approval-fingerprint') approvalPayload.fingerprint = '';
        if (fixtureFault === 'snapshot-fingerprint') approval.fingerprint = 'different-fingerprint';
        if (fixtureFault === 'snapshot-resolved') approval.status = 'allowed';
        if (fixtureFault === 'missing-approval') snapshot.approvals = [];
        journals.set('session-fixture', [
          {seq: 1, sessionId: 'session-fixture', runId: result.runId, type: 'run.created', payload: {}},
          {seq: 2, sessionId: 'session-fixture', runId: fixtureFault === 'event-run' ? 'other-run' : result.runId, type: 'approval.requested', payload: approvalPayload},
        ]);
      }
      if (command.type === 'approval.decide') {
        audit.approvalDecisions.push(structuredClone(command.payload));
        assert.deepEqual(command.payload, {approvalId: 'approval-fixture', decision: 'allow', fingerprint: 'fixture-fingerprint'});
        const snapshot = snapshots.get('session-fixture');
        snapshot.approvals[0].status = 'allowed';
        snapshot.runs[0].state = 'completed';
        snapshot.tools[0].state = 'completed';
        snapshot.tools[0].output = 'Command completed; exitCode=0; signal=null; cleanupConfirmed=true.\nstdout:\n' + commandMarker + '\nstderr:\n';
        if (fixtureFault === 'tool-output') snapshot.tools[0].output = 'Command completed without marker';
        snapshot.messages.push({runId: 'run-fixture', role: 'assistant', content: reply});
        snapshot.lastSeq = 8;
        const checkpoint = {
          id: 'checkpoint-fixture', runId: 'run-fixture', toolCallId: 'tool-fixture',
          kind: 'command', files: [], warnings: [], incomplete: fixtureFault === 'checkpoint-incomplete',
        };
        checkpoints.set('run-fixture', fixtureFault === 'missing-checkpoint' ? [] : [checkpoint]);
        const completed = {
          toolCallId: 'tool-fixture', providerToolCallId: call.id, name: 'run_command',
          output: snapshot.tools[0].output, isError: false, truncated: false, cleanupConfirmed: true,
        };
        if (fixtureFault === 'missing-cleanup') delete completed.cleanupConfirmed;
        if (fixtureFault === 'uncertain-cleanup') completed.cleanupConfirmed = false;
        journals.get('session-fixture').push(
          {seq: 3, sessionId: 'session-fixture', runId: 'run-fixture', type: 'approval.resolved', payload: {approvalId: 'approval-fixture', status: 'allowed'}},
          {seq: 4, sessionId: 'session-fixture', runId: 'run-fixture', type: 'run.resumed', payload: {}},
          {seq: 5, sessionId: 'session-fixture', runId: 'run-fixture', type: fixtureFault === 'missing-checkpoint-event' ? 'other.event' : 'workspace.changed', payload: {checkpointId: checkpoint.id, kind: 'command', toolCallId: checkpoint.toolCallId, incomplete: false}},
          {seq: 6, sessionId: 'session-fixture', runId: 'run-fixture', type: 'tool.completed', payload: completed},
          {seq: 7, sessionId: 'session-fixture', runId: 'run-fixture', type: 'message.created', payload: {}},
          {seq: 8, sessionId: 'session-fixture', runId: 'run-fixture', type: 'run.completed', payload: {}},
        );
        result = snapshot.approvals[0];
      }
      if (command.type === 'session.getSnapshot') result = structuredClone(snapshots.get(command.payload.sessionId));
      if (command.type === 'review.getDiff') result = {runId: command.payload.runId, files: [], checkpoints: structuredClone(checkpoints.get(command.payload.runId)), warnings: []};
      return {schemaVersion: 1, commandId: command.commandId, ok: true, result};
    },
    async waitForRun() {
      assert.equal(audit.approvalDecisions.length, 1, 'The fixture run cannot complete before approval');
      return {state: 'completed'};
    },
    async *subscribe(sessionId, afterSeq, signal) {
      for (const event of journals.get(sessionId) ?? []) {
        if (signal.aborted) return;
        if (event.seq > afterSeq) yield structuredClone(event);
      }
    },
    async close() {
      if (closed) throw new Error('double close');
      closed = true;
      audit.closedEngines++;
    },
  };
}
`;

function faultyFixtureSource(fault: string): string {
  return fixtureSource.replace('const fixtureFault = null;', `const fixtureFault = ${JSON.stringify(fault)};`);
}

async function fixtureAudit(paths: Fixture): Promise<FixtureAudit> {
  const module = await import(pathToFileURL(paths.engineEntry).href) as { audit: FixtureAudit };
  return module.audit;
}

async function fixture(t: TestContext, source = fixtureSource): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-electron-probe-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engineEntry = join(root, 'engine-fixture.mjs');
  await writeFile(engineEntry, source);
  return { root, engineEntry, workspace: root, dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), timeoutMs: 1_000 };
}

test('Electron child probe approves only its exact fixture command and verifies cleanup, journal replay and reopen', async (t) => {
  const paths = await fixture(t);
  const report = await child.runEngineProbe(paths);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.runtime.processType, 'node', 'A Node fixture must not claim Electron utility compatibility');
  assert.ok(report.checks);
  assert.ok(Object.values(report.checks).every(Boolean));
  assert.equal(report.run?.replayedEvents, 8);
  assert.deepEqual(await fixtureAudit(paths), {
    approvalDecisions: [{approvalId: 'approval-fixture', decision: 'allow', fingerprint: 'fixture-fingerprint'}],
    submittedModes: ['build'],
    closedEngines: 2,
  });
});

test('Electron child probe bounds run wait and closes the engine after timeout', async (t) => {
  const source = fixtureSource.replace(
    'export const audit =',
    'const waiting = Promise.withResolvers();\nexport const waitBoundary = {entered: waiting.promise, calls: 0, beforeCreate() {}};\nexport const audit =',
  ).replace(
    'export function createEngine(options) {',
    'export function createEngine(options) { waitBoundary.beforeCreate();',
  ).replace(
    "return {state: 'completed'};",
    'waitBoundary.calls++; waiting.resolve(); return new Promise(() => {});',
  );
  const paths = await fixture(t, source);
  const { waitBoundary } = await import(pathToFileURL(paths.engineEntry).href) as {
    waitBoundary: {entered: Promise<void>; calls: number; beforeCreate(): void};
  };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    // Spend part of the original global budget before run.wait. A per-step
    // timeout reset would not expire at the final ten-millisecond boundary.
    waitBoundary.beforeCreate = () => t.mock.timers.tick(40);
    let settled = false;
    const pending = child.runEngineProbe({ ...paths, timeoutMs: 50 }).then(report => { settled = true; return report; });
    await Promise.race([
      waitBoundary.entered,
      pending.then(report => assert.fail(`Probe ended before run.wait: ${JSON.stringify(report)}`)),
    ]);
    assert.equal(waitBoundary.calls, 1, 'Advance the clock only after the actual waitForRun boundary');
    assert.equal(Date.now(), 40);
    t.mock.timers.tick(9);
    await Promise.resolve();
    assert.equal(settled, false, 'The original whole-probe deadline must not expire early');
    assert.equal((await fixtureAudit(paths)).closedEngines, 0);
    t.mock.timers.tick(1);
    await new Promise<void>(done => setImmediate(done));
    assert.equal(settled, true, 'The original deadline must settle the probe and cleanup at 50ms');
    const report = await pending;
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'SMOKE_TIMEOUT');
    assert.equal(report.error?.stage, 'run.wait');
    assert.equal(report.cleanupErrors, undefined);
    assert.equal(report.elapsedMs, 50, 'Earlier stages and run wait share one original deadline');
    assert.equal(report.checks?.commandApproved, true);
    assert.equal(report.checks?.scriptedRunCompleted, false);
    assert.equal((await fixtureAudit(paths)).closedEngines, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('Electron child never autoapproves a changed command preview, scope or pending request', async (t) => {
  for (const fault of [
    'preview-command', 'preview-cwd', 'preview-timeout', 'preview-workspace', 'preview-run',
    'preview-tool-call', 'approval-fingerprint', 'snapshot-fingerprint', 'snapshot-resolved',
    'missing-approval', 'tool-input', 'event-run', 'preview-termination', 'tool-timeout',
  ]) {
    await t.test(fault, async (t) => {
      const paths = await fixture(t, faultyFixtureSource(fault));
      const report = await child.runEngineProbe(paths);
      assert.equal(report.ok, false, JSON.stringify(report));
      assert.equal(report.error?.code, 'ERR_ASSERTION');
      assert.deepEqual((await fixtureAudit(paths)).approvalDecisions, [], 'Unmatched fixture metadata must not reach approval.decide');
      assert.equal((await fixtureAudit(paths)).closedEngines, 1);
      assert.equal(report.cleanupErrors, undefined);
    });
  }
});

test('Electron child requires command output, positive cleanup evidence and a complete command checkpoint', async (t) => {
  for (const fault of [
    'tool-output', 'missing-cleanup', 'uncertain-cleanup', 'missing-checkpoint',
    'checkpoint-incomplete', 'missing-checkpoint-event',
  ]) {
    await t.test(fault, async (t) => {
      const paths = await fixture(t, faultyFixtureSource(fault));
      const report = await child.runEngineProbe(paths);
      assert.equal(report.ok, false, JSON.stringify(report));
      assert.equal(report.error?.code, 'ERR_ASSERTION');
      assert.equal((await fixtureAudit(paths)).approvalDecisions.length, 1);
      assert.equal((await fixtureAudit(paths)).closedEngines, 1);
      assert.equal(report.cleanupErrors, undefined);
    });
  }
});

test('Electron child verifies approved command state and its checkpoint after reopening', async (t) => {
  for (const fault of ['reopen-approval', 'reopen-tool', 'reopen-checkpoint', 'reopen-cleanup']) {
    await t.test(fault, async (t) => {
      const paths = await fixture(t, faultyFixtureSource(fault));
      const report = await child.runEngineProbe(paths);
      assert.equal(report.ok, false, JSON.stringify(report));
      assert.equal(report.error?.code, 'ERR_ASSERTION');
      assert.equal((await fixtureAudit(paths)).approvalDecisions.length, 1, 'Reopening must not request another approval or replay the command');
      assert.equal((await fixtureAudit(paths)).closedEngines, 2);
      assert.equal(report.cleanupErrors, undefined);
    });
  }
});

test('Electron child probe preserves engine command error and its failing stage', async (t) => {
  const source = fixtureSource.replace('let result;', "return {ok: false, error: {code: 'WORKSPACE_BUSY', message: 'fixture busy'}}; let result;");
  const report = await child.runEngineProbe(await fixture(t, source));
  assert.equal(report.error?.code, 'WORKSPACE_BUSY');
  assert.equal(report.error?.stage, 'workspace.open');
  assert.equal(report.checks?.sqliteQuery, true);
  assert.equal(report.cleanupErrors, undefined);
});

test('Electron child probe detects a missing built-in SQLite before importing the engine', () => {
  // Isolate the simulated missing built-in in a subprocess rather than patching
  // the loader used by the default test runner or other concurrently run files.
  const program = `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'node:sqlite') {
        const error = new Error('node:sqlite unavailable fixture');
        error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw error;
      }
      return original.call(this, name, ...args);
    };
    require(${JSON.stringify(childEntry)}).runEngineProbe({}).then(report => {
      process.stdout.write(JSON.stringify(report));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 2_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ChildReport;
  assert.equal(report.error?.code, 'SQLITE_UNAVAILABLE');
  assert.equal(report.error?.stage, 'sqlite');
  assert.equal(report.checks?.sqliteAvailable, false);
  assert.equal(report.checks?.compiledEngineImported, false);
});

test('Electron smoke entries reject direct Node execution with exactly one JSON report', () => {
  for (const [entry, code] of [[mainEntry, 'ELECTRON_MAIN_RUNTIME_REQUIRED'], [childEntry, 'UTILITY_RUNTIME_REQUIRED']]) {
    assert.ok(entry);
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 2_000 });
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]!) as ChildReport;
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, code);
  }
});

test("direct Node runtime rejection precedes loading the Electron npm installer shim", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "moodcode-electron-no-install-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "deny-electron.cjs");
  await writeFile(
    preload,
    `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(name==='electron')throw new Error('Electron installer shim must not load under Node');return load.call(this,name,...args);};`,
  );
  const result = spawnSync(
    process.execPath,
    ["--require", preload, mainEntry],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(
    result.error,
    undefined,
    result.error?.message ??
      "Direct Node runtime must reject without installing Electron",
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]!) as ChildReport;
  assert.equal(report.ok, false);
  assert.equal(report.error?.code, "ELECTRON_MAIN_RUNTIME_REQUIRED");
});

test('Electron launch arguments reject missing, duplicate and credential parameters', () => {
  assert.throws(() => child.parseArguments(['--db']));
  assert.throws(() => child.parseArguments(['--db', 'one', '--db', 'two']));
  assert.throws(() => child.parseArguments(['--api-key', 'fixture-secret']));
  assert.throws(() => main.timeoutFromEnvironment('Infinity'));
  assert.throws(() => main.timeoutFromEnvironment('1'));
  assert.equal(main.timeoutFromEnvironment(), 20_000);
});

type Behavior = 'report' | 'invalid' | 'duplicate' | 'no-report' | 'hang' | 'window';
class FakeUtility extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}
function fakeElectron(report?: Partial<ChildReport>, behavior: Behavior = 'report') {
  const app = Object.assign(new EventEmitter(), { whenReady: async (): Promise<void> => {} });
  let utility: FakeUtility | undefined;
  let windowDestroyed = false;
  const utilityProcess = {
    fork(_entry: string, _args: string[], options: { stdio: string }) {
      assert.equal(options.stdio, 'pipe');
      utility = new FakeUtility();
      const active = utility;
      if (behavior !== 'hang') setImmediate(() => {
        if (behavior === 'window') app.emit('browser-window-created', {}, { destroy: () => { windowDestroyed = true; } });
        if (behavior === 'invalid') active.emit('message', { bad: true });
        else if (behavior !== 'no-report') {
          active.emit('message', report);
          if (behavior === 'duplicate') active.emit('message', report);
        }
        active.emit('exit', report?.ok ? 0 : 1);
      });
      return active;
    },
  };
  return {
    app,
    BrowserWindow: { getAllWindows: () => [] },
    utilityProcess,
    get utility() { return utility; },
    get windowDestroyed() { return windowDestroyed; },
  };
}
function successfulChildReport(): Partial<ChildReport> {
  return {
    schemaVersion: 1, type: child.REPORT_TYPE, ok: true, runtime: { processType: 'utility' },
    checks: { sqliteQuery: true, ...Object.fromEntries(commandEvidenceChecks.map((name) => [name, true])) },
  };
}

test('Electron parent propagates child failure, verifies runtime marker and removes its temporary fixture', async () => {
  const success = successfulChildReport();
  const passed = await main.runSmoke(fakeElectron(success), { timeoutMs: 1_000 });
  assert.equal(passed.ok, true);
  assert.equal(passed.fixtureRemoved, true);
  assert.equal(passed.main.windowsCreated, 0);
  const failed = await main.runSmoke(fakeElectron({
    ...success,
    ok: false,
    error: { code: 'SQLITE_UNAVAILABLE', stage: 'sqlite', message: 'fixture unavailable' },
  }), { timeoutMs: 1_000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, 'SQLITE_UNAVAILABLE');
  assert.equal(failed.fixtureRemoved, true);
  const forged = await main.runSmoke(fakeElectron({ ...success, runtime: { processType: 'node' } }), { timeoutMs: 1_000 });
  assert.equal(forged.error?.code, 'UTILITY_RUNTIME_UNVERIFIED');
});

test('Electron parent rejects malformed, duplicate and absent reports and stops the utility', async () => {
  for (const [behavior, code] of [
    ['invalid', 'INVALID_CHILD_REPORT'],
    ['duplicate', 'DUPLICATE_CHILD_REPORT'],
    ['no-report', 'UTILITY_NO_REPORT'],
  ] as const) {
    const electron = fakeElectron(successfulChildReport(), behavior);
    const report = await main.runSmoke(electron, { timeoutMs: 1_000 });
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, code);
    assert.equal(report.fixtureRemoved, true);
    assert.equal(electron.utility?.killed, true);
  }
});

test('Electron parent rejects a successful child report if any command evidence is absent or false', async (t) => {
  for (const name of commandEvidenceChecks) {
    await t.test(name, async () => {
      for (const value of [undefined, false]) {
        const report = successfulChildReport();
        assert.ok(report.checks);
        if (value === undefined) delete report.checks[name];
        else report.checks[name] = value;
        const result = await main.runSmoke(fakeElectron(report), { timeoutMs: 1_000 });
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, 'UTILITY_COMMAND_UNVERIFIED');
        assert.equal(result.error?.stage, 'utility.verify');
        assert.equal(result.fixtureRemoved, true);
        assert.equal(result.main.windowsCreated, 0);
      }
    });
  }
});

test('Electron parent fails if any BrowserWindow is created', async () => {
  const electron = fakeElectron(successfulChildReport(), 'window');
  const report = await main.runSmoke(electron, { timeoutMs: 1_000 });
  assert.equal(report.ok, false);
  assert.equal(report.error?.code, 'UNEXPECTED_BROWSER_WINDOW');
  assert.equal(report.main.windowsCreated, 1);
  assert.equal(report.main.windowCount, 0);
  assert.equal(electron.windowDestroyed, true);
});

test('Electron parent startup deadline and signal cleanup are bounded', async () => {
  const electron = fakeElectron(undefined, 'hang');
  electron.app.whenReady = () => new Promise(() => {});
  const timedOut = await main.runSmoke(electron, { timeoutMs: 50 });
  assert.equal(timedOut.error?.code, 'SMOKE_TIMEOUT');
  assert.equal(timedOut.error?.stage, 'main.startup');
  const signalListeners = process.listenerCount('SIGTERM');
  const pending = main.runSmoke(electron, { timeoutMs: 1_000 });
  setImmediate(() => process.emit('SIGTERM'));
  const signalled = await pending;
  assert.equal(signalled.error?.code, 'SMOKE_INTERRUPTED');
  assert.equal(process.listenerCount('SIGTERM'), signalListeners);
});
