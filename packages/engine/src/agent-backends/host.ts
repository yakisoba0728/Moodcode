import { EngineError } from "@moodcode/contracts";
import type { ProviderAdapter } from "../ports.js";
import type { BackendNativeClientEffectPort } from "./client-effects.js";
import type { BackendProcessPort } from "./process.js";
import type {
  ActualBackendTurnPort,
  AgentBackendRevision,
  AgentBackendStorage,
} from "./store.js";
import { AgentBackendRemote } from "./remote.js";

export interface AgentBackendHostOptions {
  store: AgentBackendStorage;
  processes: BackendProcessPort;
  clientReads: BackendNativeClientEffectPort;
  turns: ActualBackendTurnPort;
  lifetime?: AbortSignal;
  clientEffectsEnabled?: boolean;
  terminalEffectsEnabled?: boolean;
}

/** Root constructs this host; registered descriptions alone cannot construct runtime ports. */
export class AgentBackendHost {
  private readonly lifetime = new AbortController();
  private readonly providers = new Map<
    string,
    { revisionId: string; provider: ProviderAdapter }
  >();
  private readonly parentAbort: () => void;
  constructor(private readonly options: AgentBackendHostOptions) {
    this.parentAbort = () =>
      this.lifetime.abort(
        options.lifetime?.reason ??
          new EngineError("BACKEND_CLOSED", "Backend root lifetime ended"),
      );
    options.lifetime?.addEventListener("abort", this.parentAbort, {
      once: true,
    });
    if (options.lifetime?.aborted) this.parentAbort();
  }
  provider(record: AgentBackendRevision): ProviderAdapter {
    if (this.lifetime.signal.aborted)
      throw new EngineError("BACKEND_CLOSED", "The backend host is closed");
    const current = this.options.store.getBackend(
      record.workspaceId,
      record.backendId,
    );
    if (
      !current ||
      current.id !== record.id ||
      current.sha256 !== record.sha256 ||
      !current.enabled
    )
      throw new EngineError(
        "BACKEND_DISABLED",
        "The backend registration is not current and enabled",
      );
    const prior = this.providers.get(record.backendId);
    if (prior?.revisionId === record.id) return prior.provider;
    const provider = new AgentBackendRemote({
      ...this.options,
      record: current,
      lifetime: this.lifetime.signal,
    });
    this.providers.set(record.backendId, { revisionId: record.id, provider });
    return provider;
  }
  async close(): Promise<void> {
    this.options.lifetime?.removeEventListener("abort", this.parentAbort);
    this.lifetime.abort(
      new EngineError("BACKEND_CLOSED", "The backend host is closing"),
    );
    this.providers.clear();
    await this.options.processes.close();
  }
}
