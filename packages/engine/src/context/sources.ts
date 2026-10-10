import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EngineError } from '@moodcode/contracts';

export interface InstructionSource {
  id: string;
  path: string;
  scope: string;
  status: 'available' | 'missing' | 'unavailable';
  sha256: string | null;
  text: string | null;
  observedAt: string;
  retainedBaseline: boolean;
  /** Required on persisted baselines; prevents an instruction ID crossing workspace roots. */
  workspaceRoot?: string;
}
export interface InstructionObservation { sources: InstructionSource[]; changedSourceIds: string[]; warnings: string[] }
export interface InstructionBaselinePersistence {
  loadBaseline(id: string): InstructionSource | null;
  saveBaseline(source: InstructionSource): void;
}
/** Reports which of the given workspace-relative directories Git ignores. */
export type InstructionIgnoreLookup = (directories: string[], signal: AbortSignal) => Promise<ReadonlySet<string>>;
const MAX_SOURCES = 32;
const MAX_SOURCE_BYTES = 32_768;
// Dependency and VCS content never gains workspace-instruction authority.
const UNTRUSTED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'site-packages']);

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('CANCELLED', 'Instruction discovery was cancelled');
}
function errorCode(error: unknown): string | undefined { return (error as { code?: string } | null)?.code; }
const posix = (path: string) => path.split(sep).join('/');

function scopes(root: string, path: string): string[] {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 4096 || isAbsolute(path) || path.includes('\0')) throw new EngineError('INVALID_INSTRUCTION_PATH', 'Instruction paths must be bounded workspace-relative paths');
  const scoped = relative(root, resolve(root, path));
  if (scoped === '..' || scoped.startsWith(`..${sep}`)) throw new EngineError('INVALID_INSTRUCTION_PATH', 'Instruction path leaves the workspace');
  const result: string[] = [];
  for (let directory = dirname(scoped); directory !== '.' && directory !== ''; directory = dirname(directory))
    if (!directory.split(sep).some(name => UNTRUSTED_DIRECTORIES.has(name.toLowerCase()))) result.push(join(directory, 'AGENTS.md'));
  return result;
}

/** Model-chosen paths are hints: invalid ones are skipped, and a path whose scopes would pass the source limit is left out whole. */
export function instructionPathHints(root: string, hints: Iterable<string>): { paths: string[]; warnings: string[] } {
  const paths: string[] = [], selected = new Set(['AGENTS.md']);
  let skipped = 0;
  for (const hint of hints) {
    let candidates: string[];
    try { candidates = scopes(root, hint); } catch { continue; }
    const added = candidates.filter(candidate => !selected.has(candidate));
    if (selected.size + added.length > MAX_SOURCES) { skipped++; continue; }
    for (const candidate of added) selected.add(candidate);
    paths.push(hint);
  }
  return { paths, warnings: skipped ? [`${skipped} instruction path hint(s) were skipped at the ${MAX_SOURCES}-source instruction scope limit.`] : [] };
}

/** Root instructions precede deeper scopes; only paths relevant to this request are discovered. */
export class InstructionSources {
  private readonly baseline = new Map<string, InstructionSource>();
  private readonly workspaceRoot: string;
  constructor(private readonly root: string, private readonly persistence?: InstructionBaselinePersistence, private readonly ignored?: InstructionIgnoreLookup) {
    if (!isAbsolute(root) || root.includes('\0') || Buffer.byteLength(root) > 4096) throw new EngineError('INVALID_WORKSPACE', 'Instruction discovery requires a bounded absolute workspace root');
    this.workspaceRoot = resolve(root);
  }
  private loadBaseline(id: string, path: string): InstructionSource | undefined {
    const cached = this.baseline.get(id);
    if (cached || !this.persistence) return cached;
    const value = this.persistence.loadBaseline(id);
    if (value === null) return undefined;
    const fail = (): never => { throw new EngineError('INSTRUCTION_BASELINE_INVALID', 'Persisted instruction baseline failed workspace, scope, status or content validation', { sourceId: id }); };
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const keys = ['id', 'path', 'scope', 'status', 'sha256', 'text', 'observedAt', 'retainedBaseline', 'workspaceRoot'];
    if (Object.keys(value).some(key => !keys.includes(key))) return fail();
    if (value.workspaceRoot !== this.workspaceRoot || value.id !== id || value.path !== path || value.scope !== (dirname(path) === '.' ? '' : dirname(path)) || value.retainedBaseline !== false) return fail();
    if (typeof value.observedAt !== 'string' || value.observedAt.length > 64 || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt) return fail();
    if (value.status === 'missing') {
      if (value.text !== null || value.sha256 !== null) return fail();
    } else if (value.status === 'available') {
      if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_SOURCE_BYTES || Buffer.from(value.text).toString('utf8') !== value.text || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || createHash('sha256').update(value.text).digest('hex') !== value.sha256) return fail();
    } else return fail();
    const baseline = structuredClone(value);
    this.baseline.set(id, baseline);
    return baseline;
  }
  private candidates(paths: readonly string[]): string[] {
    const result = new Set(['AGENTS.md']);
    for (const path of paths) for (const candidate of scopes(this.root, path)) {
      result.add(candidate);
      if (result.size > MAX_SOURCES) throw new EngineError('INSTRUCTION_SOURCE_LIMIT', 'Too many instruction scopes for one request');
    }
    return [...result].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
  }
  private async read(path: string, signal: AbortSignal): Promise<{ status: InstructionSource['status']; text: string | null }> {
    const absolute = join(this.root, path);
    try {
      let current = this.root;
      const rootStat = await lstat(current);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { status: 'unavailable', text: null };
      for (const component of path.split(sep).slice(0, -1)) {
        cancelled(signal);
        current = join(current, component);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'unavailable', text: null };
      }
      cancelled(signal);
      const observed = await lstat(absolute);
      if (!observed.isFile() || observed.isSymbolicLink() || observed.size > MAX_SOURCE_BYTES) return { status: 'unavailable', text: null };
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const start = await handle.stat();
        if (!start.isFile() || start.ino !== observed.ino || start.dev !== observed.dev || start.size > MAX_SOURCE_BYTES) return { status: 'unavailable', text: null };
        const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          cancelled(signal);
          const part = await handle.read(bytes, length, bytes.length - length, length);
          if (!part.bytesRead) break;
          length += part.bytesRead;
        }
        const end = await handle.stat();
        cancelled(signal);
        if (length > MAX_SOURCE_BYTES || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) return { status: 'unavailable', text: null };
        let parent = this.root;
        for (const component of path.split(sep).slice(0, -1)) {
          parent = join(parent, component);
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'unavailable', text: null };
        }
        const linked = await lstat(absolute);
        if (linked.isSymbolicLink() || linked.dev !== start.dev || linked.ino !== start.ino) return { status: 'unavailable', text: null };
        return { status: 'available', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) };
      } finally { await handle.close(); }
    } catch (error) {
      cancelled(signal);
      return { status: errorCode(error) === 'ENOENT' ? 'missing' : 'unavailable', text: null };
    }
  }
  /** Nested sources in Git-ignored directories are dropped; an unchecked lookup drops them all. */
  private async gitIgnored(paths: string[], signal: AbortSignal, warnings: string[]): Promise<Set<string>> {
    if (!this.ignored || !paths.length) return new Set();
    let ignored: ReadonlySet<string>;
    try { ignored = await this.ignored([...new Set(paths.map(path => posix(dirname(path))))], signal); } catch {
      cancelled(signal);
      warnings.push('Nested instruction sources were not loaded because Git ignore rules could not be checked.');
      return new Set(paths);
    }
    const excluded = new Set(paths.filter(path => ignored.has(posix(dirname(path)))));
    for (const path of excluded) warnings.push(`Instruction source ${path} is in a Git-ignored directory and was not loaded.`);
    return excluded;
  }
  async observe(paths: readonly string[], signal: AbortSignal): Promise<InstructionObservation> {
    cancelled(signal);
    const sources: InstructionSource[] = [];
    const changedSourceIds: string[] = [];
    const warnings: string[] = [];
    const observed: { source: InstructionSource; previous: InstructionSource | undefined }[] = [];
    for (const path of this.candidates(paths)) {
      const id = `instruction:${posix(path)}`;
      const previous = this.loadBaseline(id, path);
      const observation = await this.read(path, signal);
      const retained = observation.status === 'unavailable' && previous?.text !== null && previous?.text !== undefined;
      const text = retained ? previous!.text : observation.text;
      observed.push({ previous, source: { id, path, scope: dirname(path) === '.' ? '' : dirname(path), status: observation.status,
        text, sha256: text === null ? null : createHash('sha256').update(text).digest('hex'), observedAt: new Date().toISOString(), retainedBaseline: retained,
        ...(this.persistence ? { workspaceRoot: this.workspaceRoot } : {}) } });
    }
    const excluded = await this.gitIgnored(observed.filter(({ source }) => source.scope && source.text !== null).map(({ source }) => source.path), signal, warnings);
    for (const { source, previous } of observed) {
      if (excluded.has(source.path)) continue;
      if (source.status === 'unavailable') warnings.push(`Instruction source ${source.path} is unavailable${source.retainedBaseline ? '; previous baseline retained' : ''}.`);
      if (previous?.sha256 !== source.sha256) changedSourceIds.push(source.id);
      // Deleted files remove their baseline; transient failures retain the last valid text.
      if (source.status !== 'unavailable') {
        // Persist before changing the cache. A rejected write cannot become a
        // memory-only baseline that disappears after restart.
        this.persistence?.saveBaseline(structuredClone(source));
        this.baseline.set(source.id, structuredClone(source));
      }
      sources.push(source);
    }
    return { sources, changedSourceIds, warnings };
  }
}
