import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { plainRecord } from "../shared/data.js";
import type { TeamPermissions, TeamRole } from "./types.js";
import {
  boundedTeamJson,
  TEAM_LIMITS,
  teamDate,
  teamId,
} from "./validation.js";

export function teamHostError(code = "INVALID_TEAM_HOST_INPUT"): never {
  throw new EngineError(
    code,
    "Teams require original host ownership and explicit current membership",
  );
}
export function teamHostObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  plainRecord(value, required, optional, () => teamHostError());
}
export function teamHostData<T>(value: T): T {
  return boundedTeamJson(value, TEAM_LIMITS.rowBytes, () =>
    teamHostError("TEAM_LIMIT"),
  );
}
export function teamHostExpiry(
  value: unknown,
  now: number,
  maximum = now + TEAM_LIMITS.ttlMs,
): string {
  const result = teamDate(value),
    deadline = Date.parse(result);
  if (
    deadline <= now ||
    deadline > maximum ||
    deadline > now + TEAM_LIMITS.ttlMs
  )
    teamHostError("TEAM_EXPIRED");
  return result;
}
export function teamHostPermissions(
  role: unknown,
  value: unknown,
): { readonly role: TeamRole; readonly permissions: TeamPermissions } {
  if (!["coordinator", "worker", "observer"].includes(role as string))
    teamHostError("TEAM_PERMISSION");
  teamHostObject(value, ["send", "receive", "claimTasks", "manageTasks"]);
  if (
    Object.values(value).some((item) => typeof item !== "boolean") ||
    (role === "observer" &&
      (value.send || value.claimTasks || value.manageTasks)) ||
    (role !== "coordinator" && value.manageTasks)
  )
    teamHostError("TEAM_PERMISSION");
  return teamHostData({
    role: role as TeamRole,
    permissions: value as unknown as TeamPermissions,
  });
}
export function teamHostSignal(value: unknown): asserts value is AbortSignal {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !(value instanceof AbortSignal)
  )
    teamHostError();
}
export function teamHostAbort(signal?: AbortSignal): void {
  if (signal?.aborted) teamHostError("TEAM_CANCELLED");
}
export function teamHostIds(value: unknown, keys: readonly string[]): void {
  for (const key of keys) teamId((value as Record<string, unknown>)[key]);
}
