/** Kernel process rows are observation DATA; only the selected fresh PTY tree is owned. */
export function observedJobGroupsFromSnapshot(
  stdout: string,
  pid: number,
  ownerPid: number,
): readonly number[] | undefined {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout) > 2_097_152 ||
    ![pid, ownerPid].every((value) => Number.isSafeInteger(value) && value > 1)
  )
    return undefined;
  const rows = stdout.trim().split("\n");
  if (rows.length > 65_536) return undefined;
  const byPid = new Map<number, { parent: number; group: number }>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 3) return undefined;
    const [child, parent, group] = fields.map(Number);
    // Linux kernel threads legitimately have PGID 0. They grant no ownership.
    if (
      ![child, parent, group].every(Number.isSafeInteger) ||
      child! <= 0 ||
      parent! < 0 ||
      group! < 0 ||
      byPid.has(child!)
    )
      return undefined;
    byPid.set(child!, { parent: parent!, group: group! });
    const siblings = children.get(parent!) ?? [];
    siblings.push(child!);
    children.set(parent!, siblings);
  }
  const leader = byPid.get(pid);
  if (!leader || leader.parent !== ownerPid || leader.group !== pid)
    return undefined;
  const groups = new Set<number>([pid]);
  const visited = new Set<number>();
  const pending = [pid];
  for (let at = 0; at < pending.length; at++) {
    const child = pending[at]!;
    if (visited.has(child) || pending.length > 8192) return undefined;
    visited.add(child);
    const group = byPid.get(child)!.group;
    if (group <= 1 || group === ownerPid) return undefined;
    groups.add(group);
    pending.push(...(children.get(child) ?? []));
  }
  return [...groups];
}
