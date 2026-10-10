/** JSON.parse validates syntax; this bounded second pass rejects ambiguous duplicate object keys. */
export function rejectDuplicateJsonKeys(
  text: string,
  options: {
    maxDepth: number;
    maxNodes?: number;
    fail: (kind: "limit" | "duplicate" | "invalid") => never;
  },
): void {
  const { maxDepth, maxNodes = Infinity, fail } = options;
  let at = 0,
    nodes = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return fail("invalid");
  };
  const value = (depth: number): void => {
    if (depth > maxDepth || ++nodes > maxNodes) fail("limit");
    space();
    if (text[at] === "{") {
      at++;
      space();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (at < text.length) {
        space();
        const key = string();
        if (keys.has(key)) fail("duplicate");
        keys.add(key);
        space();
        at++;
        value(depth + 1);
        space();
        if (text[at++] === "}") return;
      }
    } else if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (at < text.length) {
        value(depth + 1);
        space();
        if (text[at++] === "]") return;
      }
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
  };
  value(0);
}
