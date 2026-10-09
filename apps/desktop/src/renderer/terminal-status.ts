/** Only an explicit native confirmation can label terminal cleanup complete. */
export function terminalCleanupLabel(cleanupConfirmed: unknown): "확인됨" | "미확정" {
  return cleanupConfirmed === true ? "확인됨" : "미확정";
}
