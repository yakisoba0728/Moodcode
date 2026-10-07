import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

// This lane measures actual bounded snapshot/hash metadata with no host LSP.
// It does not submit a Run, call a provider, start a PTY/command backend or index
// every corpus file through the engine. Corpus inventory is a separate read.
const scriptPath = fileURLToPath(import.meta.url), projectRoot = dirname(dirname(scriptPath));
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.rs']);
const inventoryRoots = ['apps', 'packages', 'scripts'];
const excludedComponents = new Set(['node_modules', 'dist', 'build', '.git', '.cache', 'coverage', 'out']);
const selectedPaths = [
  'packages/engine/src/config/index.ts',
  'packages/engine/src/config/budgets.ts',
  'packages/engine/src/context/index.ts',
  'packages/engine/src/context/plan.ts',
  'packages/engine/src/workspace/index.ts',
  'packages/engine/src/workspace/ignore.ts',
  'packages/engine/src/tools/file-actions/text.ts',
  'packages/engine/src/provider/helpers.ts',
];
const sha = data => createHash('sha256').update(data).digest('hex');
const jsonSha = value => sha(JSON.stringify(value));
const rounded = number => Math.round(number * 1_000) / 1_000;
function argumentsFor(argv) {
  let root = projectRoot, iterations = 5;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index], value = argv[index + 1];
    if (option === '--help') return { help: true };
    if (option === '--root' && value) { root = resolve(value); index++; }
    else if (option === '--iterations' && value && /^[3-5]$/.test(value)) { iterations = Number(value); index++; }
    else throw new Error('INVALID_BENCHMARK_ARGUMENT');
  }
  return { root, iterations };
}
function git(root, ...args) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function exactSource(root, path) {
  const absolute = resolve(root, path), info = await lstat(absolute);
  assert.equal(info.isFile() && !info.isSymbolicLink(), true, `Source must be a plain file: ${path}`);
  assert.equal(await realpath(absolute), absolute, `Source ancestor must not escape through an alias: ${path}`);
  assert.ok(absolute.startsWith(`${root}${sep}`)); assert.ok(info.size <= 32 * 1024 * 1024, 'Individual inventory file limit');
  const bytes = await readFile(absolute); return { path, bytes: bytes.byteLength, sha256: sha(bytes) };
}
async function corpusInventory(root) {
  const started = performance.now();
  const paths = [...new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inventoryRoots).split('\0').filter(Boolean))]
    .filter(path => codeExtensions.has(extname(path)) && !path.split('/').some(component => excludedComponents.has(component))).sort();
  assert.ok(paths.length > 0 && paths.length <= 20_000, 'Explicit corpus file limit');
  const files = [], extensions = {}; let bytes = 0;
  for (const path of paths) {
    const file = await exactSource(root, path); files.push(file); bytes += file.bytes;
    assert.ok(bytes <= 256 * 1024 * 1024, 'Explicit corpus byte limit');
    const extension = extname(path), entry = extensions[extension] ?? { files: 0, bytes: 0 }; entry.files++; entry.bytes += file.bytes; extensions[extension] = entry;
  }
  return { method: 'one-pass-git-code-inventory', roots: inventoryRoots, codeExtensions: [...codeExtensions], excludedComponents: [...excludedComponents], files: files.length, bytes, extensions, manifestSha256: jsonSha(files), elapsedMs: rounded(performance.now() - started), atomicTreeSnapshot: false, entries: files };
}
async function compiledBinding(root) {
  const paths = ['packages/engine/dist/engine.js', 'packages/engine/dist/repository/index.js', 'packages/engine/dist/lsp/index.js', 'packages/engine/dist/lsp/navigation.js', 'packages/engine/dist/tools/file-actions/text.js', 'packages/engine/dist/workspace/ignore.js'];
  const files = []; for (const path of paths) files.push(await exactSource(root, path));
  return { module: 'packages/engine/dist/engine.js', files, sha256: jsonSha(files), role: 'recorded-runtime-implementation-files-not-entire-transitive-graph' };
}
function summary(samples) {
  const times = samples.map(sample => sample.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2), medianMs = times.length % 2 ? times[middle] : rounded((times[middle - 1] + times[middle]) / 2);
  return { count: samples.length, minMs: times[0], medianMs, maxMs: times.at(-1), meanMs: rounded(times.reduce((total, value) => total + value, 0) / times.length), generationStable: new Set(samples.map(sample => sample.generation)).size === 1 };
}

let directory, engine, timer;
const report = { schemaVersion: 1, kind: 'repository-context-bounded-snapshot-benchmark', status: 'pending', startedAt: new Date().toISOString(), lane: 'actual-engine-without-host-lsp', noSemanticQualityClaim: true, noFullIndexClaim: true, noCacheImprovementClaim: true, implementationFamilyComplete: false, cwd: process.cwd(), environment: { node: process.version, os: platform(), osRelease: release(), architecture: arch() }, command: ['node', relative(process.cwd(), scriptPath) || scriptPath, ...process.argv.slice(2)], queries: [] };
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { process.stdout.write('Usage: node scripts/benchmark-repository-context.mjs [--root Moodcode-directory] [--iterations 3|4|5]\nRequires an existing compiled engine (npm run build). Uses an explicit apps/packages/scripts corpus and eight Moodcode source paths. Emits JSON; only temporary engine files are created.\n'); process.exit(0); }
  const root = await realpath(options.root), runtimeRoot = await realpath(projectRoot);
  assert.equal(await realpath(git(root, 'rev-parse', '--show-toplevel').trim()), root, 'Benchmark root must be the repository root');
  report.root = root; report.runtimeRoot = runtimeRoot; report.iterations = options.iterations;
  report.gitHead = git(root, 'rev-parse', '--verify', 'HEAD').trim();
  report.codeWorktreeDirty = git(root, 'status', '--porcelain=v1', '--untracked-files=normal', '--', ...inventoryRoots).length > 0;
  const corpus = await corpusInventory(root); report.corpus = corpus;
  const filesByPath = new Map(corpus.entries.map(file => [file.path, file]));
  const selected = selectedPaths.map(path => { const file = filesByPath.get(path); assert.ok(file, `Required Moodcode benchmark source missing: ${path}`); return file; });
  report.selectedSources = { paths: selectedPaths, files: selected, sha256: jsonSha(selected), bytes: selected.reduce((total, file) => total + file.bytes, 0) };
  const bindingBefore = await compiledBinding(runtimeRoot); report.compiledBinding = bindingBefore;
  const { createEngine } = await import(pathToFileURL(join(runtimeRoot, 'packages/engine/dist/engine.js')).href);
  const { REPOSITORY_CONTEXT_LIMITS } = await import(pathToFileURL(join(runtimeRoot, 'packages/engine/dist/repository/index.js')).href);
  report.limits = REPOSITORY_CONTEXT_LIMITS;
  directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-repository-benchmark-'))); let providerInvocations = 0;
  const neverProvider = { id: 'benchmark-never-invoked', async *streamTurn() { providerInvocations++; throw new Error('BENCHMARK_PROVIDER_FORBIDDEN'); } };
  engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [neverProvider], defaults: { providerId: neverProvider.id, modelId: 'not-used' } });
  const response = await engine.dispatch({ schemaVersion: 1, commandId: 'benchmark-workspace', type: 'workspace.open', payload: { path: root } }); assert.equal(response.ok, true, response.error?.code);
  const workspace = response.result, capabilities = engine.getCapabilities();
  report.catalogue = { count: capabilities.tools.length, expectedDefaultCount: 21, repositoryToolOptIn: false, names: capabilities.tools.map(tool => tool.name), unchangedDefaultCatalogue: capabilities.tools.length === 21 };
  assert.equal(capabilities.tools.length, 21, 'Default core catalogue contract');
  report.languageSupport = { hostLanguageServersRegistered: 0, status: 'unsupported-language-routing', semanticObservationsExpected: 0 };
  const abort = new AbortController(); timer = setTimeout(() => abort.abort(), 60_000);
  const queries = [
    { id: 'eight-path-symbols', input: { kind: 'symbols', paths: selectedPaths } },
    { id: 'single-path-symbols', input: { kind: 'symbols', paths: [selectedPaths[0]] } },
    { id: 'single-path-definition', input: { kind: 'definition', paths: [selectedPaths[0]], position: { line: 0, character: 0 } } },
    { id: 'single-path-references', input: { kind: 'references', paths: [selectedPaths[0]], position: { line: 0, character: 0 } } },
  ];
  for (const query of queries) {
    const samples = [];
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      const started = performance.now(), snapshot = await engine.getRepositoryContext(workspace.id, query.input, abort.signal), durationMs = performance.now() - started;
      const resultBytes = Buffer.byteLength(JSON.stringify(snapshot));
      const manifestFiles = [...new Map([...snapshot.manifest.files.map(file => ({ path: file.path, hash: file.hash })), ...snapshot.observations.flatMap(observation => observation.sources)].map(file => [file.path, file])).values()];
      let selectedSourceBytes = 0;
      for (const source of manifestFiles) { const file = filesByPath.get(source.path); assert.ok(file, 'Snapshot source must be in explicit measured corpus'); assert.equal(source.hash, file.sha256, 'Fresh manifest must match pinned source bytes'); selectedSourceBytes += file.bytes; }
      assert.equal(snapshot.authority, 'read-only'); assert.equal(snapshot.evidence, 'observed-file-snapshot'); assert.equal(snapshot.observations.length, 0); assert.equal(snapshot.manifest.bindings.length, 0); assert.equal(snapshot.complete, false);
      assert.equal(snapshot.unsupportedPaths.length, query.input.paths.length); assert.ok(resultBytes <= REPOSITORY_CONTEXT_LIMITS.resultBytes); assert.ok(selectedSourceBytes <= REPOSITORY_CONTEXT_LIMITS.sourceBytes); assert.ok(query.input.paths.length <= REPOSITORY_CONTEXT_LIMITS.paths);
      samples.push({ iteration, durationMs: rounded(durationMs), resultBytes, selectedSourceBytes, manifestFileCount: manifestFiles.length, includedSourceTextBytes: 0, observationCount: snapshot.observations.length, unsupportedPaths: snapshot.unsupportedPaths, omittedObservations: snapshot.omittedObservations, complete: snapshot.complete, generation: snapshot.generation, manifestSha256: jsonSha(snapshot.manifest), withinPathCap: true, withinResultByteCap: true, withinSourceByteCap: true });
    }
    const measured = { id: query.id, input: query.input, samples, summary: summary(samples) }; assert.equal(measured.summary.generationStable, true, 'Selected source generation must stay stable across repeats'); report.queries.push(measured);
  }
  const selectedAfter = []; for (const path of selectedPaths) selectedAfter.push(await exactSource(root, path));
  report.selectedSources.stableAfterQueries = jsonSha(selectedAfter) === report.selectedSources.sha256; assert.equal(report.selectedSources.stableAfterQueries, true, 'Selected source bytes changed during benchmark');
  const bindingAfter = await compiledBinding(runtimeRoot); report.compiledBinding.stableAfterQueries = bindingAfter.sha256 === bindingBefore.sha256; assert.equal(report.compiledBinding.stableAfterQueries, true, 'Recorded compiled implementation changed during benchmark');
  report.gitHeadStableAfterQueries = git(root, 'rev-parse', '--verify', 'HEAD').trim() === report.gitHead; assert.equal(report.gitHeadStableAfterQueries, true);
  const db = new DatabaseSync(join(directory, 'engine.sqlite'), { readOnly: true });
  try { report.execution = { providerInvocations, runs: Number(db.prepare('SELECT COUNT(*) AS count FROM runs').get().count), tools: Number(db.prepare('SELECT COUNT(*) AS count FROM tools').get().count), checkpoints: Number(db.prepare('SELECT COUNT(*) AS count FROM checkpoints').get().count), approvals: Number(db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count), providerAttempts: Number(db.prepare('SELECT COUNT(*) AS count FROM provider_attempts').get().count), modelRequestsSubmitted: 0, commandBackendInvocations: 0, ptyBackendInvocations: 0, languageServerInvocations: 0, gitMetadataReads: 'used-by-workspace-and-repository-api-not-counted', credentials: 'not-read', network: 'not-configured', sourceWrites: 0 }; }
  finally { db.close(); }
  for (const name of ['providerInvocations', 'runs', 'tools', 'checkpoints', 'approvals', 'providerAttempts']) assert.equal(report.execution[name], 0, `Benchmark must not create execution: ${name}`);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { code: typeof error?.code === 'string' ? error.code : 'BENCHMARK_VALIDATION_FAILED', message: error instanceof assert.AssertionError ? error.message : 'Benchmark did not satisfy its declared read-only lane' }; process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { if (engine) await engine.close(); }
  catch { report.status = 'failed'; report.cleanupFailure = 'ENGINE_CLOSE_FAILED'; process.exitCode = 1; }
  try { if (directory) await rm(directory, { recursive: true, force: true }); report.temporaryFilesRemoved = true; }
  catch { report.status = 'failed'; report.cleanupFailure = 'TEMPORARY_CLEANUP_FAILED'; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
