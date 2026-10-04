import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  createEngine,
  CodexProvider,
  getCodexAuthStatus,
} from "@moodcode/engine";

// Explicit opt-in only: this script uses the user's current Codex plan.
if (!process.argv.includes("--live"))
  throw new Error("Use --live to run a real Codex account verification.");
const auth = await getCodexAuthStatus();
assert.equal(auth.state, "ready", "Codex must be signed in.");
assert.ok(auth.modelId, "A locally configured Codex model is required.");
const directory = await mkdtemp(join(tmpdir(), "moodcode-codex-live-"));
const repository = join(directory, "repository");
const before = "export function add(a, b) { return a - b; }\n";
const after = "export function add(a, b) { return a + b; }\n";
const hash = createHash("sha256").update(before).digest("hex");
let engine;
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 180000);
let approvalFailure;
const approved = [];
async function command(type, payload) {
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  if (!response.ok)
    throw new Error(response.error?.code ?? "ENGINE_COMMAND_FAILED");
  return response.result;
}
try {
  await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "math.mjs"), before);
  await writeFile(
    join(repository, "math.test.mjs"),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './math.mjs';test('real Codex fixture addition',()=>assert.equal(add(2,3),5));\n",
  );
  engine = createEngine({
    dbPath: join(directory, "engine.sqlite"),
    providers: [new CodexProvider({ timeoutMs: 90000 })],
    defaults: { providerId: "codex", modelId: auth.modelId },
  });
  const workspace = await command("workspace.open", { path: repository });
  const session = await command("session.create", {
    workspaceId: workspace.id,
    title: "Live Codex verification fixture",
  });
  const events = (async () => {
    for await (const event of engine.subscribe(session.id, 0, abort.signal)) {
      if (event.type !== "approval.requested") continue;
      const snapshot = await command("session.getSnapshot", {
        sessionId: session.id,
      });
      for (const approval of snapshot.approvals.filter(
        (a) => a.status === "pending",
      )) {
        const tool = snapshot.tools.find((t) => t.id === approval.toolCallId);
        const input = tool?.input;
        const changes = input?.changes;
        const patchAllowed =
          tool?.name === "apply_patch" &&
          Array.isArray(changes) &&
          changes.length === 1 &&
          changes[0].path === "math.mjs" &&
          changes[0].expectedHash === hash &&
          changes[0].content === after;
        const commandAllowed =
          tool?.name === "run_command" &&
          input.command === "node --test math.test.mjs" &&
          (!input.cwd || input.cwd === ".") &&
          (await readFile(join(repository, "math.mjs"), "utf8")) === after;
        const allow = patchAllowed || commandAllowed;
        if (!allow) approvalFailure = "UNEXPECTED_FIXTURE_ACTION";
        else approved.push(tool.name);
        await command("approval.decide", {
          approvalId: approval.id,
          fingerprint: approval.fingerprint,
          decision: allow ? "allow" : "deny",
        });
      }
    }
  })();
  const receipt = await command("run.submit", {
    sessionId: session.id,
    requestId: "live-fixture-one",
    prompt:
      "Read math.mjs with read_file. Fix only math.mjs using apply_patch. The full replacement content must be exactly this one line with a trailing newline: export function add(a, b) { return a + b; }\nUse the sha256 from read_file as expectedHash. Then run exactly node --test math.test.mjs with run_command. Do not change the test, create other files, or execute other commands. Report the observed test result.",
    config: {
      mode: "build",
      providerId: "codex",
      modelId: auth.modelId,
      limits: { maxTurns: 8, maxToolCalls: 8, maxDurationMs: 180000 },
    },
  });
  const run = await engine.waitForRun(receipt.runId);
  abort.abort();
  await events;
  const snapshot = await command("session.getSnapshot", {
    sessionId: session.id,
  });
  const result = {
    provider: "codex",
    modelId: auth.modelId,
    state: run.state,
    errorCode: run.error?.code ?? approvalFailure ?? null,
    approved,
    tools: snapshot.tools.map((t) => ({ name: t.name, state: t.state })),
    patchVerified:
      (await readFile(join(repository, "math.mjs"), "utf8")) === after,
    commandVerified: snapshot.tools.some(
      (t) =>
        t.name === "run_command" &&
        t.state === "completed" &&
        t.output?.includes("exitCode=0") &&
        t.output.includes("cleanupConfirmed=true"),
    ),
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(run.state, "completed");
  assert.equal(approvalFailure, undefined);
  assert.equal(result.patchVerified, true);
  assert.equal(result.commandVerified, true);
} catch (error) {
  // Public diagnostics intentionally omit arbitrary transport/error text.
  console.error(
    JSON.stringify({
      verified: false,
      errorCode:
        typeof error?.code === "string"
          ? error.code
          : typeof error?.message === "string" &&
              /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "LIVE_VERIFICATION_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  abort.abort();
  await engine?.close();
  await rm(directory, { recursive: true, force: true });
}
