import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createEngine } from '../engine.js';
import { EngineChildren } from './engine-host.js';
import { CHILD_STORAGE_MIRROR_KIND, childStorageKind, childStoragePhysicalIdentity, readChildStorageSelection, validateChildStorageRecord } from './storage-binding.js';
import type { ProviderAdapter } from '../ports.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
for (const {external,legacy} of [{external:false,legacy:false},{external:true,legacy:false},{external:false,legacy:true}]) test(`actual siblings preserve ${legacy?'legacy 4-argument construction': 'bound mirror admission/close'} in ${external ? 'external host' : 'default artifact'} storage`, { timeout: 15_000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-child-authority-review-'))), repository = join(directory, 'repo'), artifactDir = join(directory, 'artifacts');
  const externalDir = join(directory, 'external-child-storage'), rootEntered = deferred();
  mkdirSync(repository);
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(join(repository, 'observations.txt'), 'Authored local repository fixture.\n');
  execFileSync('git', ['-C', repository, 'add', 'observations.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(request, signal) {
    if (request.messages.some(message => message.role === 'user' && message.content === 'ROOT_PARENT')) {
      rootEntered.resolve(); yield { type: 'progress' };
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
    } else {
      if (!legacy) {
        const rootBinding = rootReader.prepare("SELECT data FROM session_documents WHERE kind LIKE 'child.storage.%' AND json_extract(data,'$.binding.child.runId')=? LIMIT 1").get(request.runId);
        assert.ok(rootBinding, 'Provider cannot start before admitted root binding');
        const record = validateChildStorageRecord(JSON.parse(String(rootBinding.data)));
        assert.equal(record.binding.phase,'admitted'); assert.equal(record.confirmedClose,undefined);
        const mirrorReader = new DatabaseSync(record.binding.physical.database.path,{readOnly:true});
        try {
          const mirror = mirrorReader.prepare('SELECT data FROM session_documents WHERE session_id=? AND kind=? LIMIT 1').get(record.binding.child.sessionId,CHILD_STORAGE_MIRROR_KIND);
          assert.ok(mirror); assert.deepEqual(validateChildStorageRecord(JSON.parse(String(mirror.data))),record);
        } finally {mirrorReader.close();}
      }
      yield { type: 'text.delta', delta: 'Owned child observation from this exact Run.' };
    }
    yield { type: 'finish', reason: 'stop' };
  } };
  const engineOptions = { dbPath: join(directory, 'engine.sqlite'), artifactDir, providers: [provider], tools: [], defaults: { providerId: 'fixture', modelId: 'fixture', mode: 'plan' as const }, ...(external ? { worktreeDirectory: externalDir } : {}) };
  const engine = createEngine(engineOptions);
  const children = legacy ? new EngineChildren(engine,engineOptions,join(artifactDir,'children'),createEngine) : engine.children;
  const rootReader = new DatabaseSync(join(directory, 'engine.sqlite'), { readOnly: true });
  t.after(async () => { try { await engine.close(); } finally { rootReader.close(); rmSync(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Root owner', createdAt });
  const workspace = engine.store.getWorkspace('workspace');
  const worktreeSignal = new AbortController().signal;
  const worktrees = legacy ? [await children.worktrees.create({sessionId:'session',requestId:'sibling-worktree-1',workspace},worktreeSignal),await children.worktrees.create({sessionId:'session',requestId:'sibling-worktree-2',workspace},worktreeSignal)] : [await engine.createWorktree('session', 'sibling-worktree-1'), await engine.createWorktree('session', 'sibling-worktree-2')];
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'root', prompt: 'ROOT_PARENT', config: engine.getCapabilities().defaults });
  await rootEntered.promise;
  const childDirectory = external ? realpathSync(externalDir) : join(artifactDir, 'children');
  assert.equal(children.getStorageDirectory(),childDirectory);
  const sessions: string[] = [], runs: string[] = [], taskIds: string[] = [];
  for (const [index, worktree] of worktrees.entries()) {
    const initial = await children.start({ sessionId: 'session', requestId: `sibling-${index}`, parentRunId: receipt.runId, worktreeId: worktree.id, prompt: `CHILD_OBSERVATION_${index}`, tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 512, durationMs: 5000 } });
    const task = await children.tasks.wait('session', initial.id);
    assert.equal(task.state, 'completed', JSON.stringify(task)); assert.ok(task.childRunId);
    const childDatabase = join(childDirectory, task.id, 'engine.sqlite'), childArtifacts = join(childDirectory, task.id, 'artifacts');
    const childReader = new DatabaseSync(childDatabase, { readOnly: true });
    try {
      const row = childReader.prepare("SELECT r.id,r.session_id,r.workspace_id,json_extract(r.data,'$.requestId') AS request_id,r.state,s.workspace_id AS session_workspace_id,json_extract(w.data,'$.root') AS root,json_extract(w.data,'$.gitRoot') AS git_root FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=? LIMIT 1").get(task.childRunId);
      assert.ok(row);
      assert.equal(row.id, task.childRunId); assert.equal(row.request_id, task.id); assert.equal(row.state, 'completed');
      assert.equal(row.workspace_id, row.session_workspace_id);
      assert.equal(row.root, worktree.root); assert.equal(row.git_root, worktree.root);
      assert.equal(row.workspace_id, `workspace_${createHash('sha256').update(worktree.root).digest('hex')}`);
      assert.equal(task.sessionId, 'session'); assert.notEqual(row.session_id, task.sessionId);
      assert.equal(task.rootRunId, receipt.runId); assert.equal(task.parentRunId, receipt.runId); assert.equal(task.parentTaskId, undefined); assert.equal(task.depth, 1);
      assert.equal(children.worktrees.get('session', worktree.id).ownerId, undefined, 'Terminal worktree ownership is released; historical task ownership comes from the durable task relation');
      assert.equal(realpathSync(childArtifacts), childArtifacts);
      assert.equal(childReader.prepare('SELECT count(*) AS n FROM runs').get()!.n, 1);
      sessions.push(String(row.session_id)); runs.push(task.childRunId); taskIds.push(task.id);
      const rootJournal = rootReader.prepare("SELECT data FROM session_documents WHERE session_id='session' AND kind='engine.child_tasks' LIMIT 1").get();
      assert.ok(rootJournal); assert.ok(String(rootJournal.data).includes(task.id)); assert.ok(String(rootJournal.data).includes(task.childRunId));
      assert.equal(String(rootJournal.data).includes(String(row.session_id)), false, 'Current root task journal does not persist its random child Session');
      assert.equal(String(rootJournal.data).includes(childDatabase), false, 'Current root task journal does not persist its child database path');
      const rootDocument = engine.store.getSessionDocument('session',childStorageKind(task.id));
      const mirrorDocument = childReader.prepare('SELECT data FROM session_documents WHERE session_id=? AND kind=? LIMIT 1').get(String(row.session_id),CHILD_STORAGE_MIRROR_KIND);
      const hostIdentity = {database:childStoragePhysicalIdentity(join(directory,'engine.sqlite')),artifacts:childStoragePhysicalIdentity(artifactDir,true)};
      const selected = readChildStorageSelection(rootReader,{sessionId:'session',sourceRunId:receipt.runId,taskIds:[task.id],hostIdentity,childrenDirectory:childDirectory});
      if(legacy){assert.equal(rootDocument,null); assert.equal(mirrorDocument,undefined); assert.equal(selected.selections[0]!.status,'legacy');}
      else {
        assert.ok(rootDocument); assert.ok(mirrorDocument);
        const record = validateChildStorageRecord(rootDocument.data), mirror = validateChildStorageRecord(JSON.parse(String(mirrorDocument.data)));
        assert.equal(record.binding.child.sessionId,row.session_id); assert.equal(record.binding.child.runId,task.childRunId); assert.equal(record.sha256,mirror.sha256);
        assert.equal(record.confirmedClose!.method,'engine-close-resolved'); assert.equal(mirror.confirmedClose,undefined);
        assert.equal(selected.selections[0]!.status,'eligible',JSON.stringify(selected));
        const archival = readChildStorageSelection(rootReader,{sessionId:'session',sourceRunId:receipt.runId,taskIds:[task.id],hostIdentity,childrenDirectory:childDirectory,mode:'archive-historical'});
        assert.equal(archival.selections[0]!.status,external?'archive-unsupported':'historical');
      }
      assert.equal(childDatabase.startsWith(artifactDir + '/'), !external);
    } finally { childReader.close(); }
  }
  assert.equal(new Set(sessions).size, 2); assert.equal(new Set(runs).size, 2); assert.equal(new Set(taskIds).size, 2);
});
