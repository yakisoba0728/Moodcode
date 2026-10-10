type JobGroupSnapshotErrorCode =
  | "PROCESS_SNAPSHOT_INVALID_INPUT"
  | "PROCESS_SNAPSHOT_BYTE_LIMIT"
  | "PROCESS_SNAPSHOT_ROW_LIMIT"
  | "PROCESS_SNAPSHOT_INVALID_ROWS"
  | "PROCESS_SNAPSHOT_LEADER_ABSENT"
  | "PROCESS_SNAPSHOT_LEADER_OWNER_MISMATCH"
  | "PROCESS_SNAPSHOT_LEADER_GROUP_MISMATCH"
  | "PROCESS_SNAPSHOT_CYCLE"
  | "PROCESS_SNAPSHOT_TREE_LIMIT"
  | "PROCESS_SNAPSHOT_UNOWNED_GROUP";

type JobGroupSnapshotAnalysis =
  | { groups: readonly number[]; errorCode?: never }
  | { groups: undefined; errorCode: JobGroupSnapshotErrorCode };

/**
 * Kernel process rows are observation DATA; only the selected fresh PTY tree is owned.
 * Rejection metadata is internal: neither a partial tree nor renewed cleanup authority.
 */
export function analyzeJobGroupsFromSnapshot(
  stdout: string,
  pid: number,
  ownerPid: number,
): JobGroupSnapshotAnalysis {
  if (typeof stdout !== "string")
    return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_INVALID_INPUT" };
  if (Buffer.byteLength(stdout) > 2_097_152)
    return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_BYTE_LIMIT" };
  if (
    ![pid, ownerPid].every((value) => Number.isSafeInteger(value) && value > 1)
  )
    return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_INVALID_INPUT" };
  const rows = stdout.trim().split("\n");
  if (rows.length > 65_536)
    return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_ROW_LIMIT" };
  const byPid = new Map<number, { parent: number; group: number }>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 3)
      return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_INVALID_ROWS" };
    const [child, parent, group] = fields.map(Number);
    // Linux kernel threads legitimately have PGID 0. They grant no ownership.
    if (
      ![child, parent, group].every(Number.isSafeInteger) ||
      child! <= 0 ||
      parent! < 0 ||
      group! < 0 ||
      byPid.has(child!)
    )
      return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_INVALID_ROWS" };
    byPid.set(child!, { parent: parent!, group: group! });
    const siblings = children.get(parent!) ?? [];
    siblings.push(child!);
    children.set(parent!, siblings);
  }
  const leader = byPid.get(pid);
  if (!leader)
    return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_LEADER_ABSENT" };
  if (leader.parent !== ownerPid)
    return {
      groups: undefined,
      errorCode: "PROCESS_SNAPSHOT_LEADER_OWNER_MISMATCH",
    };
  if (leader.group !== pid)
    return {
      groups: undefined,
      errorCode: "PROCESS_SNAPSHOT_LEADER_GROUP_MISMATCH",
    };
  const groups = new Set<number>([pid]);
  const visited = new Set<number>();
  const pending = [pid];
  for (let at = 0; at < pending.length; at++) {
    const child = pending[at]!;
    if (visited.has(child))
      return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_CYCLE" };
    if (pending.length > 8192)
      return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_TREE_LIMIT" };
    visited.add(child);
    const group = byPid.get(child)!.group;
    if (group <= 1 || group === ownerPid)
      return { groups: undefined, errorCode: "PROCESS_SNAPSHOT_UNOWNED_GROUP" };
    groups.add(group);
    pending.push(...(children.get(child) ?? []));
  }
  return { groups: [...groups] };
}

/** Groups still holding members of an exited leader's session. A live process
 * with the leader's pid means that pid was reused after the session ended. */
export function sessionGroupsFromSnapshot(
  stdout: string,
  sid: number,
  ownerPid: number,
): readonly number[] | undefined {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout) > 2_097_152 ||
    ![sid, ownerPid].every((value) => Number.isSafeInteger(value) && value > 1)
  )
    return undefined;
  const rows = stdout.trim().split("\n");
  if (rows.length > 65_536) return undefined;
  const groups = new Set<number>(),
    seen = new Set<number>();
  let reused = false;
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 3) return undefined;
    const [child, group, session] = fields.map(Number);
    if (
      ![child, group, session].every(Number.isSafeInteger) ||
      child! <= 0 ||
      group! < 0 ||
      session! < 0 ||
      seen.has(child!)
    )
      return undefined;
    seen.add(child!);
    if (child === sid) reused = true;
    else if (session === sid) {
      if (group! <= 1 || group === ownerPid) return undefined;
      groups.add(group!);
    }
  }
  return reused ? [] : [...groups];
}
