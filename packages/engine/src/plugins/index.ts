import { EngineError } from '@moodcode/contracts';
import { enrichLegacyToolResult } from '../artifacts/result.js';
import type { ToolDefinition } from '../ports.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
export interface PluginHostContext { id: string; signal: AbortSignal }
export interface PluginActivation { tools: readonly ToolDefinition[]; dispose?(): Promise<void> | void }
export interface EnginePlugin { id: string; activate(context: PluginHostContext): Promise<PluginActivation> }
export interface ActivePlugin { id: string; scopeId: string; toolNames: string[]; revision: number }
interface Active { descriptor: ActivePlugin; dispose: () => Promise<void>; abort: AbortController }
/** Explicit host-provided modules only; activation does not discover/install/execute files from a model path. */
export class EnginePluginManager {
  private active = new Map<string, Active>(); private pending = new Map<string, AbortController>(); private closing = false;
  private settlements = new Map<string, { promise: Promise<void>; failed: boolean }>();
  private deactivations = new Map<string, Promise<void>>();
  private disposed = new WeakMap<PluginActivation, Promise<void>>();
  constructor(private readonly runtime: ScopedToolRuntime) {}
  list(): ActivePlugin[] { return structuredClone([...this.active.values()].map(item => item.descriptor)); }
  async activate(plugin: EnginePlugin, signal: AbortSignal): Promise<ActivePlugin> {
    if (this.closing || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(plugin.id) || typeof plugin.activate !== 'function') throw new EngineError('INVALID_ENGINE_PLUGIN', 'Plugin must have a stable bounded id and an explicit host factory');
    if (this.active.has(plugin.id) || this.pending.has(plugin.id) || this.settlements.has(plugin.id) || this.deactivations.has(plugin.id)) throw new EngineError('PLUGIN_ALREADY_ACTIVE', 'Plugin id is already active or activating');
    if (this.active.size + this.settlements.size + this.deactivations.size >= 32) throw new EngineError('PLUGIN_LIMIT', 'Plugin activation limit exceeded');
    const controller = new AbortController(); const combined = AbortSignal.any([signal, controller.signal]); this.pending.set(plugin.id, controller);
    let activationDone!: () => void; let factoryDone!: () => void;
    const finished = new Promise<void>(resolve => { activationDone = resolve; }); const factory = new Promise<void>(resolve => { factoryDone = resolve; });
    const settlement = { promise: Promise.all([finished, factory]).then(() => {}), failed: false }; this.settlements.set(plugin.id, settlement);
    void settlement.promise.then(() => { if (!settlement.failed && this.settlements.get(plugin.id) === settlement) this.settlements.delete(plugin.id); });
    let factoryTracked = false;
    let activation: PluginActivation | undefined; const disposers: (() => void)[] = []; let published = false;
    try {
      if (combined.aborted) throw new EngineError('PLUGIN_CANCELLED', 'Plugin activation cancelled');
      const task = plugin.activate({ id: plugin.id, signal: combined }); let cancelled = false; factoryTracked = true;
      let detach = () => {};
      const interruption = new Promise<never>((_resolve, reject) => { const abort = () => { cancelled = true; reject(new EngineError('PLUGIN_CANCELLED', 'Plugin activation cancelled')); }; combined.addEventListener('abort', abort, { once: true }); detach = () => combined.removeEventListener('abort', abort); if (combined.aborted) abort(); });
      void task.then(async late => { if (cancelled) await this.disposeOnce(late); }, () => {}).catch(() => { settlement.failed = true; }).finally(factoryDone);
      try { activation = await Promise.race([task, interruption]); } finally { detach(); }
      if (combined.aborted || this.closing) throw new EngineError('PLUGIN_CANCELLED', 'Plugin activation cancelled');
      if (!activation || !Array.isArray(activation.tools) || activation.tools.length > 128 || activation.dispose !== undefined && typeof activation.dispose !== 'function') throw new EngineError('INVALID_ENGINE_PLUGIN', 'Plugin returned invalid activation or too many tools');
      const scopeId = `plugin_${plugin.id}`; for (const tool of activation.tools) disposers.push(this.runtime.register(scopeId, tool));
      const descriptor: ActivePlugin = { id: plugin.id, scopeId, toolNames: activation.tools.map(tool => tool.name), revision: this.runtime.revision };
      const owned = activation;
      this.active.set(plugin.id, { descriptor, abort: controller, dispose: async () => { for (const dispose of disposers.reverse()) dispose(); await this.disposeOnce(owned); } }); published = true;
      return structuredClone(descriptor);
    } catch (error) { if (!published) { for (const dispose of disposers.reverse()) dispose(); if (activation) { try { await this.disposeOnce(activation); } catch { settlement.failed = true; throw new EngineError('PLUGIN_CLEANUP_FAILED', 'Plugin registration was removed but activation cleanup failed'); } } } if (error instanceof EngineError) throw error; throw new EngineError('PLUGIN_ACTIVATION_FAILED', 'Plugin activation failed'); }
    finally { this.pending.delete(plugin.id); if (!factoryTracked) factoryDone(); activationDone(); }
  }
  async deactivate(id: string): Promise<void> {
    this.pending.get(id)?.abort(); const prior = this.deactivations.get(id); if (prior) return prior;
    const active = this.active.get(id); if (!active) return; this.active.delete(id);
    let complete!: () => void; let fail!: (error: EngineError) => void;
    const cleanup = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    this.deactivations.set(id, cleanup);
    // Publish ownership before abort callbacks can reenter; retain failed cleanup for later close.
    void cleanup.then(() => { if (this.deactivations.get(id) === cleanup) this.deactivations.delete(id); }, () => {});
    active.abort.abort();
    try { await active.dispose(); complete(); } catch { fail(new EngineError('PLUGIN_CLEANUP_FAILED', 'Plugin registration was removed but cleanup failed')); }
    return cleanup;
  }
  private disposeOnce(activation: PluginActivation): Promise<void> { if (!activation || typeof activation !== 'object' || typeof activation.dispose !== 'function') return Promise.resolve(); let task = this.disposed.get(activation); if (!task) { task = Promise.resolve().then(() => activation.dispose!()).catch(() => { throw new EngineError('PLUGIN_CLEANUP_FAILED', 'Plugin activation cleanup failed'); }); this.disposed.set(activation, task); } return task; }
  async close(): Promise<void> {
    this.closing = true; const pending = [...this.settlements.values()]; for (const controller of this.pending.values()) controller.abort();
    const cleanup = Promise.allSettled([...this.deactivations.values(), ...[...this.active.keys()].map(id => this.deactivate(id))]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const results = await Promise.race([Promise.all([cleanup, ...pending.map(item => item.promise)]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new EngineError('PLUGIN_ACTIVATION_UNCERTAIN', 'Plugin shutdown could not confirm pending activation or teardown within its cleanup budget')), 1000); })]); if (results[0]!.some(result => result.status === 'rejected') || pending.some(item => item.failed)) throw new EngineError('PLUGIN_CLEANUP_FAILED', 'One or more plugin cleanups failed after registration removal'); }
    finally { if (timer) clearTimeout(timer); }
  }
}
export interface ToolHookMetadata { pluginId: string; toolName: string; runId: string; toolCallId: string; fingerprint?: string; outcome?: 'completed' | 'failed' }
export interface PluginToolHooks { prepared?(metadata: ToolHookMetadata): Promise<void> | void; settled?(metadata: ToolHookMetadata): Promise<void> | void }
/** Hooks observe metadata; they cannot rewrite the prepared fingerprint or receive host credentials. */
export function observePluginTool(pluginId: string, source: ToolDefinition, hooks: PluginToolHooks): ToolDefinition {
  return { name: source.name, description: source.description, inputSchema: structuredClone(source.inputSchema), ...(source.effectClass ? { effectClass: source.effectClass } : {}),
    async prepare(input, context) { const prepared = await source.prepare(input, context); await hooks.prepared?.({ pluginId, toolName: source.name, runId: context.runId, toolCallId: context.toolCallId, fingerprint: prepared.fingerprint }); return prepared; },
    async execute(prepared, context) { const result = await source.execute(prepared, context); try { await hooks.settled?.({ pluginId, toolName: source.name, runId: context.runId, toolCallId: context.toolCallId, fingerprint: prepared.fingerprint, outcome: result.isError ? 'failed' : 'completed' }); return result; } catch { return enrichLegacyToolResult(result, { warnings: ['Plugin settlement hook failed after the producer returned its result.'] }); } } };
}
