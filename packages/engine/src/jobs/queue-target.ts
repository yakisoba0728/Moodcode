import type { RunConfig } from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { validateScheduleTarget } from "../schedules/spec.js";
import type { ScheduleTargetPin } from "../schedules/types.js";
import { EngineError } from "@moodcode/contracts";

/** Shared descriptive queue pins; each producer retains its own ORIGINAL authority. */
export function describeEngineQueueTarget(
  engine: MoodcodeEngine,
  readBinding: (workspaceId: string) => KnowledgeHostBinding,
  workspaceId: string,
  sessionId: string,
  input: RunConfig,
): ScheduleTargetPin {
  const config = { ...input, budgets: normalizeEngineBudgets(input.budgets) };
  const binding = readBinding(workspaceId),
    session = engine.store.getSession(sessionId);
  if (session.workspaceId !== workspaceId)
    throw new EngineError(
      "JOB_TARGET_STALE",
      "The queue target session changed",
    );
  const capabilities = engine.getCapabilities();
  if (!capabilities.providerIds.includes(config.providerId))
    throw new EngineError(
      "JOB_PROVIDER_UNSUPPORTED",
      "The queue target provider is unavailable",
    );
  const profile = engine.profiles.forRun(sessionId, config);
  if (
    profile &&
    !engine.profiles
      .list()
      .some(
        (item) => item.id === profile.id && item.revision === profile.revision,
      )
  )
    throw new EngineError(
      "JOB_PROFILE_STALE",
      "The queue target profile changed",
    );
  const profilePin = profile
    ? { id: profile.id, revision: profile.revision }
    : null;
  const tools = capabilities.tools.map((tool) => tool.name);
  const catalogue = engine.toolRuntime.catalogue(
    "engine",
    config.mode,
    profile?.tools
      ? tools.filter((name) => profile.tools!.includes(name))
      : tools,
    profilePin ?? undefined,
  );
  return validateScheduleTarget({
    workspaceId,
    sessionId,
    workspaceBindingSha256: knowledgeHash(binding),
    capabilitiesSha256: knowledgeHash(capabilities),
    catalogueSha256: knowledgeHash(catalogue),
    profile: profilePin,
    config,
    runConfigSha256: knowledgeHash(config),
    tools: catalogue.tools.map((tool) => tool.name).sort(),
    delivery: "queue",
    allocation: {
      maxTurns: config.limits.maxTurns,
      maxToolCalls: config.limits.maxToolCalls,
      maxOutputBytes: config.limits.maxOutputBytes,
      maxDurationMs: config.limits.maxDurationMs,
    },
  });
}
