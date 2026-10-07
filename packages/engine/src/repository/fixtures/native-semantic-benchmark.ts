import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Workspace } from '@moodcode/contracts';
import { LspManager, type LspFactory } from '../../lsp/index.js';
import { createTypeScriptNativeLspFactory } from '../../lsp/typescript-native.js';
import { runGit } from '../../workspace/git.js';
import { RepositoryContextService, type RepositoryQuery, type RepositorySnapshot } from '../index.js';
import { authoredRange, semanticScore, writeSemanticCorpus, type ExpectedSemanticLocation, type SemanticProbe } from './semantic-corpus.js';

export const moodcodeRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export const nativeExecutable = join(moodcodeRoot, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const signal = () => new AbortController().signal;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNCLASSIFIED';
const executeFile = promisify(execFile);
async function observePartialBuild(executable: string, root: string) {
  const started = performance.now(); let stdout = '', stderr = '', exitCode = 0;
  try { const value = await executeFile(executable, ['--noEmit', '--project', root], { cwd: root, timeout: 30_000, maxBuffer: 65_536 }); stdout = value.stdout; stderr = value.stderr; }
  catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean };
    if (failure.killed || typeof failure.code !== 'number' || typeof failure.stdout !== 'string' || typeof failure.stderr !== 'string') throw error;
    exitCode = failure.code; stdout = failure.stdout; stderr = failure.stderr;
  }
  return { elapsedMs: performance.now() - started, exitCode, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stdoutSha256: sha(stdout), stderrSha256: sha(stderr), missingAuthoredDependency: stdout.includes('not-authored') && stdout.includes('TS2307'),
    excerpt: (stdout + stderr).slice(0, 2048) };
}
export async function nativeAvailable(executable = nativeExecutable): Promise<boolean> { try { await access(executable); return true; } catch { return false; } }
type NativeChild = { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null };
function host(executable: string) {
  const native = createTypeScriptNativeLspFactory({ executable, expectedVersion: '7.0.2' }), children: NativeChild[] = [];
  const tracked: LspFactory = async (workspace, abort) => {
    const connection = await native(workspace, abort), child = Reflect.get(connection, 'child') as NativeChild | undefined;
    if (child && typeof child.pid === 'number') children.push(child);
    return connection;
  };
  // Preserve the real native factory's project dependency capture, never replace server protocol responses.
  const project = Reflect.get(native, 'projectSources');
  if (project !== undefined) Object.defineProperty(tracked, 'projectSources', { value: project, enumerable: true });
  const lsp = new LspManager({ startupTimeoutMs: 10_000, requestTimeoutMs: 10_000, cleanupTimeoutMs: 2000 });
  lsp.register('native-ts7', tracked);
  const repository = new RepositoryContextService(lsp, path => /\.[cm]?[jt]sx?$/.test(path) ? { serverId: 'native-ts7', languageId: 'typescript', revision: '7.0.2' } : null);
  return { lsp, repository, children };
}
async function git(root: string, args: string[]) {
  const result = await runGit(root, args); if (result.code !== 0) throw new Error(`Authored corpus Git failed: ${result.stderr.toString().slice(0, 1000)}`);
}
function workspace(root: string): Workspace { return { id: randomUUID(), root, gitRoot: root, branch: null, createdAt: new Date().toISOString() }; }
async function close(h: ReturnType<typeof host>) {
  const started = performance.now(); await h.lsp.close();
  return { method: 'actual-manager-close-and-os-pid-probe' as const, elapsedMs: performance.now() - started,
    children: h.children.map(child => {
      let gone = false;
      try { process.kill(child.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true; else throw error; }
      return { pid: child.pid!, exitCode: child.exitCode, signal: child.signalCode, gone };
    }) };
}
async function query(h: ReturnType<typeof host>, scope: Workspace, input: RepositoryQuery, expected: readonly ExpectedSemanticLocation[] = []) {
  const started = performance.now(), hostRssBytesBefore = process.memoryUsage().rss;
  const snapshot = await h.repository.query(scope, input, signal());
  const locations = snapshot.observations.flatMap(observation => observation.items.map(item => ({ path: item.path, range: item.range })));
  return { query: input, elapsedMs: performance.now() - started, hostRssBytesBefore, hostRssBytesAfter: process.memoryUsage().rss,
    inputBytes: Buffer.byteLength(JSON.stringify(input)), resultBytes: Buffer.byteLength(JSON.stringify(snapshot)), score: semanticScore(locations, expected), snapshot };
}
async function probe(h: ReturnType<typeof host>, scope: Workspace, item: SemanticProbe) {
  return { id: item.id, ...(await query(h, scope, { kind: item.kind, paths: [item.path], position: item.position }, item.expected)) };
}
function sourcePin(snapshot: RepositorySnapshot) { return Reflect.get(snapshot.manifest, 'projectSources') as unknown; }

/** Measurements come from actual local TS7, real source files, Git, and RepositoryContextService. */
export async function runAuthoredNativeSemanticCorpus(executable = nativeExecutable, modules = 512) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-semantic-'))), root = join(parent, 'project');
  await mkdir(root); const h = host(executable), scope = workspace(root), started = performance.now();
  let worktree: string | undefined;
  try {
    await git(root, ['init', '--quiet', '--template=']);
    const corpus = await writeSemanticCorpus(root, modules);
    const stats = await Promise.all([...corpus.files.keys()].map(path => stat(join(root, path))));
    const disk = { files: corpus.files.size, sourceTextBytes: corpus.bytes, logicalFileBytes: stats.reduce((total, item) => total + item.size, 0),
      allocatedFileBytes: stats.reduce((total, item) => total + item.blocks * 512, 0), allocationUnitBytes: 512 };
    const probes = [];
    for (const item of corpus.probes) probes.push(await probe(h, scope, item));
    const boundedReferences = await probe(h, scope, corpus.boundedReferences);
    const outside = await probe(h, scope, corpus.outside), ignored = await probe(h, scope, corpus.ignored);
    const partial = await query(h, scope, { kind: 'symbols', paths: ['partial.ts'] });
    const partialBuild = await observePartialBuild(executable, root);
    const unsupported = await query(h, scope, { kind: 'symbols', paths: ['unsupported.txt'] });
    let ignoredSourceCode = 'NO_ERROR';
    try { await h.repository.query(scope, { kind: 'symbols', paths: ['ignored.ts'] }, signal()); } catch (error) { ignoredSourceCode = errorCode(error); }
    const before = probes.find(item => item.id === 'barrel-reexport-alias')!, prepared = await h.repository.preview(scope, before.query, signal());
    const originalTarget = corpus.files.get('modules/m003.ts')!;
    await writeFile(join(root, 'modules/m003.ts'), '// External editor moved the unopened definition.\n' + originalTarget);
    let staleCode = 'NO_ERROR';
    try { await h.repository.query(scope, before.query, signal(), prepared.fingerprint); } catch (error) { staleCode = errorCode(error); }
    const shifted: SemanticProbe = { ...corpus.probes.find(item => item.id === 'barrel-reexport-alias')!, expected: [{ path: 'modules/m003.ts', range: authoredRange('// External editor moved the unopened definition.\n' + originalTarget, 'duplicate') }] };
    const updated = await probe(h, scope, shifted);
    const edit = { staleCode, inputHashUnchanged: before.snapshot.manifest.files[0]!.hash === updated.snapshot.manifest.files[0]!.hash,
      generationChanged: before.snapshot.generation !== updated.snapshot.generation, projectBefore: sourcePin(before.snapshot), projectAfter: sourcePin(updated.snapshot), updated };
    await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Moodcode authored fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'Authored semantic corpus']);
    worktree = join(parent, 'alternate'); await git(root, ['worktree', 'add', '--quiet', '-b', 'semantic-alternative', worktree]);
    const alternate = workspace(await realpath(worktree)), firstSource = corpus.files.get('modules/m000.ts')!;
    await writeFile(join(worktree, 'modules/m000.ts'), '// Isolated worktree definition.\n' + firstSource);
    const original = await probe(h, scope, corpus.probes[0]!);
    const branch = await probe(h, alternate, { ...corpus.probes[0]!, expected: [{ path: 'modules/m000.ts', range: authoredRange('// Isolated worktree definition.\n' + firstSource, 'duplicate') }] });
    const separation = { original, branch, rootDifferent: original.snapshot.manifest.root !== branch.snapshot.manifest.root,
      workspaceDifferent: original.snapshot.manifest.workspaceId !== branch.snapshot.manifest.workspaceId, branchDifferent: original.snapshot.manifest.branch !== branch.snapshot.manifest.branch };
    const cancelled = new AbortController(); cancelled.abort(); let cancelCode = 'NO_ERROR'; const startsBeforeCancel = h.children.length;
    try { await h.repository.query(scope, { kind: 'symbols', paths: ['aliases.ts'] }, cancelled.signal); } catch (error) { cancelCode = errorCode(error); }
    const cleanup = await close(h);
    return { schemaVersion: 1, measurement: 'actual-native-typescript-semantic-corpus-v1', version: '7.0.2', platform: process.platform, arch: process.arch,
      modules, disk, totalElapsedMs: performance.now() - started, probes, boundedReferences, outside, ignored, ignoredSourceCode, partial, unsupported,
      partialBuild, edit, separation, cancellation: { phase: 'pre-query-aborted', code: cancelCode, nativeStartDelta: h.children.length - startsBeforeCancel, interruptedNativeRequestClaim: false }, cleanup,
      limitations: ['Only explicitly labelled probes establish precision/recall.', 'Host RSS samples exclude the native server process.', 'Outside-root/native-library dependency freshness is not claimed.', 'No provider or coding effect is executed.'] };
  } finally {
    await h.lsp.close().catch(() => {});
    if (worktree) await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
}

export async function runMoodcodeNativeSemanticProbes(executable = nativeExecutable) {
  const h = host(executable), scope = workspace(await realpath(moodcodeRoot));
  try {
    const usePath = 'packages/engine/src/context/service.ts', source = await readFile(join(scope.root, usePath), 'utf8');
    const definitions = [
      { name: 'planContext', anchor: 'await planContext(', path: 'packages/engine/src/context/plan.ts', declaration: 'export async function planContext(' },
      { name: 'projectToolHistory', anchor: 'snapshot: projectToolHistory(', path: 'packages/engine/src/context/tool-history.ts', declaration: 'export function projectToolHistory(' },
    ];
    const probes = [];
    for (const definition of definitions) {
      const useOffset = source.indexOf(definition.anchor); if (useOffset < 0) throw new Error(`Authored Moodcode callsite missing: ${definition.anchor}`);
      const prefix = source.slice(0, useOffset + definition.anchor.indexOf(definition.name)), lines = prefix.split(/\r\n|\r|\n/);
      const declaration = await readFile(join(scope.root, definition.path), 'utf8'), offset = declaration.indexOf(definition.declaration);
      if (offset < 0) throw new Error(`Authored Moodcode declaration missing: ${definition.declaration}`);
      const beforeName = declaration.slice(0, offset + definition.declaration.indexOf(definition.name)), declarationLines = beforeName.split(/\r\n|\r|\n/);
      const expected = { path: definition.path, range: { start: { line: declarationLines.length - 1, character: declarationLines.at(-1)!.length },
        end: { line: declarationLines.length - 1, character: declarationLines.at(-1)!.length + definition.name.length } } };
      probes.push({ id: `moodcode-${definition.name}`, sourceSha256: sha(source), declarationSha256: sha(declaration),
        ...(await query(h, scope, { kind: 'definition', paths: [usePath], position: { line: lines.length - 1, character: lines.at(-1)!.length } }, [expected])) });
    }
    return { schemaVersion: 1, measurement: 'actual-moodcode-native-semantic-probes-v1', version: '7.0.2', probes, cleanup: await close(h) };
  } finally { await h.lsp.close().catch(() => {}); }
}
