import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEngine, type EngineOptions } from '../../engine.js';
import type { ToolDefinition } from '../../ports.js';
import { ScopedToolRuntime } from './index.js';

function producer(): ToolDefinition {
  return { name: 'run_command', description: 'Host producer identity fixture', effectClass: 'execute', inputSchema: { type: 'object' },
    async prepare() { throw new Error('Producer must not be dispatched by identity observation'); }, async execute() { throw new Error('Producer must not be dispatched by identity observation'); } };
}
test('producer witness pins the original registration and respects the authenticated profile capture', () => {
  const runtime = new ScopedToolRuntime(), original = producer(); runtime.register('engine', original);
  const witness = runtime.captureRegistration('engine', original.name, original), catalogue = runtime.catalogue('engine');
  runtime.assertRegistrationCurrent(catalogue, witness);
  assert.throws(() => runtime.captureRegistration('engine', original.name, producer()), { code: 'TOOL_PRODUCER_MISMATCH' });
  assert.throws(() => runtime.assertRegistrationCurrent(catalogue, { ...witness }), { code: 'TOOL_PRODUCER_MISMATCH' });
  assert.throws(() => runtime.assertRegistrationCurrent(runtime.catalogue('engine', 'build', []), witness), { code: 'TOOL_NOT_FOUND' });
  const another = new ScopedToolRuntime(); another.register('engine', original);
  assert.throws(() => another.assertRegistrationCurrent(another.catalogue('engine'), witness), { code: 'TOOL_PRODUCER_MISMATCH' });
});
test('same-name and same-schema replacement cannot become the captured producer', () => {
  const runtime = new ScopedToolRuntime(), original = producer(); runtime.register('engine', original);
  const witness = runtime.captureRegistration('engine', original.name, original), previous = runtime.catalogue('engine');
  runtime.clearScope('engine'); runtime.register('engine', producer());
  assert.throws(() => runtime.assertRegistrationCurrent(previous, witness), { code: 'TOOL_CATALOGUE_STALE' });
  assert.throws(() => runtime.assertRegistrationCurrent(runtime.catalogue('engine'), witness), { code: 'TOOL_PRODUCER_MISMATCH' });
});

const CORE = ['list_files', 'read_file', 'search_files', 'apply_patch', 'run_command', 'edit_file', 'rename_file', 'delete_file', 'glob_files', 'regex_search', 'todo_read', 'todo_write',
  'ask_user', 'skill_list', 'skill_read', 'reference_read', 'read_artifact', 'format_file', 'lsp_format_file', 'merge_child_changes'];
const TEAM = { send_agent_message: 'exact', read_agent_mailbox: 'policy', claim_team_task: 'exact', complete_team_task: 'exact', read_team_board: 'policy', submit_team_task: 'exact', review_team_task: 'exact' };
const WORKFLOW = { request_workflow_stage: 'exact', observe_workflow_stage: 'policy', merge_workflow_stage: 'exact', deliver_workflow_result: 'exact' };
const FEATURES: Partial<EngineOptions> = { teams: true, teamModelTools: true, workflows: true, jobs: true, commandJobModelTools: true, toolDiscoveryPolicy: { kind: 'bounded-tool-discovery', version: 1 } };
const REGISTRATIONS: [string, Partial<EngineOptions>, Record<string, string>][] = [
  ['default', {}, { ...Object.fromEntries(CORE.map(name => [name, 'revalidate'])), delegate_task: 'exact' }],
  ['all features', { ...FEATURES, codeMode: true, hostCommands: true, commandLifetimes: true, verificationTools: true, repositoryContextTools: true }, {
    ...Object.fromEntries(CORE.map(name => [name, 'revalidate'])), run_command_job: 'exact', command_job_input: 'exact', wait_command_job: 'exact', delegate_task: 'exact', execute_code: 'exact',
    repository_context: 'revalidate', ...TEAM, read_command_job: 'revalidate', read_command_job_output: 'revalidate', ...WORKFLOW, discover_tools: 'revalidate', verify_changes: 'exact' }],
  ['os sandbox', { ...FEATURES, codeMode: true, osSandbox: true }, {
    run_command: 'revalidate', delegate_task: 'exact', execute_code: 'exact', ...TEAM, read_command_job: 'revalidate', read_command_job_output: 'revalidate', ...WORKFLOW, discover_tools: 'revalidate' }],
  ['host tools', { ...FEATURES, repositoryContextTools: true, tools: [{ ...producer(), name: 'host_tool' }] }, {
    host_tool: 'policy', repository_context: 'policy', ...TEAM, read_command_job: 'policy', read_command_job_output: 'policy', ...WORKFLOW, discover_tools: 'policy' }],
];
for (const [name, options, expected] of REGISTRATIONS) test(`engine registers each produced tool with its declared approval mode: ${name}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [{ id: 'unused', async *streamTurn() { throw new Error('Provider must not be called'); } }], ...options });
  t.after(() => engine.close());
  const entries = (Reflect.get(engine.toolRuntime, 'scopes') as Map<string, Map<string, { exactApproval: boolean; revalidate?: unknown }>>).get('engine')!;
  assert.deepEqual(Object.fromEntries([...entries].map(([tool, entry]) => [tool, entry.exactApproval ? 'exact' : entry.revalidate ? 'revalidate' : 'policy'])), expected);
});
