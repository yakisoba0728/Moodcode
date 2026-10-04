import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createEngine, ScriptedProvider } from '@moodcode/engine';

const directory = await mkdtemp(join(tmpdir(), 'moodcode-demo-'));
const repository = join(directory, 'repository');
await mkdir(repository);
const init = spawnSync('git', ['init', '-q', repository], { encoding: 'utf8' });
if (init.status !== 0) throw new Error('Demo requires Git');
const before = 'export function add(a, b) { return a - b; }\n';
const after = 'export function add(a, b) { return a + b; }\n';
await writeFile(join(repository, 'math.mjs'), before);
await writeFile(join(repository, 'math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
const hash = createHash('sha256').update(before).digest('hex');
const toolTurn = (id, name, input) => ({ events: [{ type: 'tool.call', call: { id, name, input } }, { type: 'finish', reason: 'tool_calls' }] });
const provider = new ScriptedProvider([
  toolTurn('read-math', 'read_file', { path: 'math.mjs' }),
  toolTurn('fix-math', 'apply_patch', { changes: [{ path: 'math.mjs', expectedHash: hash, content: after }] }),
  toolTurn('test-math', 'run_command', { command: 'node --test math.test.mjs' }),
  { events: [{ type: 'text.delta', delta: 'Scripted demo finished.' }, { type: 'finish', reason: 'stop' }] },
]);
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), providers: [provider] });
const abort = new AbortController();
async function command(type, payload) {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  if (!result.ok) throw new Error(`${result.error?.code}: ${result.error?.message}`);
  return result.result;
}
try {
  const workspace = await command('workspace.open', { path: repository });
  const session = await command('session.create', { workspaceId: workspace.id, title: 'Scripted code change demo' });
  const events = (async () => {
    for await (const event of engine.subscribe(session.id, 0, abort.signal)) {
      console.log(JSON.stringify({ type: 'event', seq: event.seq, event: event.type }));
      if (event.type === 'approval.requested') {
        const snapshot = await command('session.getSnapshot', { sessionId: session.id });
        for (const approval of snapshot.approvals.filter(value => value.status === 'pending')) {
          // This demo auto-approves only its known, temporary fixture actions.
          if (!['apply_patch', 'run_command'].includes(approval.toolName)) throw new Error('Unexpected demo approval');
          await command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
        }
      }
    }
  })();
  const receipt = await command('run.submit', { sessionId: session.id, requestId: 'demo-one', prompt: 'Fix addition and run its test.', config: { mode: 'build' } });
  const run = await engine.waitForRun(receipt.runId);
  abort.abort();
  await events;
  if (run.state !== 'completed') throw new Error(`Demo ended in ${run.state}`);
  if (await readFile(join(repository, 'math.mjs'), 'utf8') !== after) throw new Error('Demo patch did not apply');
  const snapshot = await command('session.getSnapshot', { sessionId: session.id });
  const commandRecord = snapshot.tools.find(tool => tool.name === 'run_command');
  if (!commandRecord || commandRecord.state !== 'completed') throw new Error('Demo command did not complete');
  const diff = await command('review.getDiff', { runId: run.id });
  console.log(JSON.stringify({ type: 'demo.result', provider: 'scripted', state: run.state, tools: snapshot.tools.map(tool => ({ name: tool.name, state: tool.state })), changedFiles: diff.files.map(file => file.path) }, null, 2));
} finally {
  abort.abort();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
