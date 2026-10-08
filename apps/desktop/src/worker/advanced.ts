import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, isAbsolute, resolve, relative } from 'node:path';
import { EngineError, type JsonObject, type JsonValue, type Workspace } from '@moodcode/contracts';
import { McpClient, StdioMcpTransport, HttpMcpTransport, StdioLspConnection, type MoodcodeEngine } from '@moodcode/engine';
import { validateAdvancedAction, type DesktopAdvancedAction, type DesktopAdvancedSnapshot, type DesktopAdvancedPreview } from '../shared/advanced.js';

export const ADVANCED_LIMITS = Object.freeze({ handles: 256, ownerHandles: 32, ttlMs: 300_000, responseBytes: 1_048_576, connections: 16 });
interface Handle {
  owner: string; sessionId: string; kind: string; expires: number; source: string;
  original: object; preview: JsonValue; launch?: string; release(): void;
}
interface Owner { controller: AbortController; pending: number }
type McpView = { id: string; transport: string; connected: boolean; toolNames: string[]; resources: JsonValue };
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function data(value: unknown): JsonValue {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > ADVANCED_LIMITS.responseBytes) fail('DESKTOP_RESPONSE_LIMIT', 'Advanced result exceeds the desktop page limit.');
  return JSON.parse(encoded) as JsonValue;
}
function fields(input: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 'Advanced action contains an unsupported field.');
}
function string(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT', `${name} must be bounded text.`);
  return value;
}
function requestId(p: JsonObject): string { return p.requestId === undefined ? randomUUID() : string(p.requestId, 'requestId'); }
function args(p: JsonObject): string[] {
  const value = p.args ?? [];
  if (!Array.isArray(value) || value.length > 64 || value.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 8192 || /[\u0000]/u.test(arg))) fail('INVALID_INPUT', 'Process arguments must be a bounded text array.');
  return value as string[];
}
function launchSource(file: string, cwd: string): string {
  const executable = realpathSync(file), executableStat = statSync(executable), directory = realpathSync(cwd), directoryStat = statSync(directory);
  if (!executableStat.isFile() || executableStat.size > 1_073_741_824 || !directoryStat.isDirectory()) fail('INVALID_INPUT', 'Select a bounded executable and existing directory.');
  const hash = createHash('sha256'), fd = openSync(executable, 'r'), chunk = Buffer.alloc(65_536);
  try { let count: number; while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count)); }
  finally { closeSync(fd); }
  const current = statSync(executable);
  if (current.ino !== executableStat.ino || current.mtimeMs !== executableStat.mtimeMs || current.ctimeMs !== executableStat.ctimeMs) fail('DESKTOP_SOURCE_STALE', 'Executable changed while preparing the preview.');
  return JSON.stringify([executable, current.dev, current.ino, current.size, current.mtimeMs, current.ctimeMs, hash.digest('hex'), directory, directoryStat.dev, directoryStat.ino]);
}

/** Utility-owned originals survive only their source, sender generation and bounded lifetime. */
export class AdvancedService {
  readonly #handles = new Map<string, Handle>();
  readonly #owners = new Map<string, Owner>();
  readonly #dropped = new Map<string, number>();
  readonly #mcp = new Map<string, { sessionId: string; client: McpClient; view: McpView }>();
  readonly #lsp = new Map<string, { sessionId: string; extensions: Record<string, string> }>();
  constructor(readonly engine: MoodcodeEngine) {}
  get handleCount(): number { return this.#handles.size; }
  #workspace(sessionId: string): Workspace { return this.engine.store.getWorkspace(this.engine.store.getSession(sessionId).workspaceId); }
  #source(sessionId: string): string {
    const workspace = this.#workspace(sessionId), root = realpathSync(workspace.root), stat = statSync(root);
    return createHash('sha256').update(JSON.stringify([sessionId, workspace.id, root, stat.dev, stat.ino])).digest('hex');
  }
  #sweep(): void { for (const [id, entry] of this.#handles) if (entry.expires <= Date.now()) this.#release(id); }
  #release(id: string): void {
    const entry = this.#handles.get(id);
    if (!entry) return;
    this.#handles.delete(id);
    entry.release();
  }
  #pin(owner: string, sessionId: string, kind: string, original: object, preview: unknown, release: () => void = () => {}, launch?: string): DesktopAdvancedPreview {
    this.#sweep();
    const state = this.#owners.get(owner);
    if (!state || state.controller.signal.aborted) { release(); fail('DESKTOP_OWNER_DROPPED', 'The desktop window changed during this operation.'); }
    if (this.#handles.size >= ADVANCED_LIMITS.handles || [...this.#handles.values()].filter(entry => entry.owner === owner).length >= ADVANCED_LIMITS.ownerHandles) {
      release(); fail('DESKTOP_HANDLE_LIMIT', 'Release an existing preview before creating another.');
    }
    const handleId = randomUUID(), expires = Date.now() + ADVANCED_LIMITS.ttlMs;
    let publicPreview: JsonValue, source: string;
    try { publicPreview = data(preview); source = this.#source(sessionId); }
    catch (error) { release(); throw error; }
    this.#handles.set(handleId, { owner, sessionId, kind, original, preview: publicPreview, release, expires, source, ...(launch ? { launch } : {}) });
    return { handleId, kind, expiresAt: new Date(expires).toISOString(), preview: publicPreview };
  }
  #take(owner: string, sessionId: string, p: JsonObject, kind: string): Handle {
    const entry = this.#get(owner, sessionId, p, kind);
    this.#handles.delete(string(p.handleId, 'handleId'));
    if (entry.launch) {
      const selection = entry.original as { file: string; cwd?: string };
      try { if (entry.launch !== launchSource(selection.file, resolve(this.#workspace(sessionId).root, selection.cwd ?? '.'))) fail('DESKTOP_SOURCE_STALE', 'Executable or launch directory changed. Review a new preview.'); }
      catch (error) { entry.release(); throw error; }
    }
    return entry;
  }
  #get(owner: string, sessionId: string, p: JsonObject, kind?: string): Handle {
    this.#sweep();
    const id = string(p.handleId, 'handleId'), entry = this.#handles.get(id);
    if (!entry || entry.owner !== owner || entry.sessionId !== sessionId || kind && entry.kind !== kind) fail('DESKTOP_HANDLE_INVALID', 'The preview belongs to another window or is no longer available.');
    if (entry.source !== this.#source(sessionId)) { this.#release(id); fail('DESKTOP_SOURCE_STALE', 'The workspace source changed. Review a new preview.'); }
    return entry;
  }
  #approved(p: JsonObject): void { if (p.approved !== true) fail('DESKTOP_APPROVAL_REQUIRED', 'Confirm the displayed exact preview before continuing.'); }
  async dropOwner(owner: string): Promise<void> {
    this.#dropped.set(owner, Date.now());
    while (this.#dropped.size > 1024) this.#dropped.delete(this.#dropped.keys().next().value!);
    const state = this.#owners.get(owner);
    state?.controller.abort();
    for (const [id, entry] of this.#handles) if (entry.owner === owner) this.#release(id);
    if (!state?.pending) this.#owners.delete(owner);
  }
  async close(): Promise<void> {
    for (const owner of this.#owners.keys()) await this.dropOwner(owner);
    for (const id of this.#handles.keys()) this.#release(id);
  }
  async #session(type: string, sessionId: string, payload: JsonObject = {}): Promise<JsonValue> {
    const result = await this.engine.dispatchSession({ schemaVersion: 2, commandId: randomUUID(), type, payload: { ...payload, sessionId } });
    if (!result.ok) fail(result.error?.code ?? 'DESKTOP_ADVANCED_FAILED', result.error?.message ?? 'The advanced engine command failed.');
    return result.result ?? null;
  }
  #catalog(sessionId: string): { teams: string[]; workflows: string[]; instances: string[] } {
    const stored = this.engine.store.getSessionDocument(sessionId, 'desktop.advanced.catalog')?.data;
    return { teams: Array.isArray(stored?.teams) ? stored.teams as string[] : [], workflows: Array.isArray(stored?.workflows) ? stored.workflows as string[] : [], instances: Array.isArray(stored?.instances) ? stored.instances as string[] : [] };
  }
  #remember(sessionId: string, kind: 'teams' | 'workflows' | 'instances', id: string): void {
    const catalog = this.#catalog(sessionId);
    if (catalog[kind].includes(id)) return;
    if (catalog[kind].length >= 64) fail('DESKTOP_CATALOG_LIMIT', 'The desktop session catalog is full.');
    catalog[kind].push(id);
    const previous = this.engine.store.getSessionDocument(sessionId, 'desktop.advanced.catalog');
    this.engine.store.putSessionDocument(sessionId, 'desktop.advanced.catalog', previous?.revision ?? 0, catalog);
  }
  async snapshot(sessionId: string): Promise<DesktopAdvancedSnapshot> {
    const workspace = this.#workspace(sessionId), catalog = this.#catalog(sessionId);
    const [inbox, tasks, questions, diagnostics, terminalCapability] = await Promise.all([
      this.#session('input.list', sessionId, { limit: 100 }), this.#session('session.getTasks', sessionId), this.#session('question.list', sessionId),
      this.#session('session.getDiagnostics', sessionId), this.engine.terminals.capability(),
    ]);
    const latestRun = this.engine.store.getSnapshot(sessionId).runs.at(-1);
    const executionObservations = latestRun ? this.engine.getExecutionObservations({ workspaceId: workspace.id, runId: latestRun.id, limit: 16, maxBytes: 65_536 }) : null;
    return data({
      sessionId, workspaceId: workspace.id, inbox, tasks, questions, diagnostics: data({ ...(diagnostics as JsonObject), executionObservations }),
      control: data(this.engine.store.getSessionControl(sessionId)),
      terminals: data(this.engine.terminals.list({ authority: 'user', workspaceId: workspace.id, sessionId })), terminalCapability: data(terminalCapability),
      children: data(this.engine.children.tasks.list(sessionId).map(task => ({ ...task, resident: this.engine.inspectResidentChildTask(sessionId, task.id) }))), worktrees: data(this.engine.children.worktrees.list(sessionId)),
      teams: data(catalog.teams.map(id => ({ team: this.engine.getTeam(workspace.id, id), members: this.engine.listTeamMembers(workspace.id, id), tasks: this.engine.listTeamTasks(workspace.id, id) }))),
      workflows: data({ specs: catalog.workflows.map(id => this.engine.getWorkflow(workspace.id, id)), instances: catalog.instances.map(id => this.engine.inspectWorkflow(workspace.id, id)) }),
      mcp: data([...this.#mcp.values()].filter(entry => entry.sessionId === sessionId).map(entry => ({ ...entry.view, connected: entry.client.connected }))),
      languageServers: data([...this.#lsp].filter(([, entry]) => entry.sessionId === sessionId).map(([id, entry]) => ({ id, extensions: entry.extensions }))),
    }) as unknown as DesktopAdvancedSnapshot;
  }
  async action(owner: string, input: DesktopAdvancedAction): Promise<JsonValue> {
    const request = validateAdvancedAction(input), { sessionId, type } = request, p = request.payload ?? {};
    if (this.#dropped.has(owner)) fail('DESKTOP_OWNER_DROPPED', 'The desktop window changed.');
    this.#workspace(sessionId);
    let state = this.#owners.get(owner);
    if (state?.controller.signal.aborted) fail('DESKTOP_OWNER_DROPPED', 'The desktop window changed.');
    if (!state) {
      if (this.#owners.size >= 128) fail('DESKTOP_OWNER_LIMIT', 'Too many desktop windows have pending operations.');
      this.#owners.set(owner, state = { controller: new AbortController(), pending: 0 });
    }
    state.pending++;
    try { return data(await this.#action(owner, sessionId, type, p, state.controller.signal)); }
    finally { state.pending--; if (!state.pending && state.controller.signal.aborted) this.#owners.delete(owner); }
  }
  async #action(owner: string, sessionId: string, type: DesktopAdvancedAction['type'], p: JsonObject, signal: AbortSignal): Promise<unknown> {
    const workspace = this.#workspace(sessionId), terminalOwner = { authority: 'user' as const, workspaceId: workspace.id, sessionId };
    if (signal.aborted) fail('DESKTOP_OWNER_DROPPED', 'The desktop window changed.');
    switch (type) {
      case 'input.accept': fields(p, ['requestId','prompt','delivery','config']); return this.#session(type, sessionId, { ...p, requestId: requestId(p) });
      case 'input.cancel': fields(p, ['inputId']); return this.#session(type, sessionId, p);
      case 'session.pause': case 'session.resume': fields(p, []); return this.#session(type, sessionId);
      case 'tasks.replace': fields(p, ['expectedRevision','tasks']); return this.#session('session.setTasks', sessionId, p);
      case 'question.answer': fields(p, ['questionId','version','answer']); return this.#session(type, sessionId, p);
      case 'question.reject': fields(p, ['questionId','version']); return this.#session(type, sessionId, p);
      case 'handle.release': {
        fields(p, ['handleId']); this.#get(owner, sessionId, p); this.#release(string(p.handleId, 'handleId')); return null;
      }
      case 'terminal.preview': {
        fields(p, ['file','args','cwd','cols','rows']);
        const file = realpathSync(p.file === undefined ? process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe') : '/bin/sh' : string(p.file, 'file', 4096));
        const cwd = realpathSync(resolve(workspace.root, p.cwd ? string(p.cwd, 'cwd', 4096) : '.')), displacement = relative(workspace.root, cwd);
        if (displacement === '..' || displacement.startsWith('../') || displacement.startsWith('..\\') || isAbsolute(displacement)) fail('TERMINAL_CWD_OUTSIDE_WORKSPACE', 'Choose a launch directory inside this workspace.');
        const selection = { owner: terminalOwner, file, args: args(p), cwd, ...(p.cols ? { cols: p.cols as number } : {}), ...(p.rows ? { rows: p.rows as number } : {}) };
        return this.#pin(owner, sessionId, 'terminal.create', selection, { ...selection, authority: 'host-user', isolation: 'host-user' }, undefined, launchSource(file, cwd));
      }
      case 'terminal.create': {
        fields(p, ['handleId','approved']); this.#approved(p);
        const entry = this.#take(owner, sessionId, p, 'terminal.create');
        const startup = new AbortController(), dropped = () => startup.abort();
        signal.addEventListener('abort', dropped, { once: true });
        let terminal;
        try { terminal = await this.engine.terminals.create({ ...(entry.original as Parameters<MoodcodeEngine['terminals']['create']>[0]), signal: startup.signal }); }
        finally { signal.removeEventListener('abort', dropped); entry.release(); }
        const control = this.#pin(owner, sessionId, 'terminal.control', { terminalId: terminal.id }, terminal);
        return { terminal, handleId: control.handleId, expiresAt: control.expiresAt };
      }
      case 'terminal.attach': {
        fields(p, ['terminalId','approved']); this.#approved(p);
        const terminal = this.engine.terminals.get(string(p.terminalId, 'terminalId'), terminalOwner);
        return this.#pin(owner, sessionId, 'terminal.control', { terminalId: terminal.id }, terminal);
      }
      case 'terminal.read': fields(p, ['terminalId','afterSeq']); return this.engine.terminals.replay(string(p.terminalId, 'terminalId'), terminalOwner, p.afterSeq as number | undefined, 65_536);
      case 'terminal.write': case 'terminal.resize': case 'terminal.cancel': {
        fields(p, type === 'terminal.write' ? ['handleId','data'] : type === 'terminal.resize' ? ['handleId','cols','rows'] : ['handleId']);
        const entry = this.#get(owner, sessionId, p, 'terminal.control'), id = (entry.original as { terminalId: string }).terminalId;
        if (type === 'terminal.write') { await this.engine.terminals.write(id, terminalOwner, p.data as string); return this.engine.terminals.get(id, terminalOwner); }
        if (type === 'terminal.resize') return this.engine.terminals.resize(id, terminalOwner, p.cols as number, p.rows as number);
        return this.engine.terminals.cancel(id, terminalOwner);
      }
      case 'mcp.preview': case 'lsp.preview': {
        fields(p, type === 'mcp.preview' ? ['id','transport','file','args','url','protocolVersion'] : ['id','file','args','extensions']);
        const id = string(p.id, 'id', 32);
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail('INVALID_INPUT', 'Connection ID is invalid.');
        const selection: JsonObject = { ...p, id, args: args(p) };
        if (type === 'mcp.preview' && p.transport === 'http') new HttpMcpTransport({ url: string(p.url, 'url', 4096) });
        else {
          if (type === 'mcp.preview' && p.transport !== 'stdio') fail('INVALID_INPUT', 'Select stdio or HTTP transport.');
          const file = string(p.file, 'file', 4096);
          if (!isAbsolute(file)) fail('INVALID_INPUT', 'Choose an absolute executable path.');
          selection.file = realpathSync(file);
          if (!statSync(selection.file).isFile()) fail('INVALID_INPUT', 'Executable must be a regular file.');
        }
        if (type === 'lsp.preview') {
          if (!p.extensions || typeof p.extensions !== 'object' || Array.isArray(p.extensions) || Object.entries(p.extensions).some(([extension, language]) => !/^\.[A-Za-z0-9_-]{1,16}$/.test(extension) || typeof language !== 'string' || !/^[A-Za-z0-9+_.-]{1,64}$/.test(language))) fail('INVALID_INPUT', 'Language extensions must map file suffixes to language IDs.');
        }
        return this.#pin(owner, sessionId, type === 'mcp.preview' ? 'mcp.connect' : 'lsp.connect', selection, selection, undefined, selection.file ? launchSource(selection.file as string, workspace.root) : undefined);
      }
      case 'mcp.connect': {
        fields(p, ['handleId','approved']); this.#approved(p); const entry = this.#take(owner, sessionId, p, type), selection = entry.original as JsonObject;
        const id = selection.id as string;
        if (this.#mcp.size >= ADVANCED_LIMITS.connections || this.#mcp.has(id)) fail('DESKTOP_CONNECTION_LIMIT', 'Disconnect the existing MCP connection before reconnecting.');
        const protocolVersion = selection.protocolVersion as '2026-07-28' | '2025-11-25' | undefined;
        const client = new McpClient({ id, ...(protocolVersion ? { protocolVersion } : {}), transport: selection.transport === 'http'
          ? new HttpMcpTransport({ url: selection.url as string, ...(protocolVersion ? { protocolVersion } : {}) })
          : new StdioMcpTransport({ command: selection.file as string, args: selection.args as string[], cwd: workspace.root }) });
        try {
          const registration = await this.engine.connectMcp(client, signal);
          if (signal.aborted) { await this.engine.disconnectMcp(id); fail('DESKTOP_OWNER_DROPPED', 'The desktop window changed during connection.'); }
          const view = { id, transport: selection.transport as string, connected: true, toolNames: registration.toolNames, resources: data(registration.resources) };
          this.#mcp.set(id, { sessionId, client, view }); return view;
        } catch (error) { await client.close(); throw error; }
        finally { entry.release(); }
      }
      case 'mcp.disconnect': {
        fields(p, ['id']); const id = string(p.id, 'id'), entry = this.#mcp.get(id);
        if (!entry || entry.sessionId !== sessionId) fail('RECORD_SCOPE_MISMATCH', 'MCP connection belongs to another session.');
        await this.engine.disconnectMcp(id); this.#mcp.delete(id); return null;
      }
      case 'lsp.connect': {
        fields(p, ['handleId','approved']); this.#approved(p); const entry = this.#take(owner, sessionId, p, type), selection = entry.original as JsonObject, id = selection.id as string;
        if (this.#lsp.size >= ADVANCED_LIMITS.connections || this.#lsp.has(id)) fail('DESKTOP_CONNECTION_LIMIT', 'Language server ID is already registered.');
        const extensions = selection.extensions as Record<string, string>;
        this.engine.registerLanguageServer(id, async (source, abort) => {
          if (source.id !== workspace.id || source.root !== workspace.root || abort.aborted || entry.launch !== launchSource(selection.file as string, source.root)) fail('DESKTOP_SOURCE_STALE', 'Language server is bound to its original workspace and executable.');
          return StdioLspConnection.open({ command: selection.file as string, args: selection.args as string[], cwd: source.root });
        }, path => extensions[extname(path)] ?? null);
        this.#lsp.set(id, { sessionId, extensions }); entry.release();
        await this.engine.watchWorkspace(workspace.id); return { id, extensions };
      }
      case 'lsp.diagnostics': {
        fields(p, ['id','path']); const path = string(p.path, 'path', 4096), results = [];
        for (const [id, entry] of this.#lsp) if (entry.sessionId === sessionId && (p.id === undefined || p.id === id)) {
          const language = entry.extensions[extname(path)];
          if (!language) continue;
          await this.engine.lsp.updateFile(workspace, id, path, language, signal);
          results.push({ id, snapshot: this.engine.lsp.diagnostics(workspace, id, path) });
        }
        return results;
      }
      case 'worktree.create': fields(p, ['requestId','reference']); return this.engine.createWorktree(sessionId, requestId(p), p.reference as string | undefined);
      case 'worktree.cleanup': fields(p, ['worktreeId']); return this.engine.cleanupWorktree(sessionId, string(p.worktreeId, 'worktreeId'));
      case 'child.preview': {
        fields(p, ['requestId','parentRunId','worktreeId','prompt','tools','allocation']);
        if (this.engine.store.getSessionControl(sessionId).paused) fail('RESIDENT_PARENT_STALE', 'Resume the session before approving a resident child.');
        const original = this.engine.previewResidentChildTask({ sessionId, requestId: requestId(p), parentRunId: string(p.parentRunId, 'parentRunId'), worktreeId: string(p.worktreeId, 'worktreeId'), prompt: string(p.prompt, 'prompt', 16_384), tools: (p.tools ?? []) as string[], allocation: (p.allocation ?? { turns: 2, toolCalls: 8, outputBytes: 8192, durationMs: 30_000 }) as unknown as Parameters<MoodcodeEngine['previewResidentChildTask']>[0]['allocation'] });
        return this.#pin(owner, sessionId, 'child.start', original, this.engine.readResidentChildTaskPreview(original), () => this.engine.releaseResidentChildTaskPreview(original));
      }
      case 'child.start': {
        fields(p, ['handleId','approved']); this.#approved(p); const entry = this.#take(owner, sessionId, p, type);
        try { return await this.engine.startResidentChildTask(entry.original, true); } finally { entry.release(); }
      }
      case 'child.stop': case 'child.cancel': {
        fields(p, ['taskId']); const taskId = string(p.taskId, 'taskId');
        const resident = this.engine.inspectResidentChildTask(sessionId, taskId);
        if (type === 'child.stop' && !resident) fail('RESIDENT_OWNER_UNAVAILABLE', 'This task has no live resident child owner.');
        return resident && ['running','idle'].includes(resident.state) ? this.engine.stopResidentChildTask(sessionId, taskId) : this.engine.children.tasks.cancel(sessionId, taskId);
      }
      case 'team.create': {
        fields(p, ['requestId','teamId','expiresAt']);
        const result = this.engine.createTeam({ workspaceId: workspace.id, requestId: requestId(p), ...(p.teamId ? { teamId: p.teamId as string } : {}), expiresAt: (p.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString()) as string });
        this.#remember(sessionId, 'teams', result.record.id); return result;
      }
      case 'team.inspect': {
        fields(p, ['teamId']); const id = string(p.teamId, 'teamId');
        return { team: this.engine.getTeam(workspace.id, id), members: this.engine.listTeamMembers(workspace.id, id), tasks: this.engine.listTeamTasks(workspace.id, id) };
      }
      case 'team.member.preview': {
        fields(p, ['teamId','memberId','role','permissions','expectedRevision','expiresAt','childTaskId']);
        const original = this.engine.previewTeamMember({ ...p, workspaceId: workspace.id, rootSessionId: sessionId, expiresAt: p.expiresAt ?? new Date(Date.now() + 600_000).toISOString(), signal } as unknown as Parameters<MoodcodeEngine['previewTeamMember']>[0]);
        return this.#pin(owner, sessionId, 'team.member.join', original, original, () => this.engine.releaseTeamMemberPreview(original));
      }
      case 'team.member.join': {
        fields(p, ['handleId','approved','requestId']); this.#approved(p); const entry = this.#get(owner, sessionId, p, type);
        const result = this.engine.joinTeamMember({ workspaceId: workspace.id, requestId: requestId(p), approved: true, preview: entry.original as Parameters<MoodcodeEngine['joinTeamMember']>[0]['preview'], signal });
        this.#release(string(p.handleId, 'handleId')); return result;
      }
      case 'team.tasks.put': case 'team.tasks.claim': case 'team.tasks.complete': case 'team.message.send': case 'team.mailbox.read': {
        const memberId = string(type === 'team.message.send' ? p.senderMemberId : p.memberId, 'memberId'), teamId = string(p.teamId, 'teamId');
        const member = this.engine.getTeamMember(workspace.id, teamId, memberId);
        if (!member || member.owner.rootSessionId !== sessionId) fail('RECORD_SCOPE_MISMATCH', 'Team actor belongs to another root session.');
        const binding = { ...p, workspaceId: workspace.id, requestId: requestId(p) };
        if (type === 'team.tasks.put') return this.engine.putTeamTask(binding as unknown as Parameters<MoodcodeEngine['putTeamTask']>[0]);
        if (type === 'team.tasks.claim') return this.engine.claimTeamTask(binding as unknown as Parameters<MoodcodeEngine['claimTeamTask']>[0]);
        if (type === 'team.tasks.complete') return this.engine.completeTeamTask(binding as unknown as Parameters<MoodcodeEngine['completeTeamTask']>[0]);
        if (type === 'team.message.send') return this.engine.sendAgentMessage(binding as unknown as Parameters<MoodcodeEngine['sendAgentMessage']>[0]);
        const { requestId: _requestId, ...read } = binding;
        const page = this.engine.readAgentMailbox(read as unknown as Parameters<MoodcodeEngine['readAgentMailbox']>[0]);
        return this.#pin(owner, sessionId, 'team.mailbox.claim', page, page, () => this.engine.releaseAgentMailboxPage(page));
      }
      case 'team.mailbox.claim': {
        fields(p, ['handleId','expectedCursorRevision','requestId']); const entry = this.#get(owner, sessionId, p, type);
        const result = this.engine.claimAgentMailbox({ workspaceId: workspace.id, page: entry.original as Parameters<MoodcodeEngine['claimAgentMailbox']>[0]['page'], requestId: requestId(p), expectedCursorRevision: p.expectedCursorRevision as number });
        this.#release(string(p.handleId, 'handleId')); return result;
      }
      case 'workflow.register': {
        fields(p, ['requestId','expectedRevision','spec']); const result = this.engine.registerWorkflow({ ...p, workspaceId: workspace.id, requestId: requestId(p) } as unknown as Parameters<MoodcodeEngine['registerWorkflow']>[0]);
        this.#remember(sessionId, 'workflows', result.record.workflowId); return result;
      }
      case 'workflow.preview': {
        fields(p, ['parentRunId','workflowId','expectedSpecRevision','parameters','stageWorktrees']);
        if (this.engine.store.getSessionControl(sessionId).paused) fail('WORKFLOW_OWNER_STALE', 'Resume the session before approving a workflow.');
        const original = await this.engine.previewWorkflowStart({ ...p, workspaceId: workspace.id, rootSessionId: sessionId, signal } as unknown as Parameters<MoodcodeEngine['previewWorkflowStart']>[0]);
        return this.#pin(owner, sessionId, 'workflow.start', original, original, () => this.engine.releaseWorkflowStartPreview(original));
      }
      case 'workflow.start': {
        fields(p, ['handleId','approved','requestId']); this.#approved(p); const entry = this.#get(owner, sessionId, p, type);
        const result = this.engine.startWorkflow({ workspaceId: workspace.id, requestId: requestId(p), approved: true, preview: entry.original as Parameters<MoodcodeEngine['startWorkflow']>[0]['preview'], signal });
        this.#remember(sessionId, 'instances', result.record.instanceId); this.#release(string(p.handleId, 'handleId')); return result;
      }
      case 'workflow.stage.start': case 'workflow.stage.observe': case 'workflow.inspect': {
        fields(p, type === 'workflow.inspect' ? ['instanceId'] : ['instanceId','stageId','expectedRevision','requestId','approved']);
        const id = string(p.instanceId, 'instanceId'), record = this.engine.inspectWorkflow(workspace.id, id);
        if (!record || record.owner.sessionId !== sessionId) fail('RECORD_SCOPE_MISMATCH', 'Workflow belongs to another session.');
        if (type === 'workflow.inspect') return record;
        const input = { ...p, workspaceId: workspace.id, requestId: requestId(p), signal };
        if (type === 'workflow.stage.start') { this.#approved(p); return this.engine.startWorkflowStage(input as unknown as Parameters<MoodcodeEngine['startWorkflowStage']>[0]); }
        const observation = { ...input } as typeof input & { approved?: JsonValue }; delete observation.approved;
        return this.engine.observeWorkflowStage(observation as unknown as Parameters<MoodcodeEngine['observeWorkflowStage']>[0]);
      }
    }
  }
}
