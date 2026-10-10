import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { GitHubPrReader } from "./github.js";

const head = "a".repeat(40);
const repository = { id: 100, name: "project", owner: { login: "acme" } };
const cases = [
  { conclusion: "success", status: "completed", state: "passed" },
  { conclusion: "neutral", status: "completed", state: "passed" },
  { conclusion: "skipped", status: "completed", state: "pending" },
  { conclusion: "failure", status: "completed", state: "failed" },
  { conclusion: "cancelled", status: "completed", state: "failed" },
  { conclusion: "timed_out", status: "completed", state: "failed" },
  { conclusion: "action_required", status: "completed", state: "failed" },
  { conclusion: "stale", status: "completed", state: "failed" },
  { conclusion: null, status: "in_progress", state: "pending" },
] as const;

test("each check-run conclusion maps to its feedback state", async t => {
  let check: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    const path = request.url!.split("?")[0]!;
    const data = path.endsWith("/pulls/1")
      ? { number: 1, state: "open", base: { sha: head, repo: repository }, head: { sha: head, repo: repository } }
      : path.endsWith("/check-runs") ? { total_count: 1, check_runs: [check] } : [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const reader = new GitHubPrReader("http://127.0.0.1:" + (server.address() as { port: number }).port, true);
  for (const c of cases)
    await t.test(String(c.conclusion ?? c.status), async () => {
      check = { id: 1, name: "build", app: { id: 10 }, head_sha: head, status: c.status, conclusion: c.conclusion, started_at: "2026-10-01T00:00:00Z", output: { summary: "" } };
      const snapshot = await reader.snapshot(
        { owner: "acme", name: "project", number: 1 },
        { required: [{ kind: "check", name: "build", appId: 10 }], reviews: "observe", maxRepairInputs: 1 },
        AbortSignal.timeout(5000),
      );
      assert.equal(snapshot.checks.length, 1);
      assert.equal(snapshot.checks[0]!.conclusion, c.conclusion);
      assert.equal(snapshot.checks[0]!.state, c.state);
      assert.equal(snapshot.requiredState, c.state);
    });
});
