import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = await mkdtemp(join(tmpdir(), "moodcode-desktop-e2e-"));
const screenshots = resolve("artifacts/desktop");
await mkdir(screenshots, { recursive: true });
const checks = [];
const source = "export function add(a, b) { return a - b; }\n";
const fixed = source.replace("a - b", "a + b");
let application;

async function fixture(name) {
  const workspace = join(root, name);
  await mkdir(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "math.mjs"), source);
  await writeFile(
    join(workspace, "math.test.mjs"),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('add computes sums', () => assert.equal(add(3, 2), 5));\n",
  );
  return workspace;
}
async function launch(name, scenario, workspace) {
  const userData = join(root, `${name}-data`);
  application = await electron.launch({
    args: [resolve("apps/desktop")],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: userData,
      MOODCODE_DESKTOP_TEST: "1",
      MOODCODE_DESKTOP_TEST_SCENARIO: scenario,
      MOODCODE_DESKTOP_TEST_WORKSPACE: workspace,
    },
  });
  const page = await application.firstWindow();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const isolated = await page.evaluate(async () => ({
    require: typeof window.require,
    process: typeof window.process,
    bootstrap: await window.moodcode.getBootstrap(),
  }));
  assert.equal(isolated.require, "undefined");
  assert.equal(isolated.process, "undefined");
  assert.equal(isolated.bootstrap.host.state, "ready");
  assert.equal(isolated.bootstrap.settings.providerId, "scripted");
  assert.ok(!("apiKey" in isolated.bootstrap.settings));
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "작업 요청" })).toBeEnabled();
  return page;
}
async function command(page, type, payload) {
  const result = await page.evaluate(
    ({ type, payload, commandId }) =>
      window.moodcode.command({ schemaVersion: 1, commandId, type, payload }),
    { type, payload, commandId: randomUUID() },
  );
  assert.equal(
    result.ok,
    true,
    `Engine command ${type} failed: ${result.error?.code}`,
  );
  return result.result;
}
async function selectedSession(page) {
  const value = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("moodcode.selection.v1")),
  );
  assert.ok(value.sessionId);
  return value.sessionId;
}
async function snapshot(page, sessionId) {
  return command(page, "session.getSnapshot", { sessionId });
}
async function submit(page) {
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Fix add(a, b), then run the test.");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
}
async function close() {
  if (application) {
    await application.close();
    application = undefined;
  }
}

try {
  const workspace = await fixture("coding");
  const page = await launch("coding", "coding", workspace);
  const sessionId = await selectedSession(page);
  await submit(page);
  await expect(
    page.getByText("파일 변경을 승인해 주세요", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), source);
  const pending = await snapshot(page, sessionId);
  assert.equal(pending.runs.length, 1);
  assert.equal(pending.runs[0].state, "awaiting_approval");
  await page.screenshot({ path: join(screenshots, "approval.png") });
  await page.reload();
  await expect(
    page.getByText("파일 변경을 승인해 주세요", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const reloaded = await snapshot(page, sessionId);
  assert.equal(reloaded.runs.length, 1);
  assert.equal(
    reloaded.approvals.filter((a) => a.status === "pending").length,
    1,
  );
  assert.equal(reloaded.runs[0].id, pending.runs[0].id);
  await page
    .getByRole("button", { name: "승인하고 실행", exact: true })
    .click();
  await expect(
    page.getByText("명령 실행을 승인해 주세요", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), fixed);
  await page
    .getByRole("button", { name: "승인하고 실행", exact: true })
    .click();
  await expect(
    page.getByText(
      "Fixed add(a, b) in math.mjs and verified the change with node --test.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 20000 });
  const completed = await snapshot(page, sessionId);
  assert.equal(completed.runs[0].state, "completed");
  assert.equal(
    completed.tools.filter((t) => t.state === "completed").length,
    3,
  );
  assert.match(
    completed.tools.find((t) => t.name === "run_command").output,
    /cleanupConfirmed=true/,
  );
  await page
    .locator(".changed-files")
    .getByRole("button")
    .filter({ hasText: "math.mjs" })
    .click();
  await expect(page.locator(".diff-line.add")).toContainText("a + b");
  await expect(page.locator(".diff-line.remove")).toContainText("a - b");
  await page.screenshot({ path: join(screenshots, "completed.png") });
  checks.push(
    "real utility engine, read -> approve patch -> approve POSIX command -> completed; reload retains pending approval without replay; exact diff",
  );

  await page
    .getByRole("button", { name: "마지막 변경 복원 확인", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "확인하고 복원", exact: true }),
  ).toBeEnabled();
  const external = fixed + "// external edit retained\n";
  await writeFile(join(workspace, "math.mjs"), external);
  await page
    .getByRole("button", { name: "확인하고 복원", exact: true })
    .click();
  await expect(page.getByText(/RESTORE_PREVIEW_STALE/)).toBeVisible({
    timeout: 10000,
  });
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), external);
  await writeFile(join(workspace, "math.mjs"), fixed);
  await page
    .getByRole("button", { name: "마지막 변경 복원 확인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "확인하고 복원", exact: true })
    .click();
  await expect(
    page.locator(".pane-note").filter({ hasText: "복원했어요." }),
  ).toBeVisible({
    timeout: 15000,
  });
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), source);
  const audit = await command(page, "review.history", {
    runId: completed.runs[0].id,
  });
  assert.equal(
    audit.operations.filter((a) => a.state === "completed").length,
    1,
  );
  const afterRestore = await snapshot(page, sessionId);
  assert.equal(
    afterRestore.lastSeq,
    completed.lastSeq,
    "User restore audit must not append events after the run terminal.",
  );
  await page.reload();
  await expect(page.getByText(/복원 기록 \d+개/)).toBeVisible({
    timeout: 10000,
  });
  assert.deepEqual(
    await command(page, "review.history", { runId: completed.runs[0].id }),
    audit,
  );
  await page.getByRole("button", { name: "파일", exact: true }).click();
  await page
    .locator(".review-pane .file-row")
    .filter({ hasText: "math.mjs" })
    .click();
  await expect(page.locator(".source-code")).toContainText("a - b");
  checks.push(
    "restore preview rejects stale external edits; confirmed restore has durable audit; file reads work after reload; terminal journal unchanged",
  );
  await close();

  const denyWorkspace = await fixture("denied");
  const denied = await launch("denied", "coding", denyWorkspace);
  await submit(denied);
  await expect(
    denied.getByText("파일 변경을 승인해 주세요", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await denied.getByRole("button", { name: "거절", exact: true }).click();
  await expect(denied.locator(".run-state.failed")).toBeVisible({
    timeout: 10000,
  });
  assert.equal(await readFile(join(denyWorkspace, "math.mjs"), "utf8"), source);
  const deniedSnapshot = await snapshot(denied, await selectedSession(denied));
  assert.equal(
    deniedSnapshot.tools.find((t) => t.name === "apply_patch").state,
    "denied",
  );
  assert.ok(!deniedSnapshot.tools.some((t) => t.name === "run_command"));
  checks.push(
    "denied approval leaves files unchanged and does not run command",
  );
  await close();

  const slowWorkspace = await fixture("slow");
  const slow = await launch("slow", "slow", slowWorkspace);
  await submit(slow);
  await expect(
    slow.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeVisible();
  const slowSession = await selectedSession(slow);
  const active = await snapshot(slow, slowSession);
  await slow.reload();
  await expect(
    slow.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  assert.equal(
    (await snapshot(slow, slowSession)).runs[0].id,
    active.runs[0].id,
  );
  await slow.getByRole("button", { name: "작업 중지", exact: true }).click();
  await expect(slow.locator(".run-state.cancelled")).toBeVisible({
    timeout: 10000,
  });
  await expect(
    slow.getByRole("button", { name: "작업 시작", exact: true }),
  ).toBeVisible();
  checks.push(
    "reload preserves running execution; cancel reaches terminal and restores composer",
  );
  await submit(slow);
  await expect(
    slow.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeVisible();
  const beforeCrash = await snapshot(slow, slowSession);
  const enginePid = await application.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((metric) => metric.name === "Moodcode Engine")
        ?.pid,
  );
  assert.ok(
    enginePid,
    "The fixture utility process must be identified by its owned app metrics.",
  );
  process.kill(enginePid, "SIGKILL");
  await expect(
    slow.getByText("엔진 연결을 확인해 주세요", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await slow
    .getByRole("button", { name: "다시 연결", exact: true })
    .first()
    .click();
  await expect(slow.locator(".run-state.interrupted")).toBeVisible({
    timeout: 15000,
  });
  const recovered = await snapshot(slow, slowSession);
  assert.equal(recovered.runs.length, beforeCrash.runs.length);
  assert.equal(recovered.runs.at(-1).id, beforeCrash.runs.at(-1).id);
  assert.equal(recovered.runs.at(-1).state, "interrupted");
  assert.equal(
    recovered.messages.filter((message) => message.role === "assistant").length,
    0,
  );
  checks.push(
    "owned utility crash is visible; retry recovers interrupted Run without model or tool replay",
  );
  await close();
  console.log(JSON.stringify({ ok: true, checks, screenshots }, null, 2));
} catch (error) {
  if (application) {
    try {
      await (
        await application.firstWindow()
      ).screenshot({ path: join(screenshots, "failure.png") });
    } catch {}
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await close();
  await rm(root, { recursive: true, force: true });
}
