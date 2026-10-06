import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createEngine, ScriptedProvider } from '@moodcode/engine';

const tasks = [
  {
    id: 'addition-bug', prompt: 'Fix addition without changing subtraction and verify the test.',
    files: { 'math.mjs': 'export const add = (a, b) => a - b;\nexport const subtract = (a, b) => a - b;\n' },
    expected: { 'math.mjs': 'export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n' },
    test: "import { add, subtract } from './math.mjs'; assert.equal(add(2, 3), 5); assert.equal(subtract(5, 3), 2);",
  },
  {
    id: 'empty-list-boundary', prompt: 'Handle an empty average as zero, keep normal averages, and run the checks.',
    files: { 'average.mjs': 'export const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;\n' },
    expected: { 'average.mjs': 'export const average = values => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;\n' },
    test: "import { average } from './average.mjs'; assert.equal(average([]), 0); assert.equal(average([2, 4]), 3);",
  },
  {
    id: 'two-module-change', prompt: 'Add trim support and use it in greeting, keeping uppercase support. Verify both modules.',
    files: { 'strings.mjs': 'export const upper = value => value.toUpperCase();\n', 'greet.mjs': "export const greet = name => `Hello ${name}`;\n" },
    expected: { 'strings.mjs': 'export const upper = value => value.toUpperCase();\nexport const trim = value => value.trim();\n', 'greet.mjs': "import { trim } from './strings.mjs';\nexport const greet = name => `Hello ${trim(name)}`;\n" },
    test: "import { upper, trim } from './strings.mjs'; import { greet } from './greet.mjs'; assert.equal(upper('a'), 'A'); assert.equal(trim(' x '), 'x'); assert.equal(greet(' Moodcode '), 'Hello Moodcode');",
  },
];

const reports = [];
for (const task of tasks) {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-evaluation-'));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  git('init', '-q');
  for (const [name, content] of Object.entries(task.files)) await writeFile(join(repository, name), content);
  await writeFile(join(repository, 'untouched.txt'), 'preserve me\n');
  await writeFile(join(repository, 'fixture.test.mjs'), `import assert from 'node:assert/strict';\n${task.test}\n`);
  git('add', '.');
  git('-c', 'user.name=Moodcode Evaluation', '-c', 'user.email=evaluation@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const toolTurn = (id, name, input) => ({ events: [{ type: 'tool.call', call: { id, name, input } }, { type: 'finish', reason: 'tool_calls' }] });
  const provider = new ScriptedProvider([
    ...Object.keys(task.files).map((path, index) => toolTurn(`read-${index}`, 'read_file', { path })),
    toolTurn('patch', 'apply_patch', { changes: Object.entries(task.expected).map(([path, content]) => ({ path, content, expectedHash: createHash('sha256').update(task.files[path]).digest('hex') })) }),
    toolTurn('check', 'run_command', { command: 'node --test fixture.test.mjs' }),
    { events: [{ type: 'text.delta', delta: 'Fixture coding task completed.' }, { type: 'finish', reason: 'stop' }] },
  ]);
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), providers: [provider] });
  const abort = new AbortController();
  const start = performance.now();
  let pump;
  const report = { taskId: task.id, kind: 'engine-fixture', providerId: 'scripted', modelId: 'local', passed: false, failure: null };
  async function command(type, payload) {
    const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
    if (!result.ok) throw new Error(`${result.error?.code}: ${result.error?.message}`);
    return result.result;
  }
  try {
    const workspace = await command('workspace.open', { path: repository });
    const session = await command('session.create', { workspaceId: workspace.id, title: task.id });
    pump = (async () => {
      for await (const event of engine.subscribe(session.id, 0, abort.signal)) {
        if (event.type !== 'approval.requested') continue;
        const snapshot = await command('session.getSnapshot', { sessionId: session.id });
        const approval = snapshot.approvals.find(item => item.id === event.payload.approvalId && item.status === 'pending');
        if (!approval || !['apply_patch', 'run_command'].includes(approval.toolName)) throw new Error('Unexpected fixture approval');
        await command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
      }
    })();
    const receipt = await command('run.submit', { sessionId: session.id, requestId: task.id, prompt: task.prompt, config: { mode: 'build', limits: { maxDurationMs: 20000, toolTimeoutMs: 5000 } } });
    const run = await engine.waitForRun(receipt.runId);
    report.runState = run.state;
    if (run.state !== 'completed') throw new Error(`Run ended ${run.state}: ${run.error?.code ?? 'unknown'}`);
    for (const [path, expected] of Object.entries(task.expected)) if (await readFile(join(repository, path), 'utf8') !== expected) throw new Error(`Expected content differs: ${path}`);
    if (await readFile(join(repository, 'untouched.txt'), 'utf8') !== 'preserve me\n') throw new Error('Unrequested file changed');
    const changedFiles = git('diff', '--name-only').trim().split('\n').filter(Boolean).sort();
    if (JSON.stringify(changedFiles) !== JSON.stringify(Object.keys(task.expected).sort())) throw new Error('Unexpected diff file set');
    execFileSync(process.execPath, ['--test', 'fixture.test.mjs'], { cwd: repository, timeout: 5000, stdio: 'pipe' });
    const snapshot = await command('session.getSnapshot', { sessionId: session.id });
    if (snapshot.tools.some(tool => tool.state !== 'completed')) throw new Error('A tool did not settle successfully');
    const checks = snapshot.tools.filter(tool => tool.name === 'run_command');
    if (checks.length !== 1) throw new Error('Expected exactly one engine check command');
    report.changedFiles = changedFiles;
    report.toolCalls = snapshot.tools.length;
    report.providerAttempts = provider.callCount;
    report.usage = await command('session.getMetrics', { sessionId: session.id });
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'Evaluation failed';
  } finally {
    abort.abort();
    if (pump) await pump.catch(error => { report.passed = false; report.failure = error.message; });
    await engine.close();
    report.durationMs = Math.round(performance.now() - start);
    await rm(directory, { recursive: true, force: true });
  }
  reports.push(report);
}
console.log(JSON.stringify({ schemaVersion: 1, kind: 'engine-fixture-evaluation', timestamp: new Date().toISOString(), tasks: reports }, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
