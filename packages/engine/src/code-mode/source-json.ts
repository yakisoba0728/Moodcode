import { codeModeError } from "./types.js";
/** JSON.parse validates syntax; this bounded second pass rejects ambiguous duplicate object keys. */
export function rejectDuplicateCodeKeys(text: string): void {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    codeModeError();
  };
  const value = (depth: number): void => {
    if (depth > 32) codeModeError("CODE_MODE_LIMIT");
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
        if (keys.has(key)) codeModeError("CODE_MODE_DUPLICATE_KEY");
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
        if (text[at++] === " ]".trim()) return;
      }
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
  };
  value(0);
}
