export function validateClipboardText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > 1_048_576 ||
    new TextEncoder().encode(value).byteLength > 1_048_576
  ) {
    throw Object.assign(
      new Error("복사할 텍스트가 올바르지 않거나 1 MiB를 초과했어요."),
      { code: "INVALID_CLIPBOARD_TEXT" },
    );
  }
  return value;
}
