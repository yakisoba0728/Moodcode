import type { EngineCapabilities } from "@moodcode/contracts";
import type { AgentProfiles } from "./agents/index.js";
import type { EngineChildren } from "./child-tasks/engine-host.js";
import type { LifecycleHookRegistry } from "./lifecycle/index.js";
import type { RepositoryContextService } from "./repository/index.js";
import type { RunCoordinator } from "./runner/index.js";
import type { InputScheduler } from "./runner/input-scheduler.js";
import type { SqliteStore } from "./storage/index.js";
import type { TerminalService } from "./terminals/index.js";
import type { ScopedToolRuntime } from "./tools/runtime/index.js";
import type {
  VerificationCheckRegistry,
  VerificationPlanService,
} from "./verification/index.js";

/** The root engine members feature producers depend on; MoodcodeEngine implements it. */
export interface EngineRuntime {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly scheduler: InputScheduler;
  readonly profiles: AgentProfiles;
  readonly toolRuntime: ScopedToolRuntime;
  readonly children: EngineChildren;
  readonly terminals: TerminalService;
  readonly verificationChecks: VerificationCheckRegistry;
  readonly verificationPlans: VerificationPlanService;
  readonly repository: RepositoryContextService;
  readonly lifecycleHooks: LifecycleHookRegistry;
  getCapabilities(): EngineCapabilities;
}
