import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { StdioLspConnection, type LspConnection } from '../lsp/index.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';
import type { RestorePreview, RestoreResult } from '../review/index.js';
import type { WorkspaceChangeEvent } from '../workspace/changes.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const before = '\ufeffbad\r\n😀bad\r\n';
const formatted = '\ufeffgood\r\n😀bad\r\n';
type Engine = ReturnType<typeof createEngine>;
type State = { initialized: boolean; watched: number; documents: { uri: string; text: string; version: number }[] };
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
async function deadline<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Language service integration did not settle')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) { assert.ok(Date.now() < end, 'language service state must progress'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(response.ok, true, `${type}: ${JSON.stringify(response.error)}`); return response.result as unknown as T;
}
async function fixture(t: TestContext, provider: ProviderAdapter) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-language-integration-')));
  const root = join(temporary, 'repository'); await mkdir(root);
  await exec('git', ['init', '--quiet', '--template=', root]);
  await writeFile(join(root, 'a.ts'), before); await writeFile(join(root, 'marker.txt'), '0');
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Language fixture']);
  const engine = createEngine({ dbPath: join(temporary, 'engine.sqlite'), artifactDir: join(temporary, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, maxDurationMs: 15000 } } });
  t.after(async () => { await engine.close(); await rm(temporary, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: root });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id });
  const state = { connection: undefined as StdioLspConnection | undefined, pid: undefined as number | undefined, opened: 0, holdUpdates: false, update: gate(), release: gate() };
  t.after(state.release.resolve);
  const server = fileURLToPath(new URL(`../lsp/fixtures/server.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
  const factory = async (workspace: Workspace): Promise<LspConnection> => {
    state.opened++; const connection = await StdioLspConnection.open({ command: process.execPath, args: [server], cwd: workspace.root });
    state.connection = connection; state.pid = (Reflect.get(connection, 'child') as { pid?: number }).pid;
    return {
      request: (method, params, signal, timeout) => connection.request(method, params, signal, timeout),
      onNotification: listener => connection.onNotification(listener),
      close: () => connection.close(),
      async notify(method, params) {
        if (method === 'textDocument/didChange' && state.holdUpdates) { state.update.resolve(); await state.release.promise; }
        await connection.notify(method, params);
      },
    };
  };
  const register = () => engine.registerLanguageServer('fixture', factory, path => path.endsWith('.ts') ? 'typescript' : null);
  const readState = async () => {
    assert.ok(state.connection); return await state.connection.request('fixture/state', {}, new AbortController().signal) as unknown as State;
  };
  const doc = (value: State) => value.documents.find(document => document.uri === pathToFileURL(join(root, 'a.ts')).href)!;
  const submit = () => command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Format the explicitly registered local file.' });
  return { root, engine, workspace, session, state, register, readState, doc, submit };
}
async function nextPath(iterator: AsyncIterableIterator<WorkspaceChangeEvent>, path: string) {
  return deadline((async () => { for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (next.value.type === 'change' && next.value.change.path === path) return next.value; } })());
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, beforeDecision?: () => Promise<void>) {
  await until(() => f.engine.store.getSnapshot(f.session.id).approvals.some(approval => approval.status === 'pending'));
  const approval = f.engine.store.getSnapshot(f.session.id).approvals.find(approval => approval.status === 'pending')!;
  await beforeDecision?.();
  await command(f.engine, 'approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' }); return approval;
}

test('approved formatter changes reach a real stdio LSP before the next model turn and external poll advances it once', { timeout: 30000 }, async t => {
  for (const toolName of ['format_file', 'lsp_format_file'] as const) await t.test(toolName, async nested => {
    let turns = 0, formatterCalls = 0, f!: Awaited<ReturnType<typeof fixture>>;
    const provider: ProviderAdapter = { id: 'language-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      turns++; assert.ok(request.tools.some(tool => tool.name === toolName));
      if (request.turnIndex === 0) {
        yield { type: 'tool.call', call: { id: 'format-proposal', name: toolName, input: toolName === 'format_file' ? { path: 'a.ts', formatterId: 'local' } : { path: 'a.ts', serverId: 'fixture', languageId: 'typescript' } } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        const synchronized = await f.readState(); assert.equal(f.doc(synchronized).version, 2); assert.equal(f.doc(synchronized).text, formatted); assert.equal(synchronized.watched, 1);
        const diagnostics = f.engine.lsp.diagnostics(f.workspace, 'fixture', 'a.ts')!;
        assert.equal(diagnostics.documentVersion, 2); assert.equal(diagnostics.documentHash, hash(formatted)); assert.equal(diagnostics.diagnostics[0]!.message, 'updated');
        assert.equal(f.engine.changes.getDocument(f.workspace.id, 'a.ts')!.documentVersion, 2);
        assert.equal(f.engine.store.listCheckpoints(request.runId).length, 1);
        yield { type: 'text.delta', delta: 'Formatted and synchronized.' }; yield { type: 'finish', reason: 'stop' };
      }
    } };
    f = await fixture(nested, provider); f.register();
    f.engine.formatters.register('local', async request => { formatterCalls++; assert.equal(request.path, 'a.ts'); assert.equal(request.content, before); return request.content.replace('bad', 'good'); });
    const watch = await f.engine.watchWorkspace(f.workspace.id);
    assert.equal(watch.workspaceId, f.workspace.id);
    await f.engine.lsp.updateFile(f.workspace, 'fixture', 'a.ts', 'typescript', new AbortController().signal);
    assert.equal(f.doc(await f.readState()).version, 1); assert.equal(f.state.opened, 1);
    const changes = f.engine.changes.subscribe(f.workspace.id);
    f.state.holdUpdates = true;
    const receipt = await f.submit();
    const approval = await approve(f, async () => {
      assert.equal(await readFile(join(f.root, 'a.ts'), 'utf8'), before); assert.equal(f.doc(await f.readState()).version, 1);
      assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 0); assert.deepEqual(f.engine.changes.replay(f.workspace.id), []); assert.equal(turns, 1);
    }); assert.equal(approval.toolName, toolName);
    await deadline(f.state.update.promise);
    // Actual stdio didChange has not been sent. The tool's checkpoint is
    // durable, but its settled observer must delay the next provider call.
    assert.equal(await readFile(join(f.root, 'a.ts'), 'utf8'), formatted); assert.equal(turns, 1);
    assert.equal(f.doc(await f.readState()).version, 1); await tick(); assert.equal(turns, 1);
    f.state.holdUpdates = false; f.state.release.resolve();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(turns, 2);
    assert.equal(formatterCalls, toolName === 'format_file' ? 1 : 0);
    const checkpoint = f.engine.store.listCheckpoints(receipt.runId)[0]!;
    assert.equal(checkpoint.files[0]!.beforeHash, hash(before)); assert.equal(checkpoint.files[0]!.afterHash, hash(formatted));
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools[0]!.state, 'completed');
    const internal = f.engine.changes.replay(f.workspace.id).filter(event => event.type === 'change').filter(event => event.change.path === 'a.ts');
    assert.equal(internal.length, 1); assert.deepEqual(internal[0]!.change.sources, ['tool']); assert.equal(internal[0]!.change.toolOwners[0]!.runId, receipt.runId);
    assert.equal(internal[0]!.change.toolOwners[0]!.checkpointId, checkpoint.id);
    // Force a real later poll. It observes the same formatted bytes along with
    // a non-language file and must not repeat the internal LSP notification.
    await writeFile(join(f.root, 'marker.txt'), '1'); await nextPath(changes, 'marker.txt');
    assert.equal((await f.readState()).watched, 1); assert.equal(f.doc(await f.readState()).version, 2);
    assert.equal(f.engine.changes.replay(f.workspace.id).filter(event => event.type === 'change' && event.change.path === 'a.ts').length, 1);
    const external = '\ufeffexternal\r\n😀bad\r\n';
    await writeFile(join(f.root, 'a.ts'), external);
    const event = await nextPath(changes, 'a.ts'); assert.equal(event.change.documentVersion, 3); assert.equal(event.change.afterHash, hash(external)); assert.deepEqual(event.change.sources, ['external']);
    await until(async () => f.doc(await f.readState()).version === 3 && f.engine.lsp.diagnostics(f.workspace, 'fixture', 'a.ts')?.documentVersion === 3);
    assert.equal(f.doc(await f.readState()).text, external); assert.equal((await f.readState()).watched, 2);
    assert.equal(f.engine.lsp.diagnostics(f.workspace, 'fixture', 'a.ts')!.documentHash, hash(external)); assert.equal(f.state.opened, 1);
    let descendant: number | undefined;
    if (process.platform !== 'win32') descendant = (await f.state.connection!.request('fixture/descendant', {}, new AbortController().signal) as { pid: number }).pid;
    const waiting = changes.next(); await deadline(f.engine.close()); assert.equal((await waiting).done, true);
    assert.ok(f.state.pid);
    await until(() => { try { process.kill(f.state.pid!, 0); return false; } catch { return true; } });
    if (descendant) await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
    await assert.rejects(f.readState(), code('LSP_DISCONNECTED'));
    await assert.rejects(f.engine.watchWorkspace(f.workspace.id), code('ENGINE_CLOSED'));
  });
});

test('model-selected formatter or LSP identifiers cannot launch unavailable host services or bypass approval', async t => {
  for (const toolName of ['format_file', 'lsp_format_file'] as const) await t.test(toolName, async nested => {
    let f!: Awaited<ReturnType<typeof fixture>>, turns = 0;
    f = await fixture(nested, { id: 'language-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      turns++;
      if (request.turnIndex === 0) {
        yield { type: 'tool.call', call: { id: 'missing-service', name: toolName, input: toolName === 'format_file' ? { path: 'a.ts', formatterId: 'unregistered' } : { path: 'a.ts', serverId: 'unregistered', languageId: 'typescript' } } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else { assert.match(request.messages.findLast(message => message.role === 'tool')!.content, toolName === 'format_file' ? /FORMATTER_UNAVAILABLE/ : /LSP_SERVER_UNAVAILABLE/); yield { type: 'finish', reason: 'stop' }; }
    } });
    await f.engine.watchWorkspace(f.workspace.id);
    const receipt = await f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
    const snapshot = f.engine.store.getSnapshot(f.session.id);
    assert.equal(turns, 2); assert.equal(snapshot.tools[0]!.state, 'failed'); assert.equal(snapshot.approvals.length, 0); assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 0);
    assert.equal(await readFile(join(f.root, 'a.ts'), 'utf8'), before); assert.equal(f.state.opened, 0); assert.deepEqual(f.engine.changes.replay(f.workspace.id), []);
  });
});

test('review restoration synchronizes the current hash and LSP document after its approved formatter checkpoint', { timeout: 15000 }, async t => {
  const f = await fixture(t, { id: 'language-fixture', async *streamTurn(request) {
    if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'format', name: 'format_file', input: { path: 'a.ts', formatterId: 'local' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else yield { type: 'finish', reason: 'stop' };
  } });
  f.register(); f.engine.formatters.register('local', async request => request.content.replace('bad', 'good'));
  await f.engine.watchWorkspace(f.workspace.id); await f.engine.lsp.updateFile(f.workspace, 'fixture', 'a.ts', 'typescript', new AbortController().signal);
  const receipt = await f.submit(); await approve(f); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const checkpoint = f.engine.store.listCheckpoints(receipt.runId)[0]!;
  const preview = await command<RestorePreview>(f.engine, 'review.previewRestore', { runId: receipt.runId, checkpointId: checkpoint.id });
  assert.equal(preview.canRestore, true); assert.equal(preview.files[0]!.currentHash, hash(formatted));
  const restored = await command<RestoreResult>(f.engine, 'review.restore', { runId: receipt.runId, checkpointId: checkpoint.id, previewFingerprint: preview.fingerprint });
  assert.deepEqual(restored.restored, ['a.ts']); assert.equal(restored.effectsUncertain, false); assert.equal(await readFile(join(f.root, 'a.ts'), 'utf8'), before);
  // Restoration is a host effect; its awaited result must expose current
  // document metadata without relying on another background poll.
  assert.equal(f.engine.changes.getDocument(f.workspace.id, 'a.ts')!.hash, hash(before));
  assert.equal(f.engine.changes.getDocument(f.workspace.id, 'a.ts')!.documentVersion, 3);
  const current = await f.readState(); assert.equal(f.doc(current).text, before); assert.equal(f.doc(current).version, 3); assert.equal(current.watched, 2);
  assert.equal(f.engine.lsp.diagnostics(f.workspace, 'fixture', 'a.ts')!.documentHash, hash(before));
  assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 1);
  assert.equal(f.engine.store.listCheckpoints(receipt.runId)[0]!.files[0]!.afterHash, hash(formatted), 'restore observation cannot rewrite the original immutable effect evidence');
  const events = f.engine.changes.replay(f.workspace.id), cursor = events.at(-1)!.seq;
  const changes = f.engine.changes.subscribe(f.workspace.id, cursor);
  await writeFile(join(f.root, 'marker.txt'), '1'); await nextPath(changes, 'marker.txt');
  assert.equal(f.engine.changes.getDocument(f.workspace.id, 'a.ts')!.documentVersion, 3);
  assert.equal((await f.readState()).watched, 2);
  assert.equal(f.engine.changes.replay(f.workspace.id).filter(event => event.type === 'change' && event.change.path === 'a.ts').length, 2);
  await changes.return?.();
});
