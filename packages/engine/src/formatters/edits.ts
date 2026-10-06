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
/** UTF-16 positions with strict range bounds; never split a surrogate pair or a CRLF terminator. */
export function positionOffset(text: string, position: TextPosition): number {
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
  const matches = [...text.matchAll(/\r\n|\r|\n/g)];
  if (position.line > matches.length)
    throw new EngineError(
      "INVALID_FORMAT_RANGE",
      "Formatter line is outside the observed document",
    );
  const start =
    position.line === 0
      ? 0
      : matches[position.line - 1]!.index! +
        matches[position.line - 1]![0].length;
  const end = matches[position.line]?.index ?? text.length;
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
      const start = positionOffset(content, edit.range.start);
      const end = positionOffset(content, edit.range.end);
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
