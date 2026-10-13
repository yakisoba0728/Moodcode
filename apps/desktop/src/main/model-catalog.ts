import { fetchModelCatalog, parseModelCatalog, MODEL_CATALOG_URL, type ModelCatalog } from '@moodcode/engine';
import { readPrivateJson, writePrivateJson } from './private-json.js';

/** Optional public metadata; losing this cache must never prevent offline engine startup. */
export class DesktopModelCatalog {
  #catalog: ModelCatalog | null = null;
  #refresh?: Promise<ModelCatalog>;
  constructor(private readonly directory: string, private readonly fetcher: typeof fetch = fetch) {}
  get(): ModelCatalog | null { return structuredClone(this.#catalog); }
  async load(): Promise<void> {
    try {
      const cached = await readPrivateJson(this.directory, 'model-catalog.json', 8 * 1024 * 1024) as ModelCatalog | undefined;
      if (!cached || cached.source !== MODEL_CATALOG_URL || !Array.isArray(cached.providers) || cached.providers.length > 16) return;
      const raw = Object.fromEntries(cached.providers.map(p => [p.id === 'openai-responses' ? 'openai' : p.id, { name: p.name, models: Object.fromEntries(p.models.map(m => [m.id, {
        id: m.id, name: m.name, limit: { context: m.contextWindow, output: m.maxOutputTokens }, tool_call: m.tools, reasoning: m.reasoning,
        modalities: { input: m.input, output: m.output }, status: m.deprecated ? 'deprecated' : 'active',
      }])) }]));
      this.#catalog = parseModelCatalog(raw, cached.observedAt);
    } catch { this.#catalog = null; }
  }
  refresh(): Promise<ModelCatalog> {
    return this.#refresh ??= this.#fetch().finally(() => { this.#refresh = undefined; });
  }
  async #fetch(): Promise<ModelCatalog> {
    const next = await fetchModelCatalog(this.fetcher);
    await writePrivateJson(this.directory, 'model-catalog.json', next, 8 * 1024 * 1024);
    this.#catalog = next;
    return this.get()!;
  }
}
