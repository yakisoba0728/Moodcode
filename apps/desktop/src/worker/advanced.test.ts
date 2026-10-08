import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createEngine } from '@moodcode/engine';
import type { JsonObject, JsonValue, Session, Workspace, RunReceipt } from '@moodcode/contracts';
import { AdvancedService, ADVANCED_LIMITS } from './advanced.js';
import { AdvancedFixtureProvider } from './fixtures.js';
import type { DesktopAdvancedPreview, DesktopAdvancedActionType } from '../shared/advanced.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-advanced-')), repository = join(directory, 'repo');
  await mkdir(repository); await writeFile(join(repository, 'sample.ts'), 'const value: number = "fixture";\n');
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, 'add', 'sample.ts']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [new AdvancedFixtureProvider()],
    defaults: { providerId: 'scripted', modelId: 'desktop-advanced-fixture', mode: 'build' }, teams: true, teamModelTools: true, residentTeams: true, workflows: true, jobs: true, diagnosticObservations: true });
  const advanced = new AdvancedService(engine);
  t.after(async () => { await advanced.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => {
    const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result as T;
  };
  const workspace = await command<Workspace>('workspace.open', { path: repository });
  const session = await command<Session>('session.create', { workspaceId: workspace.id });
  const action = async <T = JsonValue>(type: DesktopAdvancedActionType, payload: JsonObject = {}, owner = 'window'): Promise<T> => advanced.action(owner, { sessionId: session.id, type, payload }) as Promise<T>;
  return { directory, repository, engine, advanced, command, workspace, session, action };
}
async function until<T>(operation: () => Promise<T> | T, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { const result = await operation(); if (ready(result)) return result; await delay(15); }
  throw new Error('Native fixture did not reach its expected state.');
}
const code = (expected: string) => (error: unknown): boolean => error instanceof Error && (error as Error & { code?: string }).code === expected;

test('native inbox, revisioned tasks and exact question answer connect to committed engine state', async t => {
  const f = await fixture(t);
  await f.action('session.pause');
  const input = await f.action<{ inputId: string }>('input.accept', { prompt: 'pending input', delivery: 'queue' });
  const pending = await f.advanced.snapshot(f.session.id);
  assert.equal((pending.control as JsonObject).paused, true);
  assert.equal(((pending.inbox as JsonObject).inputs as JsonValue[]).length, 1);
  await f.action('input.cancel', { inputId: input.inputId });
  const tasks = await f.action<JsonObject>('tasks.replace', { expectedRevision: 0, tasks: [{ id: 'verify', title: 'Verify native host', status: 'pending' }] });
  assert.equal(tasks.revision, 1);
  await assert.rejects(f.action('tasks.replace', { expectedRevision: 0, tasks: [] }), code('REVISION_CONFLICT'));
  await f.action('session.resume');
  const receipt = await f.command<RunReceipt>('run.submit', { sessionId: f.session.id, requestId: randomUUID(), prompt: 'native question fixture' });
  const questions = await until(async () => (await f.advanced.snapshot(f.session.id)).questions as JsonObject[], values => values.some(value => value.status === 'pending'));
  const question = questions.find(value => value.status === 'pending')!;
  await assert.rejects(f.action('question.answer', { questionId: question.id!, version: Number(question.version) + 1, answer: { optionIds: ['continue'] } }), code('QUESTION_CONFLICT'));
  await f.action('question.answer', { questionId: question.id!, version: question.version!, answer: { optionIds: ['continue'] } });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const diagnostics = (await f.advanced.snapshot(f.session.id)).diagnostics as JsonObject;
  assert.ok(Array.isArray((diagnostics.executionObservations as JsonObject).items));
  assert.ok(((diagnostics.executionObservations as JsonObject).items as JsonValue[]).length > 0);
});

test('private previews reject JSON copies, foreign owners, duplicate starts and owner reload', async t => {
  const f = await fixture(t), preview = await f.action<DesktopAdvancedPreview>('terminal.preview', { file: '/bin/sh', args: ['-c', 'printf native-terminal'] });
  await assert.rejects(f.action('terminal.create', { handleId: preview.handleId, approved: true }, 'foreign'), code('DESKTOP_HANDLE_INVALID'));
  await assert.rejects(f.action('terminal.create', { handleId: randomUUID(), approved: true, preview: preview.preview }), code('INVALID_INPUT'));
  const requests = await Promise.allSettled([f.action<{ terminal: { id: string }; handleId: string }>('terminal.create', { handleId: preview.handleId, approved: true }), f.action('terminal.create', { handleId: preview.handleId, approved: true })]);
  assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
  const created = (requests.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ terminal: { id: string }; handleId: string }>).value;
  const output = await until(() => f.action<JsonObject>('terminal.read', { terminalId: created.terminal.id }), value => JSON.stringify(value.output).includes('native-terminal'));
  assert.equal((output.terminal as JsonObject).owner && ((output.terminal as JsonObject).owner as JsonObject).sessionId, f.session.id);
  await f.advanced.dropOwner('window');
  assert.equal(f.advanced.handleCount, 0);
  await assert.rejects(f.action('terminal.attach', { terminalId: created.terminal.id, approved: true }), code('DESKTOP_OWNER_DROPPED'));
  const control = await f.action<DesktopAdvancedPreview>('terminal.attach', { terminalId: created.terminal.id, approved: true }, 'reloaded');
  await f.action('terminal.cancel', { handleId: control.handleId }, 'reloaded');
});

test('exact executable source drift refuses launch and handle storage remains bounded', async t => {
  const f = await fixture(t), executable = join(f.directory, 'selected-executable');
  await writeFile(executable, '#!/bin/sh\nprintf original'); await chmod(executable, 0o700);
  const preview = await f.action<DesktopAdvancedPreview>('terminal.preview', { file: executable });
  await writeFile(executable, '#!/bin/sh\nprintf substituted');
  await assert.rejects(f.action('terminal.create', { handleId: preview.handleId, approved: true }), code('DESKTOP_SOURCE_STALE'));
  assert.equal(((await f.advanced.snapshot(f.session.id)).terminals as JsonValue[]).length, 0);
  for (let index = 0; index < ADVANCED_LIMITS.ownerHandles; index++) await f.action('mcp.preview', { id: `fixture${index}`, transport: 'http', url: 'https://example.invalid/mcp' });
  await assert.rejects(f.action('mcp.preview', { id: 'overflow', transport: 'http', url: 'https://example.invalid/mcp' }), code('DESKTOP_HANDLE_LIMIT'));
  assert.equal(f.advanced.handleCount, ADVANCED_LIMITS.ownerHandles);
  await f.advanced.dropOwner('window'); assert.equal(f.advanced.handleCount, 0);
});

test('native MCP discovery, disconnect and explicit reconnect retain catalog consumption', async t => {
  const f = await fixture(t), server = join(f.directory, 'mcp.mjs');
  await writeFile(server, `import readline from 'node:readline'; const lines=readline.createInterface({input:process.stdin}); lines.on('line',line=>{const r=JSON.parse(line); if(r.id===undefined)return; const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:r.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:r.method==='resources/list'?{resources:[]}:{content:[{type:'text',text:'native mcp result'}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
  const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'fixture', transport: 'stdio', file: process.execPath, args: [server], protocolVersion: '2025-11-25' });
  const connected = await f.action<JsonObject>('mcp.connect', { handleId: preview.handleId, approved: true });
  assert.deepEqual(connected.toolNames, ['mcp_fixture_echo']);
  assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'mcp_fixture_echo'));
  const earlier = await f.command<RunReceipt>('run.submit', { sessionId: f.session.id, requestId: randomUUID(), prompt: 'desktop child fixture' });
  assert.equal((await f.engine.waitForRun(earlier.runId)).state, 'completed');
  assert.ok(f.engine.store.getLastRunAssistantContent(earlier.runId).includes('fixture child result'));
  const receipt = await f.command<RunReceipt>('run.submit', { sessionId: f.session.id, requestId: randomUUID(), prompt: 'desktop MCP fixture' });
  const approval = await until(() => f.engine.store.getSnapshot(f.session.id).approvals.find(value => value.toolName === 'mcp_fixture_echo' && value.status === 'pending'), value => !!value);
  assert.ok(approval);
  await f.command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const snapshot = f.engine.store.getSnapshot(f.session.id);
  assert.ok(snapshot.tools.some(tool => tool.name === 'mcp_fixture_echo' && tool.state === 'completed' && tool.output?.includes('native mcp result')));
  assert.ok(f.engine.getMcpExecution(f.session.id, approval.toolCallId));
  await f.action('mcp.disconnect', { id: 'fixture' });
  assert.ok(f.engine.getCapabilities().tools.every(tool => tool.name !== 'mcp_fixture_echo'));
  const followup = await f.command<RunReceipt>('run.submit', { sessionId: f.session.id, requestId: randomUUID(), prompt: 'Ask the current desktop question after MCP disconnect' });
  const question = await until(() => f.engine.questions.list(f.session.id).find(value => value.runId === followup.runId && value.status === 'pending'), value => !!value);
  assert.ok(question);
  await f.action('question.answer', { questionId: question.id, version: question.version, answer: { optionIds: ['continue'] } });
  assert.equal((await f.engine.waitForRun(followup.runId)).state, 'completed');
  assert.equal(f.engine.store.getLastRunAssistantContent(followup.runId), 'The desktop fixture received the answer.');
  const reconnect = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'fixture', transport: 'stdio', file: process.execPath, args: [server], protocolVersion: '2025-11-25' });
  await f.action('mcp.connect', { handleId: reconnect.handleId, approved: true });
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, 1);
});

test('registered native LSP launches explicitly and diagnostics follow the current document version', async t => {
  const f = await fixture(t), server = join(f.directory, 'lsp.mjs');
  await writeFile(server, `let b=Buffer.alloc(0); const send=p=>{const j=JSON.stringify(p);process.stdout.write('Content-Length: '+Buffer.byteLength(j)+'\\r\\n\\r\\n'+j)}; process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){const i=b.indexOf('\\r\\n\\r\\n');if(i<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(b.subarray(0,i).toString())?.[1]);if(b.length<i+4+n)return;const r=JSON.parse(b.subarray(i+4,i+4+n));b=b.subarray(i+4+n);if(r.id!==undefined){send({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{capabilities:{textDocumentSync:2}}:null});}else if(r.method==='textDocument/didOpen'||r.method==='textDocument/didChange'){const d=r.params.textDocument;send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,version:d.version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:5}},severity:1,message:'native diagnostic '+d.version}]}});}else if(r.method==='exit')process.exit(0);}});`);
  const preview = await f.action<DesktopAdvancedPreview>('lsp.preview', { id: 'fixture-lsp', file: process.execPath, args: [server], extensions: { '.ts': 'typescript' } });
  await f.action('lsp.connect', { handleId: preview.handleId, approved: true });
  const first = await until(() => f.action<JsonObject[]>('lsp.diagnostics', { path: 'sample.ts' }), values => JSON.stringify(values).includes('native diagnostic 1'));
  assert.equal((first[0]!.snapshot as JsonObject).documentVersion, 1);
  await writeFile(join(f.repository, 'sample.ts'), 'const value = 42;\n');
  const changed = await until(() => f.action<JsonObject[]>('lsp.diagnostics', { path: 'sample.ts' }), values => JSON.stringify(values).includes('native diagnostic 2'));
  assert.equal((changed[0]!.snapshot as JsonObject).documentVersion, 2);
  assert.notEqual((changed[0]!.snapshot as JsonObject).documentHash, (first[0]!.snapshot as JsonObject).documentHash);
});

test('actual child, team owner, mailbox Original and workflow stage use native reservations', async t => {
  const f = await fixture(t);
  const childWorktree = await f.action<JsonObject>('worktree.create');
  const workflowWorktree = await f.action<JsonObject>('worktree.create');
  const parent = await f.command<RunReceipt>('run.submit', { sessionId: f.session.id, requestId: randomUUID(), prompt: 'live parent for native descendants' });
  await until(() => f.engine.questions.list(f.session.id), values => values.some(value => value.status === 'pending'));
  await f.action('session.pause');
  const queued = await f.action<JsonObject>('input.accept', { prompt: 'Queued GUI request', delivery: 'queue' });
  await f.action('input.cancel', { inputId: queued.inputId! });
  await f.action('input.accept', { prompt: 'Steered GUI request', delivery: 'steer' });
  await assert.rejects(f.action('child.preview', { parentRunId: parent.runId, worktreeId: childWorktree.id!, prompt: 'desktop child fixture' }), code('RESIDENT_PARENT_STALE'));
  assert.equal(f.engine.children.tasks.list(f.session.id).length, 0);
  await f.action('session.resume');
  const child = await f.action<DesktopAdvancedPreview>('child.preview', { parentRunId: parent.runId, worktreeId: childWorktree.id!, prompt: 'desktop child fixture', tools: ['read_file'], allocation: { turns: 2, toolCalls: 8, outputBytes: 8192, durationMs: 30_000 } });
  const started = await f.action<JsonObject>('child.start', { handleId: child.handleId, approved: true });
  await until(() => f.engine.inspectResidentChildTask(f.session.id, started.id as string), value => value?.runs[0]?.state === 'completed');
  assert.equal(started.parentRunId, parent.runId);
  await f.action('child.cancel', { taskId: started.id! });
  assert.equal(f.engine.inspectResidentChildTask(f.session.id, started.id as string)?.state, 'closed');
  const team = await f.action<JsonObject>('team.create', { teamId: 'fixture-team' });
  assert.equal((team.record as JsonObject).id, 'fixture-team');
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const member = await f.action<DesktopAdvancedPreview>('team.member.preview', { teamId: 'fixture-team', memberId: 'root', role: 'coordinator', permissions: { send: true, receive: true, claimTasks: true, manageTasks: true }, expectedRevision: 0, expiresAt });
  const joined = await f.action<JsonObject>('team.member.join', { handleId: member.handleId, approved: true });
  const generation = (joined.record as JsonObject).generation!;
  const put = await f.action<JsonObject>('team.tasks.put', { teamId: 'fixture-team', memberId: 'root', generation, taskId: 'fixture-task', expectedRevision: 0, title: 'Native task', description: 'Fixture', dependencies: [], expiresAt });
  const claimed = await f.action<JsonObject>('team.tasks.claim', { teamId: 'fixture-team', memberId: 'root', generation, taskId: 'fixture-task', expectedRevision: (put.record as JsonObject).revision! });
  const completedTask = await f.action<JsonObject>('team.tasks.complete', { teamId: 'fixture-team', memberId: 'root', generation, taskId: 'fixture-task', expectedRevision: (claimed.record as JsonObject).revision! });
  assert.equal((completedTask.record as JsonObject).state, 'completed');
  await f.action('team.message.send', { teamId: 'fixture-team', senderMemberId: 'root', senderGeneration: generation, recipientMemberId: 'root', recipientGeneration: generation, text: 'Native mailbox', expiresAt });
  const mailbox = await f.action<DesktopAdvancedPreview>('team.mailbox.read', { teamId: 'fixture-team', memberId: 'root', generation });
  assert.ok(JSON.stringify(mailbox.preview).includes('Native mailbox'));
  await f.action('team.mailbox.claim', { handleId: mailbox.handleId, expectedCursorRevision: ((mailbox.preview as JsonObject).cursor as JsonObject).revision! });
  const schema = { type: 'object', properties: { summary: { type: 'string', maxLength: 1024 } }, required: ['summary'], additionalProperties: false };
  const model = { providerId: 'scripted', modelId: 'desktop-advanced-fixture' };
  const spec = { schemaVersion: 1, id: 'fixture-workflow', description: 'Native planner', parameterSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, resultSchema: schema,
    stages: [{ id: 'plan', role: 'planner', dependsOn: [], join: 'all', prompt: 'desktop child fixture', profile: null, model, tools: ['read_file'], allocation: { turns: 2, toolCalls: 2, outputBytes: 8192, durationMs: 20_000 }, resultSchema: schema }], resultStageId: 'plan' };
  await f.action('workflow.register', { spec, expectedRevision: 0 });
  const workflow = await f.action<DesktopAdvancedPreview>('workflow.preview', { parentRunId: parent.runId, workflowId: 'fixture-workflow', expectedSpecRevision: 1, parameters: {}, stageWorktrees: { plan: workflowWorktree.id! } });
  const instance = (await f.action<JsonObject>('workflow.start', { handleId: workflow.handleId, approved: true })).record as JsonObject;
  const admitted = (await f.action<JsonObject>('workflow.stage.start', { instanceId: instance.instanceId!, stageId: 'plan', expectedRevision: instance.revision!, approved: true })).record as JsonObject;
  const completed = (await f.action<JsonObject>('workflow.stage.observe', { instanceId: instance.instanceId!, stageId: 'plan', expectedRevision: admitted.revision! })).record as JsonObject;
  assert.equal(completed.state, 'completed');
  assert.ok(JSON.stringify(completed).includes('fixture child result'));
  const snapshot = await f.advanced.snapshot(f.session.id);
  assert.equal((snapshot.teams as JsonValue[]).length, 1);
  assert.equal(((snapshot.workflows as JsonObject).instances as JsonValue[]).length, 1);
  await f.command('run.cancel', { runId: parent.runId }); await f.engine.waitForRun(parent.runId);
  await f.action('worktree.cleanup', { worktreeId: childWorktree.id! });
  assert.equal(existsSync(childWorktree.root as string), false);
});
