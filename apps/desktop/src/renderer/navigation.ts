function windowsWorkspaceRoot(root: string): boolean {
  const drive = /^[A-Za-z]:\\/u.test(root);
  if (!drive && !root.startsWith("\\\\")) return false;
  const suffix = root.slice(drive ? 3 : 2).replace(/\\$/u, "");
  const parts = suffix ? suffix.split("\\") : [];
  return (
    (drive || parts.length >= 2) &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !/[\\/:<>"|?*\u0000-\u001f\u007f]/u.test(part) &&
        !/[. ]$/u.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    )
  );
}

/** Convert a displayed file reference to a path inside the selected workspace. */
export function workspaceFilePath(root: string, path: string): string | null {
  if (
    (!root.startsWith("/") && !windowsWorkspaceRoot(root)) ||
    !path ||
    /[\\\u0000-\u001f\u007f?#]/u.test(path)
  )
    return null;
  const base = root.replace(/\/+$/, "");
  const relative = path.startsWith("/")
    ? path.startsWith(`${base}/`)
      ? path.slice(base.length + 1)
      : null
    : path;
  if (
    !relative ||
    relative.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(relative)
  )
    return null;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return relative;
}
export interface FileTarget {
  id: number;
  workspaceId: string;
  path: string;
  line?: number;
}
