import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createEngine, ScriptedProvider } from "@moodcode/engine";

// No provider scenario is added to production. A real local Scripted run seeds
// the disposable database before the Electron utility becomes its sole owner.
const root = await realpath(
  await mkdtemp(join(tmpdir(), "moodcode-conversation-e2e-")),
);
const userData = join(root, "data");
const workspace = join(root, "workspace");
const screenshots = resolve("artifacts/desktop");
const clipboardKey = `__moodcodeConversationClipboard_${randomUUID().replaceAll("-", "")}`;
const networkKey = `__moodcodeConversationNetwork_${randomUUID().replaceAll("-", "")}`;
const checks = [];
let application;
let clipboardSaved = false;
let clipboardRestored = false;
let seed;

const fileSource =
  Array.from(
    { length: 10_000 },
    (_, index) => `const file_line_${index + 1} = ${index + 1};`,
  ).join("\n") + "\n";
const codeSource =
  Array.from(
    { length: 1_200 },
    (_, index) => `const marker_${index + 1} = ${index + 1};`,
  ).join("\n") + "\n";

async function engineCommand(engine, type, payload) {
  const result = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(
    result.ok,
    true,
    `Seed command ${type} failed: ${result.error?.code}`,
  );
  return result.result;
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
    `Desktop command ${type} failed: ${result.error?.code}`,
  );
  return result.result;
}

async function createSeed() {
  await mkdir(userData);
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(screenshots, { recursive: true });
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "src/long.ts"), fileSource);
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      providerId: "scripted",
      modelId: "local",
      baseURL: "",
    }),
    { mode: 0o600 },
  );
  const canonicalWorkspace = await realpath(workspace);
  const markdown = [
    "| 항목 | 상태 |",
    "| :--- | ---: |",
    "| 대화 표시 | 준비됨 |",
    "",
    "```ts",
    codeSource + "```",
    "",
    "[파일의 600줄](src/long.ts#L600)",
    "",
    "`src/long.ts:610`",
    "",
    `[현재 저장소의 절대 경로](${join(canonicalWorkspace, "src/long.ts")}#L620)`,
    "",
    "[저장소 밖 경로](/etc/hosts#L1)",
    "",
    "<script>window.__MOODCODE_MARKDOWN_EXECUTED = true</script>",
    "",
    "![외부 이미지](https://example.invalid/tracking.png)",
    "",
    "[위험한 링크](javascript:alert(1))",
  ].join("\n");
  const provider = new ScriptedProvider([
    {
      events: [
        {
          type: "tool.call",
          call: {
            id: "conversation-fixture-read",
            name: "read_file",
            input: { path: "src/long.ts", startLine: 600, endLine: 605 },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    {
      events: [
        { type: "text.delta", delta: markdown },
        { type: "usage", inputTokens: 100, outputTokens: 200 },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  const engine = createEngine({
    dbPath: join(userData, "engine.sqlite"),
    artifactDir: join(userData, "artifacts"),
    providers: [provider],
  });
  try {
    const opened = await engineCommand(engine, "workspace.open", {
      path: workspace,
    });
    const session = await engineCommand(engine, "session.create", {
      workspaceId: opened.id,
      title: "대화 표시 검증",
    });
    const receipt = await engineCommand(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "로컬 대화 표시 검증용 파일을 읽어 주세요.",
      config: {
        providerId: "scripted",
        modelId: "local",
        mode: "plan",
        limits: { maxOutputBytes: 524_288, maxContextBytes: 1_048_576 },
      },
    });
    const completed = await engine.coordinator.waitForRun(receipt.runId);
    assert.equal(completed.state, "completed", completed.error?.code);
    assert.equal(provider.callCount, 2);
    const snapshot = engine.store.getSnapshot(session.id);
    assert.equal(snapshot.tools.length, 1);
    assert.equal(snapshot.tools[0].state, "completed");
    return {
      sessionId: session.id,
      runId: receipt.runId,
      lastSeq: snapshot.lastSeq,
    };
  } finally {
    await engine.close();
  }
}

async function saveClipboard() {
  // Eagerly materialize every MIME payload while still in the main process.
  // Clipboard contents never cross the test RPC or enter logs/artifact files.
  await application.evaluate(async ({ clipboard, ClipboardItem }, key) => {
    const original = await clipboard.read();
    const saved = [];
    for (const item of original) {
      if (!item.types.length) continue;
      const entries = await Promise.all(
        item.types.map(async (type) => [type, await item.getType(type)]),
      );
      saved.push(new ClipboardItem(Object.fromEntries(entries)));
    }
    globalThis[key] = saved;
  }, clipboardKey);
  clipboardSaved = true;
}

async function restoreClipboard() {
  if (!application || !clipboardSaved || clipboardRestored) return;
  await application.evaluate(async ({ clipboard }, key) => {
    const saved = globalThis[key];
    if (!Array.isArray(saved))
      throw new Error("Clipboard restore snapshot is unavailable.");
    if (saved.length) await clipboard.write(saved);
    else clipboard.clear();
    delete globalThis[key];
  }, clipboardKey);
  clipboardRestored = true;
}

try {
  seed = await createSeed();
  application = await electron.launch({
    args: [resolve("apps/desktop")],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: userData,
      MOODCODE_DESKTOP_TEST: "1",
      MOODCODE_DESKTOP_TEST_SCENARIO: "slow",
      MOODCODE_DESKTOP_TEST_WORKSPACE: workspace,
      MOODCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
  await application.evaluate(({ session }, key) => {
    globalThis[key] = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => {
        globalThis[key]++;
        callback({ cancel: true });
      },
    );
  }, networkKey);
  const page = await application.firstWindow();
  await expect(page.locator(".conversation-table table")).toBeVisible({
    timeout: 20_000,
  });
  const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.equal(bootstrap.host.state, "ready");
  assert.equal(bootstrap.settings.providerId, "scripted");
  assert.equal(bootstrap.settings.codexAuthState, "missing");
  const table = page.locator(".conversation-table table");
  await expect(table.locator("th")).toHaveText(["항목", "상태"]);
  await expect(table.locator("td")).toHaveText(["대화 표시", "준비됨"]);
  assert.equal(await table.locator("[style]").count(), 0);
  assert.equal(await table.locator(".conversation-align-right").count(), 2);
  assert.equal(
    await page.locator(".timeline img, .timeline script").count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "위험한 링크", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => window.__MOODCODE_MARKDOWN_EXECUTED),
    undefined,
  );
  checks.push(
    "real Electron GFM table and CSP-compatible alignment; raw HTML, images and unsafe links remain inert",
  );

  const code = page.locator(".message.assistant .conversation-code");
  assert.equal(await code.count(), 1);
  await expect(code.locator(".hljs-keyword").first()).toHaveText("const");
  await expect(code.locator("pre code")).toContainText("const marker_80 = 80;");
  assert.ok(
    !(await code.locator("pre code").textContent()).includes(
      "const marker_81 = 81;",
    ),
  );
  assert.equal(await page.locator(".tool-body").count(), 0);
  await code.getByRole("button", { name: "더 보기", exact: true }).click();
  await expect(code.locator("pre code")).toContainText(
    "const marker_400 = 400;",
  );
  assert.ok(
    !(await code.locator("pre code").textContent()).includes(
      "const marker_401 = 401;",
    ),
  );
  await code.getByRole("button", { name: "다음", exact: true }).click();
  await expect(code.locator("pre code")).toContainText(
    "const marker_401 = 401;",
  );
  assert.ok(
    !(await code.locator("pre code").textContent()).includes(
      "const marker_1 = 1;",
    ),
  );
  await code.getByRole("button", { name: "이전", exact: true }).click();
  await expect(code.locator("pre code")).toContainText("const marker_1 = 1;");
  await code.getByRole("button", { name: "접기", exact: true }).click();
  await expect(code.locator("pre code")).toContainText("const marker_80 = 80;");
  const codeBytes = Buffer.byteLength(
    await code.locator("pre code").textContent(),
  );
  assert.ok(codeBytes <= 8_192);
  checks.push(
    "declared-language highlight and real 80/400-row code pagination; collapsed tool body has no output DOM",
  );

  await saveClipboard();
  await code
    .getByRole("button", { name: "원문 코드 복사", exact: true })
    .click();
  await expect
    .poll(() =>
      application.evaluate(
        async ({ clipboard }, expected) =>
          (await clipboard.readText()) === expected,
        codeSource,
      ),
    )
    .toBe(true);
  await expect(
    code.getByRole("button", { name: "원문 코드 복사", exact: true }),
  ).toHaveText("복사됨");
  await restoreClipboard();
  checks.push(
    "user-click copy traverses sandboxed preload/main bridge and copies exact full code; all previous clipboard MIME payloads restored",
  );

  await page.getByRole("button", { name: "파일의 600줄", exact: true }).click();
  const viewer = page.locator(
    ".review-pane .file-inspector .conversation-code",
  );
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("600");
  await expect(viewer.locator("pre code")).toContainText(
    "const file_line_600 = 600;",
  );
  assert.equal(
    await viewer.locator(".conversation-line-numbers > span").count(),
    80,
  );
  assert.ok(
    !(await viewer.locator("pre code").textContent()).includes(
      "const file_line_1 = 1;",
    ),
  );
  await page
    .getByRole("button", { name: "src/long.ts:610", exact: true })
    .click();
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("610");
  await page
    .getByRole("button", { name: "현재 저장소의 절대 경로", exact: true })
    .click();
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("620");
  await page
    .getByRole("button", { name: "저장소 밖 경로", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "선택한 저장소 안의 파일만 열 수 있어요." }),
  ).toBeVisible();
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("620");
  checks.push(
    "relative, inline and canonical absolute file links open the original 1-based line; workspace boundary rejects external file paths",
  );

  await page.locator(".tool-card summary").click();
  await expect(page.locator(".tool-body")).toBeVisible();
  await page
    .locator(".tool-file-references")
    .getByRole("button", { name: "src/long.ts:600", exact: true })
    .click();
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("600");
  await viewer.getByRole("button", { name: "더 보기", exact: true }).click();
  assert.equal(
    await viewer.locator(".conversation-line-numbers > span").count(),
    400,
  );
  await viewer.getByRole("button", { name: "다음", exact: true }).click();
  await expect(viewer.locator("pre code")).toContainText(
    "const file_line_1000 = 1000;",
  );
  assert.equal(
    await viewer.locator(".conversation-line-numbers > span").count(),
    400,
  );
  await viewer.getByRole("button", { name: "이전", exact: true }).click();
  await expect(viewer.locator('[aria-current="location"]')).toHaveText("600");
  const viewerBytes = Buffer.byteLength(
    await viewer.locator("pre code").textContent(),
  );
  assert.ok(viewerBytes <= 32_768);
  checks.push(
    "persisted tool output locations open the real file; large-file viewer remains bounded to 400 gutter rows and 32 KiB per page",
  );

  const current = await command(page, "session.getSnapshot", {
    sessionId: seed.sessionId,
  });
  assert.equal(current.runs.length, 1);
  assert.equal(current.runs[0].id, seed.runId);
  assert.equal(current.lastSeq, seed.lastSeq);
  assert.equal(
    await readFile(join(workspace, "src/long.ts"), "utf8"),
    fileSource,
  );
  assert.equal(
    await application.evaluate((_electron, key) => globalThis[key], networkKey),
    0,
  );
  await page.screenshot({ path: join(screenshots, "conversation.png") });
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks,
        providerRequestsInGui: 0,
        networkAttempts: 0,
        clipboardRestored,
        codePreviewBytes: codeBytes,
        filePageBytes: viewerBytes,
        screenshots,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (application) {
    try {
      await (
        await application.firstWindow()
      ).screenshot({ path: join(screenshots, "conversation-failure.png") });
    } catch {}
  }
  console.error(
    error instanceof Error
      ? error.message
      : "Conversation desktop verification failed.",
  );
  process.exitCode = 1;
} finally {
  try {
    await restoreClipboard();
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
