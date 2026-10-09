import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, writeFile, access, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import {
  captureDesktopNativeEvidence,
  createDesktopTestDirectory,
  preserveDesktopTestEvidence,
  mayDeleteDesktopTestDirectory,
} from "./desktop-test-evidence.mjs";
import { bindMainUtilityClose, readMainUtilityClose, qualifyDesktopNativeCleanup, aggregateFixtureCleanup } from './desktop-main-utility-close.mjs';

const root = await createDesktopTestDirectory("advanced");
const workspace = join(root, "workspace"),
  screenshots = resolve("artifacts/desktop-advanced", basename(root));
const checks = [];
let app, page, originalApplicationProcess, guiResult, mainUtilityReceiptPath;
let testOutcome = "unknown";
const failurePoint = process.env.MOODCODE_DESKTOP_ADVANCED_TEST_FAILURE;
const selected = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("moodcode.selection.v1")),
  );
const native = async () => {
  const { sessionId } = await selected();
  return page.evaluate(
    (id) => window.moodcode.getAdvancedSnapshot(id),
    sessionId,
  );
};
const sessionSnapshot = async () => {
  const { sessionId } = await selected();
  const response = await page.evaluate(
    (id) =>
      window.moodcode.command({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "session.getSnapshot",
        payload: { sessionId: id },
      }),
    sessionId,
  );
  assert.equal(response.ok, true);
  return response.result;
};
const open = async (tab) => {
  await page.getByRole("button", { name: "고급 작업", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "고급 작업", exact: true }),
  ).toBeVisible();
  if (tab) await page.getByRole("button", { name: tab, exact: true }).click();
};
const close = () =>
  page.getByRole("button", { name: "고급 작업 닫기", exact: true }).click();
const approve = async () => {
  await expect(
    page.getByRole("button", { name: "검토한 작업 승인", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "검토한 작업 승인", exact: true })
    .click();
  await expect(page.locator(".advanced-preview")).toHaveCount(0);
};
const noError = async () => {
  await expect(page.locator(".advanced-dialog .inline-error")).toHaveCount(0);
};
const errorCode = (error, fallback) =>
  typeof error?.code === "string" && /^[A-Z0-9_-]{1,64}$/u.test(error.code)
    ? error.code
    : fallback;
const applicationObservation = () => ({
  scope: "original-electron-application",
  exitObserved: originalApplicationProcess
    ? Number.isInteger(originalApplicationProcess.exitCode) ||
      typeof originalApplicationProcess.signalCode === "string"
    : null,
  exitCode: originalApplicationProcess?.exitCode ?? null,
  signal: originalApplicationProcess?.signalCode ?? null,
  establishesNativeCleanup: false,
});
const capturePhase = async (phase, liveSnapshot, applicationClose) => {
  const mainUtility = mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null;
  try {
    return await captureDesktopNativeEvidence({
      sourceDirectory: root,
      phase,
      ...(liveSnapshot ? { liveSnapshot } : {}),
      close: {
        mainUtility,
        applicationClose,
      },
    });
  } catch (error) {
    return {
      schemaVersion: 1,
      phase,
      close: {
        mainUtility,
        applicationClose,
      },
      errors: [{ code: errorCode(error, "NATIVE_EVIDENCE_UNAVAILABLE") }],
      qualification: {
        cleanupAuthority: "original-native-source-only",
        physicalAbsenceEstablishesCleanup: false,
        coherentRecoveryBackup: false,
      },
    };
  }
};
try {
  await mkdir(workspace);
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(workspace, "example.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "add", "example.ts"]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=Desktop Fixture",
    "-c",
    "user.email=desktop-fixture@example.invalid",
    "commit",
    "-qm",
    "desktop fixture",
  ]);
  if (failurePoint && failurePoint !== "terminal-running")
    throw Object.assign(
      new Error("Unsupported controlled advanced test failure point."),
      { code: "INVALID_TEST_FAILURE_POINT" },
    );
  app = await electron.launch({
    args: [resolve("apps/desktop")],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: join(root, "userData"),
      MOODCODE_DESKTOP_TEST: "1",
      MOODCODE_DESKTOP_TEST_SCENARIO: "advanced",
      MOODCODE_DESKTOP_TEST_WORKSPACE: workspace,
      MOODCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
  originalApplicationProcess = app.process();
  mainUtilityReceiptPath = await bindMainUtilityClose(app, root);
  page = await app.firstWindow();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "작업 요청" })).toBeEnabled();
  const isolation = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(isolation, { require: "undefined", process: "undefined" });

  await open("대기열·작업");
  await page.getByLabel("새 작업 제목").fill("GUI task");
  await page.getByRole("button", { name: "작업 추가", exact: true }).click();
  await expect(page.getByLabel("GUI task 상태")).toHaveValue("pending");
  await page.getByLabel("GUI task 상태").selectOption("completed");
  await expect
    .poll(async () => (await native()).tasks.tasks[0]?.status)
    .toBe("completed");
  checks.push("native task CAS create/update consumed by renderer");

  await page.getByRole("button", { name: "자식·팀", exact: true }).click();
  await page
    .getByRole("button", { name: "worktree 준비", exact: true })
    .click();
  await expect.poll(async () => (await native()).worktrees.length).toBe(1);
  await page
    .getByRole("button", { name: "worktree 준비", exact: true })
    .click();
  await expect.poll(async () => (await native()).worktrees.length).toBe(2);
  checks.push("real committed fixture worktrees prepared in idle workspace");

  await page.getByRole("button", { name: "터미널", exact: true }).click();
  const capability = (await native()).terminalCapability;
  assert.equal(
    capability.available,
    true,
    `PTY capability unavailable: ${capability.code}`,
  );
  await page
    .getByLabel("실행 파일", { exact: true })
    .fill(process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  await page
    .getByRole("button", { name: "터미널 실행 검토", exact: true })
    .click();
  await expect(page.locator(".advanced-preview")).toContainText(
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
  );
  assert.equal((await native()).terminals.length, 0);
  await approve();
  await expect
    .poll(async () => (await native()).terminals[0]?.state)
    .toBe("running");
  if (failurePoint === "terminal-running")
    throw Object.assign(
      new Error(
        "Controlled test failure with an actual native PTY still running.",
      ),
      { code: "CONTROLLED_DESKTOP_ADVANCED_FAILURE" },
    );
  await page.getByLabel("터미널 열").fill("90");
  await page.getByLabel("터미널 행").fill("24");
  await page
    .getByRole("button", { name: "터미널 크기 변경", exact: true })
    .click();
  await expect
    .poll(async () => {
      const terminal = (await native()).terminals[0];
      return [terminal.cols, terminal.rows];
    })
    .toEqual([90, 24]);
  await page
    .getByLabel("터미널 입력")
    .fill("printf '%s-%s\\n' desktop native-terminal");
  await page
    .getByRole("button", { name: "터미널에 전달", exact: true })
    .click();
  await expect(page.getByLabel("터미널 출력")).toContainText(
    "desktop-native-terminal",
  );
  const terminalId = (await native()).terminals[0].id;
  const { sessionId: terminalSession } = await selected();
  const replay = await page.evaluate(
    ({ sessionId, terminalId }) =>
      window.moodcode.advanced({
        sessionId,
        type: "terminal.read",
        payload: { terminalId, afterSeq: 0 },
      }),
    { sessionId: terminalSession, terminalId },
  );
  assert.ok(
    replay.output
      .map((chunk) => chunk.data)
      .join("")
      .includes("desktop-native-terminal"),
    "Native PTY replay must include generated shell output rather than only the local input echo.",
  );
  await close();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "고급 작업", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await open("터미널");
  await expect(page.getByLabel("터미널 출력")).toContainText(
    "desktop-native-terminal",
  );
  await expect(page.getByLabel("터미널 입력")).toBeDisabled();
  await page
    .getByRole("button", { name: "터미널 제어 다시 연결", exact: true })
    .click();
  await expect(page.getByLabel("터미널 입력")).toBeEnabled();
  await page.getByRole("button", { name: "터미널 종료", exact: true }).click();
  await expect
    .poll(async () => (await native()).terminals[0]?.cleanupConfirmed)
    .toBe(true);
  checks.push(
    "actual PTY exact preview approval, write/output, reload replay, explicit control reconnect and native cleanup",
  );

  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByLabel("서버 이름").fill("fixture");
  await page.getByLabel("MCP 실행 파일").fill(process.execPath);
  await page
    .getByLabel("MCP 인수 · 한 줄에 하나")
    .fill(resolve("scripts/fixtures/desktop/mcp.mjs"));
  await page
    .getByRole("button", { name: "MCP 연결 검토", exact: true })
    .click();
  await approve();
  await expect(page.locator(".advanced-content")).toContainText(
    "mcp_fixture_echo",
  );
  assert.ok((await native()).mcp[0].toolNames.length > 0);
  await close();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "고급 작업", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await open("MCP");
  await expect(page.locator(".advanced-content")).toContainText(
    "mcp_fixture_echo",
  );
  await noError();
  await close();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("desktop MCP fixture: invoke the connected echo tool");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "승인하고 실행", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "승인하고 실행", exact: true })
    .click();
  await expect(
    page.getByText("The desktop fixture consumed the native MCP result.", {
      exact: true,
    }),
  ).toBeVisible();
  const mcpTool = (await sessionSnapshot()).tools.find(
    (tool) => tool.name === "mcp_fixture_echo",
  );
  assert.equal(mcpTool?.state, "completed");
  assert.match(mcpTool.output, /desktop native MCP result/);
  await open("MCP");
  await page.getByRole("button", { name: "연결 해제", exact: true }).click();
  await expect.poll(async () => (await native()).mcp.length).toBe(0);
  checks.push(
    "real stdio MCP connect/catalogue/reload, actual native tool call result and disconnect via GUI approved source handle",
  );

  await page.getByRole("button", { name: "진단", exact: true }).click();
  await page.getByLabel("언어 서버 이름").fill("fixture-lsp");
  await page.getByLabel("언어 서버 실행 파일").fill(process.execPath);
  await page
    .getByLabel("언어 서버 인수 · 한 줄에 하나")
    .fill(resolve("scripts/fixtures/desktop/lsp.mjs"));
  await page
    .getByRole("button", { name: "언어 서버 연결 검토", exact: true })
    .click();
  await approve();
  await page.getByLabel("진단 파일 경로").fill("example.ts");
  await page
    .getByRole("button", { name: "파일 진단 읽기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Desktop fixture diagnostic/ }),
  ).toBeVisible();
  await noError();
  await page
    .getByRole("button", { name: /Desktop fixture diagnostic/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "고급 작업", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".file-inspector")).toContainText(
    "export const value = 1;",
  );
  checks.push(
    "real stdio LSP document notification and native diagnostics rendered with file navigation",
  );

  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Start advanced native fixture");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
  await expect
    .poll(async () => (await native()).questions[0]?.status)
    .toBe("pending");
  await open("대기열·작업");
  await expect(
    page.getByText("Continue the desktop fixture?", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "대기열 일시정지", exact: true })
    .click();
  await close();
  await page.getByLabel("입력 전달 방식").selectOption("queue");
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Queued GUI request");
  await page
    .getByRole("button", { name: "요청 대기열에 추가", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "작업 요청" })).toHaveValue(
    "",
  );
  await page.getByLabel("입력 전달 방식").selectOption("steer");
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Steered GUI request");
  await page
    .getByRole("button", { name: "요청 대기열에 추가", exact: true })
    .click();
  await open("대기열·작업");
  await expect(page.locator(".advanced-content")).toContainText(
    "Queued GUI request",
  );
  await page
    .locator(".advanced-list li")
    .filter({ hasText: "Queued GUI request" })
    .getByRole("button", { name: "요청 취소", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await native()).inbox.inputs.find(
          (input) => input.prompt === "Queued GUI request",
        )?.state,
    )
    .toBe("cancelled");
  checks.push(
    "active GUI composer queue/steer, persistent pause and exact pending-input cancellation",
  );
  await page.getByRole("button", { name: "대기열 재개", exact: true }).click();
  await expect.poll(async () => (await native()).control.paused).toBe(false);

  await page.getByRole("button", { name: "자식·팀", exact: true }).click();
  await page
    .getByLabel("자식 작업 요청")
    .fill("desktop child fixture: explain example.ts");
  await page
    .getByRole("button", { name: "자식 작업 실행 검토", exact: true })
    .click();
  await approve();
  await expect
    .poll(
      async () => (await native()).children[0]?.resident?.runs.at(-1)?.state,
    )
    .toBe("completed");
  await expect
    .poll(async () => (await native()).children[0]?.resident?.state)
    .toBe("idle");
  await expect(page.locator(".advanced-content")).toContainText(
    "최근 실행 completed",
  );
  await noError();
  await page
    .getByRole("button", { name: "자식 엔진 종료", exact: true })
    .click();
  await expect
    .poll(async () => (await native()).children[0]?.resident?.state)
    .toBe("closed");
  const completedRunChild = (await native()).children[0];
  assert.equal(completedRunChild.resident.runs.at(-1).state, "completed");
  assert.equal(completedRunChild.state, "cancelled");
  assert.equal(completedRunChild.outcome.state, "cancelled");
  assert.match(completedRunChild.outcome.content, /fixture child result/);
  await expect(page.locator(".advanced-content")).toContainText(
    "fixture child result",
  );
  checks.push(
    "native resident initial Run completed while owner idle; explicit stop closes owner, records native cancelled task and exposes saved real child result",
  );
  await page
    .getByLabel("자식 작업 요청")
    .fill("desktop child slow fixture: cancellable isolated work");
  await page
    .getByRole("button", { name: "자식 작업 실행 검토", exact: true })
    .click();
  await approve();
  await expect(
    page.getByRole("button", { name: "자식 작업 취소", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "자식 작업 취소", exact: true })
    .click();
  await expect
    .poll(async () => (await native()).children.at(-1)?.resident?.state)
    .toBe("closed");
  const closedChild = (await native()).children.at(-1);
  assert.equal(closedChild.state, "cancelled");
  const childTreeId = closedChild.worktreeId;
  const childTree = (await native()).worktrees.find(
    (tree) => tree.id === childTreeId,
  );
  assert.ok(childTree?.root);
  await expect(
    page
      .locator(".advanced-list li")
      .filter({ hasText: childTree.root })
      .getByRole("button", { name: "worktree 정리", exact: true }),
  ).toBeDisabled();
  checks.push(
    "completed resident Engine explicitly closed and running native child cancelled/closed; cleanup held until parent ends",
  );

  await page.getByLabel("팀 이름").fill("desktop-team");
  await page.getByRole("button", { name: "팀 만들기", exact: true }).click();
  await expect(page.getByLabel("팀 선택")).toHaveValue("desktop-team");
  await page
    .getByRole("button", { name: "현재 실행의 팀 참여 검토", exact: true })
    .click();
  await approve();
  await expect
    .poll(async () => (await native()).teams[0]?.members.length)
    .toBe(1);
  await page.getByLabel("팀 작업 제목").fill("Review GUI board");
  await page.getByRole("button", { name: "팀 작업 추가", exact: true }).click();
  await expect(page.locator(".advanced-content")).toContainText(
    "Review GUI board",
  );
  await page.getByRole("button", { name: "작업 맡기", exact: true }).click();
  await page.getByRole("button", { name: "작업 완료", exact: true }).click();
  await expect
    .poll(async () => (await native()).teams[0]?.tasks[0]?.state)
    .toBe("completed");
  await noError();
  checks.push(
    "native source-owned team join and revision-bound board put/claim/complete reflected in GUI",
  );
  const teamMember = (await native()).teams[0].members[0];
  await page.getByLabel("받는 구성원").selectOption(teamMember.memberId);
  await page
    .getByLabel("팀 메시지", { exact: true })
    .fill("Desktop native mailbox message");
  await page.getByRole("button", { name: "메시지 전달", exact: true }).click();
  await page
    .getByRole("button", { name: "받은 메시지 읽기", exact: true })
    .click();
  await expect(page.locator(".advanced-content")).toContainText(
    "Desktop native mailbox message",
  );
  await page
    .getByRole("button", { name: "표시된 메시지 수신 확인", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "표시된 메시지 수신 확인", exact: true }),
  ).toHaveCount(0);
  await noError();
  checks.push(
    "actual team message delivery, original mailbox page display and exact cursor-bound claim",
  );

  await page.getByRole("button", { name: "워크플로", exact: true }).click();
  await page.getByLabel("워크플로 이름").fill("desktop-workflow");
  await page
    .getByLabel("검토 요청", { exact: true })
    .fill("desktop child fixture: review example.ts");
  await page
    .getByRole("button", { name: "워크플로 등록", exact: true })
    .click();
  const trees = (await native()).worktrees;
  await page.getByLabel("검토 worktree").selectOption(trees[0].id);
  await page
    .getByRole("button", { name: "워크플로 실행 검토", exact: true })
    .click();
  await approve();
  await expect(
    page.getByRole("button", { name: "단계 실행 승인", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "단계 실행 승인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "단계 결과 읽기", exact: true })
    .click();
  await expect(page.locator(".advanced-content")).toContainText(
    "fixture child result",
  );
  await expect
    .poll(async () => (await native()).workflows.instances[0]?.state)
    .toBe("completed");
  await noError();
  checks.push(
    "registered native workflow original start, actual child stage admission/settlement and visible history/result",
  );
  await page.screenshot({ path: join(screenshots, "workflow-completed.png") });

  await page.getByRole("button", { name: "대기열·작업", exact: true }).click();
  await page.getByLabel("질문 답변").fill("Continue with verified GUI flows");
  await page.getByRole("button", { name: "답변 전달", exact: true }).click();
  await expect
    .poll(async () => (await native()).questions[0]?.status)
    .toBe("answered");
  await expect
    .poll(
      async () =>
        (await native()).inbox.inputs.find(
          (input) => input.prompt === "Steered GUI request",
        )?.state,
    )
    .toBe("promoted");
  await close();
  await expect(
    page.getByText("The desktop fixture received the answer.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await sessionSnapshot()).runs.find(
          (run) => run.id === completedRunChild.parentRunId,
        )?.state,
    )
    .toBe("completed");
  await open("자식·팀");
  await page
    .locator(".advanced-list li")
    .filter({ hasText: childTree.root })
    .getByRole("button", { name: "worktree 정리", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await native()).worktrees.find((tree) => tree.id === childTreeId)
          ?.state,
    )
    .toBe("removed");
  await assert.rejects(access(childTree.root), { code: "ENOENT" });
  await noError();
  await close();
  checks.push(
    "after native parent completion, actual worktree cleanup records removed and deletes isolated directory",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "고급 작업", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await open("워크플로");
  await expect(page.locator(".advanced-content")).toContainText(
    "fixture child result",
  );
  checks.push(
    "native question answer resumes exact waiter; renderer reload preserves native workflow history without replay",
  );
  await noError();
  await close();
  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Start a second native question for explicit rejection");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
  await expect
    .poll(async () =>
      (await native()).questions.some(
        (question) => question.status === "pending",
      ),
    )
    .toBe(true);
  const pendingQuestion = (await native()).questions.find(
    (question) => question.status === "pending",
  );
  await open("대기열·작업");
  await page.getByRole("button", { name: "질문 거절", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await native()).questions.find(
          (question) => question.id === pendingQuestion.id,
        )?.status,
    )
    .toBe("rejected");
  const rejectedQuestion = (await native()).questions.find(
    (question) => question.id === pendingQuestion.id,
  );
  assert.equal(rejectedQuestion.version, pendingQuestion.version + 1);
  assert.equal(rejectedQuestion.answer, undefined);
  await expect
    .poll(
      async () =>
        (await sessionSnapshot()).tools.find(
          (tool) =>
            tool.runId === pendingQuestion.runId && tool.name === "ask_user",
        )?.state,
    )
    .toBe("failed");
  await noError();
  await close();
  checks.push(
    "GUI explicit question rejection advances exact native version and settles real ask_user waiter as failed",
  );
  await page.getByRole("button", { name: "모델 설정", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "앱 계정 관리", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "앱 업데이트", exact: true }),
  ).toContainText("업데이트 비활성화");
  checks.push(
    "account lifecycle controls and unsigned-dev update restriction consume actual host views; no external sign-in or install",
  );
  testOutcome = "passed";
  guiResult = {
    ok: true,
    platform: process.platform,
    checks,
    screenshots,
    externalRequests: 0,
  };
} catch (error) {
  testOutcome = "failed";
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  if (page) {
    const evidence = await native().catch(() => null);
    const selection = await selected().catch(() => null);
    const snapshot = selection?.sessionId
      ? await page
          .evaluate(
            async (sessionId) =>
              window.moodcode.command({
                schemaVersion: 1,
                commandId: crypto.randomUUID(),
                type: "session.getSnapshot",
                payload: { sessionId },
              }),
            selection.sessionId,
          )
          .catch(() => null)
      : null;
    console.error(
      "Native fixture failure:",
      JSON.stringify({
        children: evidence?.children?.slice(0, 32).map((child) => ({
          id: child.id,
          state: child.state,
          parentRunId: child.parentRunId,
          childRunId: child.childRunId,
          worktreeId: child.worktreeId,
          residentState: child.resident?.state,
          outcomeState: child.outcome?.state,
        })),
        questions: evidence?.questions?.slice(0, 32).map((question) => ({
          id: question.id,
          runId: question.runId,
          version: question.version,
          status: question.status,
        })),
        runs: snapshot?.result?.runs.slice(0, 32).map((run) => ({
          id: run.id,
          state: run.state,
          errorCode: run.error?.code,
        })),
        tools: snapshot?.result?.tools.slice(0, 32).map((tool) => ({
          name: tool.name,
          state: tool.state,
        })),
      }),
    );
  }
  if (page)
    console.error(
      "Advanced UI alerts:",
      await page
        .locator(".advanced-dialog .inline-error")
        .allTextContents()
        .catch(() => []),
    );
  console.error(error);
  process.exitCode = 1;
} finally {
  const beforeReads = await Promise.allSettled([
    page ? native() : Promise.resolve(null),
    page ? sessionSnapshot() : Promise.resolve(null),
  ]);
  const advanced =
    beforeReads[0].status === "fulfilled" ? beforeReads[0].value : null;
  const session =
    beforeReads[1].status === "fulfilled" ? beforeReads[1].value : null;
  const nativeBeforeClose = await capturePhase(
    "before-close",
    advanced || session
      ? {
          runs: session?.runs ?? [],
          tools: session?.tools ?? [],
          terminals: advanced?.terminals ?? [],
          children: advanced?.children ?? [],
          executionObservations:
            advanced?.diagnostics?.executionObservations?.items ?? [],
        }
      : undefined,
    { requested: false, settled: false, ...applicationObservation() },
  );
  let applicationCloseError = null;
  try {
    await app?.close();
  } catch (error) {
    applicationCloseError = errorCode(error, "APPLICATION_CLOSE_UNCONFIRMED");
    process.exitCode = 1;
  }
  const applicationClose = {
    requested: Boolean(app),
    settled: Boolean(app) && applicationCloseError === null,
    errorCode: applicationCloseError,
    ...(applicationCloseError
      ? { error: { code: applicationCloseError } }
      : {}),
    ...applicationObservation(),
  };
  const nativeAfterClose = await capturePhase(
    "after-close",
    undefined,
    applicationClose,
  );
  const mainUtilityClose = mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null;
  const cleanup = aggregateFixtureCleanup({ mainReceipt: mainUtilityClose, nativeConfirmed: qualifyDesktopNativeCleanup(nativeAfterClose) });
  let retention, fixtureDeleted = false;
  try {
    if (mayDeleteDesktopTestDirectory({ outcome: testOutcome, cleanup }) && !applicationCloseError) {
      await rm(root, { recursive: true, force: true });
      fixtureDeleted = true;
    } else retention = await preserveDesktopTestEvidence({
      sourceDirectory: root,
      artifactDirectory: resolve("artifacts/desktop-advanced/failures"),
      scenario: "advanced",
      outcome:
        testOutcome === "failed" || applicationCloseError
          ? "failed"
          : "unknown",
      cleanup,
      nativeBeforeClose,
      nativeAfterClose,
    });
  } catch (error) {
    retention = {
      sourceDirectory: root,
      sourceDeletionRequested: false,
      errorCode: errorCode(error, "EVIDENCE_COPY_UNCONFIRMED"),
    };
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify(
      {
        ...(guiResult ?? {
          ok: false,
          platform: process.platform,
          checks,
          screenshots,
          externalRequests: 0,
        }),
        ok:
          testOutcome === "passed" &&
          applicationCloseError === null &&
          !retention?.errorCode,
        testOutcome,
        cleanup,
        applicationClose,
        mainUtilityClose,
        originalFixtureRetained: !fixtureDeleted,
        ...(fixtureDeleted ? {} : { retainedSourceDirectory: root }),
        retention,
      },
      null,
      2,
    ),
  );
}
