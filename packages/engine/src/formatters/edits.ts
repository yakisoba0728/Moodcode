import { EngineError } from "@moodcode/contracts";
export interface TextPosition {
  line: number;
  character: number;
}
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}
export interface TextEdit {
  range: TextRange;
  newText: string;
}
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g))
    starts.push(match.index + match[0].length);
  return starts;
}
export function endPosition(
  text: string,
  starts: readonly number[] = lineStarts(text),
): { line: number; character: number } {
  return { line: starts.length - 1, character: text.length - starts.at(-1)! };
}
/** UTF-16 positions with strict range bounds; never split a surrogate pair or a CRLF terminator. */
export function positionOffset(
  text: string,
  position: TextPosition,
  starts?: readonly number[],
): number {
  if (
    !position ||
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new EngineError(
      "INVALID_FORMAT_RANGE",
      "Formatter positions must be nonnegative UTF-16 offsets",
    );
  starts ??= lineStarts(text);
  if (position.line >= starts.length)
    throw new EngineError(
      "INVALID_FORMAT_RANGE",
      "Formatter line is outside the observed document",
    );
  const start = starts[position.line]!;
  const next = starts[position.line + 1];
  const end =
    next === undefined
      ? text.length
      : next - (text[next - 1] === "\n" && text[next - 2] === "\r" ? 2 : 1);
  if (position.character > end - start)
    throw new EngineError(
      "INVALID_FORMAT_RANGE",
      "Formatter character is outside the observed line",
    );
  const offset = start + position.character;
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  )
    throw new EngineError(
      "INVALID_FORMAT_RANGE",
      "Formatter position splits a UTF-16 surrogate pair",
    );
  return offset;
}
export function applyTextEdits(content: string, value: unknown): string {
  if (value === null) return content;
  if (!Array.isArray(value) || value.length > 128)
    throw new EngineError(
      "FORMAT_EDIT_LIMIT",
      "Formatting needs at most 128 text edits",
    );
  const starts = lineStarts(content);
  const edits = value
    .map((edit: TextEdit) => {
      if (
        !edit ||
        typeof edit !== "object" ||
        typeof edit.newText !== "string" ||
        !edit.range ||
        edit.newText.includes("\0") ||
        Buffer.byteLength(edit.newText) > 1024 * 1024 ||
        Buffer.from(edit.newText).toString("utf8") !== edit.newText
      )
        throw new EngineError(
          "INVALID_FORMAT_EDIT",
          "Formatting edits must be bounded UTF-8 text",
        );
      const start = positionOffset(content, edit.range.start, starts);
      const end = positionOffset(content, edit.range.end, starts);
      if (end < start)
        throw new EngineError(
          "INVALID_FORMAT_RANGE",
          "Formatting range end precedes its start",
        );
      return { start, end, text: edit.newText };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let prior: (typeof edits)[number] | undefined;
  for (const edit of edits) {
    if (prior && (prior.end > edit.start || prior.start === edit.start))
      throw new EngineError(
        "FORMAT_EDITS_OVERLAP",
        "Formatter edits overlap or have ambiguous insertion order",
      );
    prior = edit;
  }
  let result = content;
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  if (Buffer.byteLength(result) > 1024 * 1024)
    throw new EngineError(
      "FORMAT_EDIT_LIMIT",
      "Formatted content exceeds 1 MiB",
    );
  return result;
}
