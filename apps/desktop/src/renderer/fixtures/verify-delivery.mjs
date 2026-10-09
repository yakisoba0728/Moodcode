import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureDesktopNativeEvidence,
  createDesktopTestDirectory,
  preserveDesktopTestEvidence,
} from "../../../../../scripts/desktop-test-evidence.mjs";
import {
  aggregateFixtureCleanup,
  bindMainUtilityClose,
  qualifyDesktopNativeCleanup,
  readMainUtilityClose,
} from "../../../../../scripts/desktop-main-utility-close.mjs";

const output = process.argv[2];
assert.ok(output, "Provide the report output path.");
const launchEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "delivery-launch.cjs",
);
const report = { status: "running", checks: [], fixtures: [], themes: [] };
const source = "export function add(a, b) { return a - b; }\n";
const fixed = source.replace("a - b", "a + b");
let application, page, originalProcess, fixture;

async function command(type, payload) {
  const result = await page.evaluate(
    ({ type, payload, commandId }) =>
      window.moodcode.command({ schemaVersion: 1, commandId, type, payload }),
    { type, payload, commandId: randomUUID() },
  );
  assert.equal(result.ok, true, `${type}: ${result.error?.code}`);
  return result.result;
}
const selected = () =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem("moodcode.selection.v1")).sessionId,
  );
const snapshot = async (sessionId) =>
  command("session.getSnapshot", {
    sessionId: sessionId ?? (await selected()),
  });
const assets = () =>
  application.evaluate(() => globalThis.rendererDelivery.files);
const hold = (prefix) =>
  application.evaluate((_electron, value) => {
    globalThis.rendererDelivery.hold = value;
  }, prefix);
async function held(prefix) {
  report.stage = `Waiting for ${prefix}`;
  await expect
    .poll(() =>
      application.evaluate(
        (_electron, value) =>
          globalThis.rendererDelivery.pending.some((item) =>
            item.file.startsWith(value),
          ),
        prefix,
      ),
    )
    .toBe(true);
}
async function release(next = null) {
  await application.evaluate((_electron, value) => {
    const delivery = globalThis.rendererDelivery;
    delivery.hold = value;
    for (const item of delivery.pending.splice(0)) item.callback({});
  }, next);
}
async function close() {
  if (!application) return;
  const current = application;
  await release();
  fixture.networkAttempts = await current.evaluate(
    () => globalThis.rendererDeliveryNetworkAttempts,
  );
  assert.equal(fixture.networkAttempts, 0);
  application = undefined;
  let closeFailure;
  try {
    await current.close();
  } catch (error) {
    closeFailure = error;
  }
  const applicationClose = {
    scope: "original-electron-application",
    exitObserved:
      Number.isInteger(originalProcess.exitCode) ||
      typeof originalProcess.signalCode === "string",
    exitCode: originalProcess.exitCode ?? null,
    signal: originalProcess.signalCode ?? null,
    establishesNativeCleanup: false,
  };
  fixture.mainUtilityClose = await readMainUtilityClose(
    fixture.mainUtilityClosePath,
  );
  const nativeAfterClose = await captureDesktopNativeEvidence({
    sourceDirectory: fixture.directory,
    phase: "after-close",
    close: {
      mainUtility: fixture.mainUtilityClose,
      acknowledged: fixture.mainUtilityClose?.utilityAcknowledged ?? null,
      exitObserved: fixture.mainUtilityClose?.utilityExitObserved ?? null,
      forcedStop: fixture.mainUtilityClose?.forcedStop === true,
      applicationClose,
    },
  });
  fixture.cleanup = {
    ...aggregateFixtureCleanup({
      mainReceipt: fixture.mainUtilityClose,
      nativeConfirmed: qualifyDesktopNativeCleanup(nativeAfterClose),
    }),
    applicationExitObserved: applicationClose.exitObserved,
    applicationExitCode: applicationClose.exitCode,
    originalPreserved: true,
  };
  fixture.preservedEvidence = await preserveDesktopTestEvidence({
    sourceDirectory: fixture.directory,
    artifactDirectory: resolve("artifacts/renderer-delivery"),
    scenario: `renderer-${fixture.scenario}`,
    outcome: report.status === "failed" || closeFailure ? "failed" : "unknown",
    cleanup: fixture.cleanup,
    nativeAfterClose,
  });
  if (closeFailure) throw closeFailure;
  assert.equal(fixture.cleanup.utilityAcknowledged, true);
  assert.equal(fixture.cleanup.utilityExitObserved, true);
}
async function launch(scenario) {
  const directory = await createDesktopTestDirectory(`renderer-${scenario}`),
    workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "math.mjs"), source);
  await writeFile(
    join(workspace, "math.test.mjs"),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('sums', () => assert.equal(add(3, 2), 5));\n",
  );
  execFileSync("git", ["init", "-q", workspace]);
  fixture = { scenario, directory, workspace, originalPreserved: true };
  report.fixtures.push(fixture);
  const env = {
    ...process.env,
    MOODCODE_DESKTOP_USER_DATA: join(directory, "userData"),
    MOODCODE_DESKTOP_TEST: "1",
    MOODCODE_DESKTOP_TEST_SCENARIO: scenario,
    MOODCODE_DESKTOP_TEST_WORKSPACE: workspace,
  };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MOODCODE_API_KEY"])
    delete env[key];
  application = await electron.launch({ args: [launchEntry], env });
  originalProcess = application.process();
  fixture.mainUtilityClosePath = await bindMainUtilityClose(
    application,
    directory,
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  fixture.rendererErrors = [];
  page.on("pageerror", (error) => fixture.rendererErrors.push(error.message));
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  fixture.isolation = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    urlProtocol: location.protocol,
  }));
  assert.deepEqual(fixture.isolation, {
    require: "undefined",
    process: "undefined",
    urlProtocol: "file:",
  });
  fixture.hidden = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
  );
  assert.equal(fixture.hidden, true);
  fixture.initialAssets = await assets();
  assert.ok(
    !fixture.initialAssets.some((file) =>
      /^(?:AdvancedPanel|Settings|Recovery|Timeline|CodeBlock|conversation)-/.test(
        file,
      ),
    ),
  );
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "작업 요청" })).toBeEnabled();
  return workspace;
}
async function submit() {
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Fix add(a, b), then run the test.");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
}
async function theme(media) {
  await page.emulateMedia({ colorScheme: media });
  const result = await page
    .locator(".restore-history-entry strong")
    .first()
    .evaluate((element) => ({
      media: matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark",
      rootColor: getComputedStyle(document.documentElement).color,
      rootTextToken: getComputedStyle(document.documentElement)
        .getPropertyValue("--text")
        .trim(),
      historyStrongColor: getComputedStyle(element).color,
      historyColor: getComputedStyle(element.closest(".restore-history")).color,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    }));
  assert.equal(result.historyStrongColor, result.rootColor);
  assert.equal(result.rootColor, "rgb(217, 220, 224)");
  assert.equal(result.historyColor, "rgb(181, 170, 138)");
  assert.equal(result.colorScheme, "dark");
  report.themes.push(result);
}

async function sharedStyles() {
  const view = await page.evaluate(() => {
    const read = (node, properties) => {
      const style = getComputedStyle(node);
      return Object.fromEntries(properties.map((key) => [key, style[key]]));
    };
    const rules = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule) => "selectorText" in rule)
      .filter((rule) =>
        /delivery-select|account-panel|advanced-actions|settings-dialog/.test(
          rule.selectorText,
        ),
      )
      .map((rule) => ({
        selector: rule.selectorText,
        declarations: rule.style.cssText,
      }));
    const dialog = document.querySelector("dialog[open]");
    return {
      viewportHeight: innerHeight,
      delivery: read(document.querySelector(".delivery-select"), [
        "width",
        "marginRight",
        "borderTopWidth",
        "borderTopStyle",
        "borderTopColor",
        "backgroundColor",
        "borderRadius",
        "padding",
        "fontSize",
      ]),
      accountPanels: [...document.querySelectorAll(".account-panel")].map(
        (node) => ({
          label: node.getAttribute("aria-label"),
          panel: read(node, [
            "margin",
            "padding",
            "borderTopWidth",
            "borderTopStyle",
            "borderTopColor",
            "borderRadius",
          ]),
          heading: read(node.querySelector("h3"), ["fontSize", "margin"]),
          actions: read(node.querySelector(".advanced-actions"), [
            "display",
            "alignItems",
            "gap",
            "flexWrap",
            "marginTop",
          ]),
        }),
      ),
      dialog: dialog ? read(dialog, ["maxHeight", "overflowY"]) : null,
      rules,
    };
  });
  return { ...view, assets: await assets() };
}
function expectSharedStyles(view, settings = false) {
  assert.deepEqual(view.delivery, {
    width: "88px",
    marginRight: "8px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "rgb(44, 49, 54)",
    backgroundColor: "rgb(27, 32, 35)",
    borderRadius: "6px",
    padding: "6px",
    fontSize: "11px",
  });
  for (const selector of [
    ".delivery-select",
    ".advanced-actions",
    ".account-panel",
    ".account-panel h3",
    ".account-panel .advanced-actions",
    ".settings-dialog",
  ]) {
    assert.ok(
      view.rules.some((rule) => rule.selector.split(/,\s*/).includes(selector)),
      `Missing eager ${selector} rule.`,
    );
  }
  if (view.dialog)
    assert.deepEqual(view.dialog, {
      maxHeight: `${view.viewportHeight - 48}px`,
      overflowY: "auto",
    });
  if (!settings) return;
  assert.deepEqual(
    view.accountPanels.map((row) => row.label),
    ["앱 계정 관리", "앱 업데이트"],
  );
  for (const row of view.accountPanels) {
    assert.deepEqual(row.panel, {
      margin: "18px 0px",
      padding: "14px",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(44, 49, 54)",
      borderRadius: "7px",
    });
    assert.deepEqual(row.heading, { fontSize: "13px", margin: "0px 0px 10px" });
    assert.deepEqual(row.actions, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      flexWrap: "wrap",
      marginTop: "10px",
    });
  }
}

try {
  const workspace = await launch("coding"),
    firstSession = await selected();
  report.sharedStyles = { composerBeforeAdvanced: await sharedStyles() };
  expectSharedStyles(report.sharedStyles.composerBeforeAdvanced);
  await hold("Settings-");
  await page.getByRole("button", { name: "모델 설정", exact: true }).click();
  await held("Settings-");
  await expect(
    page.getByRole("dialog", { name: "모델 연결 불러오는 중", exact: true }),
  ).toBeVisible();
  report.sharedStyles.loadingSettings = await sharedStyles();
  expectSharedStyles(report.sharedStyles.loadingSettings);
  await page.reload();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible();
  await release();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "모델 설정", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "모델 연결", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".account-panel")).toHaveCount(2);
  report.sharedStyles.settingsBeforeAdvanced = await sharedStyles();
  expectSharedStyles(report.sharedStyles.settingsBeforeAdvanced, true);
  for (const view of Object.values(report.sharedStyles)) {
    assert.ok(
      !view.assets.some((file) => file.startsWith("AdvancedPanel-")),
      "Fresh Settings must not load Advanced JS or CSS.",
    );
  }
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  report.checks.push(
    "Reload during a delayed settings import cannot reopen the previous dialog; the new view opens normally.",
  );

  await hold("AdvancedPanel-");
  await page.getByRole("button", { name: "고급 작업", exact: true }).click();
  await held("AdvancedPanel-");
  await expect(
    page.getByRole("dialog", { name: "고급 작업 불러오는 중", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator(".new-task").click();
  await expect.poll(selected).not.toBe(firstSession);
  const codingSession = await selected();
  await page.getByRole("button", { name: "고급 작업", exact: true }).click();
  await release();
  await expect(
    page.getByRole("dialog", { name: "고급 작업", exact: true }),
  ).toBeVisible();
  await page.getByLabel("새 작업 제목").fill("Latest session lazy task");
  await page.getByRole("button", { name: "작업 추가", exact: true }).click();
  await expect(page.getByLabel("Latest session lazy task 상태")).toHaveValue(
    "pending",
  );
  const nativeTasks = await page.evaluate(
    async ({ firstSession, codingSession }) => ({
      first: await window.moodcode.getAdvancedSnapshot(firstSession),
      current: await window.moodcode.getAdvancedSnapshot(codingSession),
    }),
    { firstSession, codingSession },
  );
  assert.equal(nativeTasks.first.tasks.tasks.length, 0);
  assert.equal(nativeTasks.current.tasks.tasks.length, 1);
  await page
    .getByRole("button", { name: "고급 작업 닫기", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  report.checks.push(
    "Delayed advanced dialog cancels; reopen after session change binds only the current native session.",
  );

  await page.getByRole("button", { name: "모델 설정", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "모델 연결", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".account-panel")).toHaveCount(2);
  report.sharedStyles.settingsAfterAdvanced = await sharedStyles();
  expectSharedStyles(report.sharedStyles.settingsAfterAdvanced, true);
  const before = report.sharedStyles.settingsBeforeAdvanced,
    after = report.sharedStyles.settingsAfterAdvanced;
  assert.ok(after.assets.some((file) => /^AdvancedPanel-.*\.css$/.test(file)));
  for (const key of ["delivery", "accountPanels", "dialog"]) {
    assert.deepEqual(
      after[key],
      before[key],
      `Advanced import changed shared ${key} styles.`,
    );
  }
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  report.checks.push(
    "Fresh composer/loading Settings/account/update styles meet explicit expected values before Advanced assets load and remain unchanged after Advanced loads.",
  );

  await hold("Timeline-");
  await submit();
  await held("Timeline-");
  await expect(
    page.getByText("대화를 불러오는 중이에요.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await snapshot()).runs[0]?.state)
    .toBe("awaiting_approval");
  const beforeApproval = await snapshot();
  await release("CodeBlock-");
  await held("CodeBlock-");
  await expect(
    page.getByText("승인 미리보기를 불러오는 중이에요.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "승인하고 실행", exact: true }),
  ).toHaveCount(0);
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), source);
  await page.locator(".new-task").click();
  await expect.poll(selected).not.toBe(codingSession);
  await release();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".approval-panel")).toHaveCount(0);
  await page.locator(".session-row").nth(1).click();
  await expect.poll(selected).toBe(codingSession);
  await expect(
    page.getByText("파일 변경을 승인해 주세요", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("파일 변경을 승인해 주세요", { exact: true }),
  ).toBeVisible();
  const afterApprovalReload = await snapshot();
  assert.equal(afterApprovalReload.runs.length, 1);
  assert.equal(afterApprovalReload.runs[0].id, beforeApproval.runs[0].id);
  assert.equal(
    afterApprovalReload.approvals.filter((item) => item.status === "pending")
      .length,
    1,
  );
  report.checks.push(
    "Timeline/code imports remain deferred; approval actions wait for the preview; session change/reload preserves native approval without stale UI or replay.",
  );

  await page
    .getByRole("button", { name: "승인하고 실행", exact: true })
    .click();
  await expect(
    page.getByText("명령 실행을 승인해 주세요", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "승인하고 실행", exact: true })
    .click();
  await expect(page.locator(".run-state.completed")).toBeVisible({
    timeout: 20_000,
  });
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), fixed);
  const completed = await snapshot();
  await hold("CodeBlock-");
  await page.reload();
  await expect(page.locator(".run-state.completed")).toBeVisible();
  await page.getByRole("button", { name: "파일", exact: true }).click();
  await page
    .locator(".review-pane .file-row")
    .filter({ hasText: "math.mjs" })
    .click();
  await held("CodeBlock-");
  await expect(
    page.getByText("코드를 불러오는 중이에요.", { exact: true }),
  ).toBeVisible();
  await page.locator(".pane-tabs button").first().click();
  await expect(page.locator(".file-inspector")).toHaveCount(0);
  await page
    .locator(".changed-files")
    .getByRole("button")
    .filter({ hasText: "math.mjs" })
    .click();
  await expect(page.locator(".diff-line.add")).toContainText("a + b");
  await expect(page.locator(".diff-line.remove")).toContainText("a - b");
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
  await expect(page.getByText(/RESTORE_PREVIEW_STALE/)).toBeVisible();
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), external);
  await writeFile(join(workspace, "math.mjs"), fixed);
  const nativeReview = await command("review.getDiff", {
    runId: completed.runs[0].id,
  });
  const checkpoint = nativeReview.checkpoints.findLast(
    (value) => value.files.length > 0,
  );
  const nativePreview = await command("review.previewRestore", {
    runId: completed.runs[0].id,
    checkpointId: checkpoint.id,
  });
  await page
    .getByRole("button", { name: "마지막 변경 복원 확인", exact: true })
    .click();
  await page.locator(".restore-diff summary").click();
  await expect(page.locator(".restore-card .diff-line.add")).toContainText(
    "a - b",
  );
  await expect(page.locator(".restore-card .diff-line.remove")).toContainText(
    "a + b",
  );
  await held("CodeBlock-");
  await page
    .getByRole("button", { name: "확인하고 복원", exact: true })
    .click();
  await expect(
    page.locator(".pane-note").filter({ hasText: "복원했어요." }),
  ).toBeVisible();
  assert.equal(await readFile(join(workspace, "math.mjs"), "utf8"), source);
  const audit = await command("review.history", {
    runId: completed.runs[0].id,
  });
  assert.equal(
    audit.operations.filter((item) => item.state === "completed").length,
    1,
  );
  assert.equal(
    audit.operations.find((item) => item.state === "completed").fingerprint,
    nativePreview.fingerprint,
  );
  await release();
  await expect(page.locator(".file-inspector .conversation-code")).toHaveCount(
    0,
  );
  await expect(page.locator(".file-inspector .diff-code")).toBeVisible();
  report.checks.push(
    "With file CodeBlock still deferred and unmounted, restore's eager before/after diff is visible; native restore preserves the exact preview fingerprint and the late code view stays absent.",
  );
  assert.equal((await snapshot()).lastSeq, completed.lastSeq);
  await page.reload();
  await expect(page.getByText(/복원 기록 \d+개/)).toBeVisible();
  assert.deepEqual(
    await command("review.history", { runId: completed.runs[0].id }),
    audit,
  );
  await page.locator(".restore-history summary").click();
  await expect(
    page.locator(".restore-history-entry strong").first(),
  ).toBeVisible();
  await theme("dark");
  await theme("light");
  await page.getByRole("button", { name: "파일", exact: true }).click();
  await page
    .locator(".review-pane .file-row")
    .filter({ hasText: "math.mjs" })
    .click();
  await expect(
    page.locator(".file-inspector .conversation-code pre"),
  ).toContainText("a - b");
  await page.getByRole("button", { name: "진단·복구", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "진단·복구", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "진단 닫기", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "진단 닫기", exact: true }).click();
  fixture.finalAssets = await assets();
  assert.deepEqual(fixture.rendererErrors, []);
  report.checks.push(
    "Native approve/edit/command/diff/stale-restore/restore/history reload/file preview/recovery flows pass; the terminal event sequence remains unchanged by restore.",
  );
  await close();

  await launch("slow");
  await hold("Timeline-");
  await submit();
  await held("Timeline-");
  const running = await snapshot();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeVisible();
  assert.equal((await snapshot()).runs[0].id, running.runs[0].id);
  await page.getByRole("button", { name: "작업 중지", exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).runs[0]?.state)
    .toBe("cancelled");
  await release();
  await expect(page.locator(".run-state.cancelled")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "작업 시작", exact: true }),
  ).toBeVisible();
  assert.deepEqual(fixture.rendererErrors, []);
  report.checks.push(
    "Reload and cancel operate while the delayed Timeline is absent; its eventual mount receives the current cancelled native Run.",
  );
  await close();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  if (application) {
    fixture.finalAssets = await assets();
    report.failureView = await page.evaluate(() => ({
      text: document.body.innerText,
      dialogs: document.querySelectorAll("dialog[open]").length,
      inspectors: [...document.querySelectorAll(".file-inspector")].map(
        (node) => ({
          html: node.outerHTML.slice(0, 1500),
          display: getComputedStyle(node).display,
          parent: node.parentElement.outerHTML.slice(0, 700),
        }),
      ),
    }));
  }
  process.exitCode = 1;
} finally {
  try {
    await close();
  } catch (error) {
    report.closeFailure = error.message;
    report.status = "failed";
    process.exitCode = 1;
  }
  report.originalFixtureRoots = report.fixtures.map((item) => item.directory);
  report.cleanupQualification =
    "Original Electron main app events supply utility close ACK/exit receipts. Application or utility exit cannot prove complete native cleanup; bounded native qualification and aggregate cleanup remain independent. Generated originals and native copies are preserved; no numeric PID is signalled or used for deletion.";
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
