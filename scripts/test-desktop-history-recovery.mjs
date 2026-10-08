import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createEngine, ScriptedProvider } from "@moodcode/engine";

// Every engine and GUI in this test uses canonical disposable paths. Existing
// model fixtures remain unchanged, and no real provider or account is used.
const root = await realpath(
  await mkdtemp(join(tmpdir(), "moodcode-history-recovery-e2e-")),
);
const screenshots = resolve("artifacts/desktop");
const networkKey = `__moodcodeHistoryNetwork_${randomUUID().replaceAll("-", "")}`;
const source = "export const fixture = 'before';\n";
const fixed = "export const fixture = 'after';\n";
const primaryTables = [
  "workspaces",
  "sessions",
  "inputs",
  "runs",
  "messages",
  "tools",
  "approvals",
  "checkpoints",
  "events",
];
const checks = [];
let application;
let networkAttempts = 0;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

async function rawCommand(page, type, payload) {
  return page.evaluate(
    ({ type, payload, commandId }) =>
      window.moodcode.command({ schemaVersion: 1, commandId, type, payload }),
    { type, payload, commandId: randomUUID() },
  );
}

async function command(page, type, payload) {
  const result = await rawCommand(page, type, payload);
  assert.equal(
    result.ok,
    true,
    `Desktop command ${type} failed: ${result.error?.code}`,
  );
  return result.result;
}

function databaseRows(file, tables) {
  const database = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  try {
    assert.equal(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    return Object.fromEntries(
      tables.map((table) => {
        const ordering =
          table === "events"
            ? "session_id, seq"
            : table === "review_operations"
              ? "ordinal"
              : "id";
        return [
          table,
          database.prepare(`SELECT * FROM ${table} ORDER BY ${ordering}`).all(),
        ];
      }),
    );
  } finally {
    database.close();
  }
}

async function fixture(name) {
  const userData = join(root, `${name}-data`);
  const workspace = join(root, `${name}-workspace`);
  await mkdir(userData);
  await mkdir(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "fixture.mjs"), source);
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
  return {
    userData,
    workspace,
    dbPath: join(userData, "engine.sqlite"),
    artifactDir: join(userData, "artifacts"),
  };
}

async function seedHistory(paths) {
  const provider = new ScriptedProvider();
  const engine = createEngine({
    dbPath: paths.dbPath,
    artifactDir: paths.artifactDir,
    providers: [provider],
  });
  try {
    const workspace = await engineCommand(engine, "workspace.open", {
      path: paths.workspace,
    });
    const session = await engineCommand(engine, "session.create", {
      workspaceId: workspace.id,
      title: "25개 기록 검증",
    });
    const runIds = [];
    for (let index = 1; index <= 25; index++) {
      const receipt = await engineCommand(engine, "run.submit", {
        sessionId: session.id,
        requestId: randomUUID(),
        prompt: `history-fixture-${String(index).padStart(3, "0")}`,
        config: { providerId: "scripted", modelId: "local", mode: "plan" },
      });
      const terminal = await engine.waitForRun(receipt.runId);
      assert.equal(terminal.state, "completed", terminal.error?.code);
      runIds.push(receipt.runId);
    }
    assert.equal(provider.callCount, 25);
    return {
      ...paths,
      sessionId: session.id,
      runIds,
      snapshot: await engineCommand(engine, "session.getSnapshot", {
        sessionId: session.id,
      }),
    };
  } finally {
    await engine.close();
  }
}

async function seedInterruptedRestore(paths) {
  const provider = new ScriptedProvider([
    {
      events: [
        {
          type: "tool.call",
          call: {
            id: "recovery-fixture-read",
            name: "read_file",
            input: { path: "fixture.mjs" },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    {
      events: [
        {
          type: "tool.call",
          call: {
            id: "recovery-fixture-patch",
            name: "apply_patch",
            input: {
              changes: [
                {
                  path: "fixture.mjs",
                  expectedHash: digest(source),
                  content: fixed,
                },
              ],
            },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    {
      events: [
        {
          type: "text.delta",
          delta: "Local patch completed; interrupted restore fixture follows.",
        },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  const engine = createEngine({
    dbPath: paths.dbPath,
    artifactDir: paths.artifactDir,
    providers: [provider],
  });
  try {
    const workspace = await engineCommand(engine, "workspace.open", {
      path: paths.workspace,
    });
    const session = await engineCommand(engine, "session.create", {
      workspaceId: workspace.id,
      title: "중단 복원 검증",
    });
    const receipt = await engineCommand(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "Change the disposable fixture to its known after image.",
      config: { providerId: "scripted", modelId: "local", mode: "build" },
    });
    let approval;
    await expect
      .poll(
        () => {
          approval = engine.store
            .getSnapshot(session.id)
            .approvals.find((value) => value.status === "pending");
          return Boolean(approval);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    assert.equal(
      await readFile(join(paths.workspace, "fixture.mjs"), "utf8"),
      source,
    );
    await engineCommand(engine, "approval.decide", {
      approvalId: approval.id,
      fingerprint: approval.fingerprint,
      decision: "allow",
    });
    const terminal = await engine.waitForRun(receipt.runId);
    assert.equal(terminal.state, "completed", terminal.error?.code);
    assert.equal(provider.callCount, 3);
    assert.equal(
      await readFile(join(paths.workspace, "fixture.mjs"), "utf8"),
      fixed,
    );
    const [checkpoint] = engine.store.listCheckpoints(receipt.runId);
    assert.ok(checkpoint);
    const preview = await engineCommand(engine, "review.previewRestore", {
      runId: receipt.runId,
      checkpointId: checkpoint.id,
    });
    assert.equal(preview.canRestore, true);
    const operation = engine.reviewJournal.start({
      id: randomUUID(),
      checkpointId: checkpoint.id,
      runId: receipt.runId,
      sessionId: session.id,
      workspaceId: workspace.id,
      fingerprint: preview.fingerprint,
    });
    assert.equal(operation.state, "started");
    // Only a durable unfinished audit is seeded. No restore effect is executed.
    return {
      ...paths,
      sessionId: session.id,
      runId: receipt.runId,
      operationId: operation.id,
      snapshot: await engineCommand(engine, "session.getSnapshot", {
        sessionId: session.id,
      }),
    };
  } finally {
    await engine.close();
  }
}

async function launch(seed) {
  application = await electron.launch({
    args: [resolve("apps/desktop")],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: seed.userData,
      MOODCODE_DESKTOP_TEST: "1",
      MOODCODE_DESKTOP_TEST_SCENARIO: "slow",
      MOODCODE_DESKTOP_TEST_WORKSPACE: seed.workspace,
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
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.moodcode?.getBootstrap()))?.host
          .state,
      { timeout: 20_000 },
    )
    .toBe("ready");
  await expect(page.locator(".run-section").first()).toBeVisible({
    timeout: 20_000,
  });
  const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.equal(bootstrap.settings.providerId, "scripted");
  assert.equal(bootstrap.settings.codexAuthState, "missing");
  return page;
}

async function close() {
  if (!application) return;
  const current = application;
  application = undefined;
  try {
    const attempts = await current.evaluate(
      (_electron, key) => globalThis[key],
      networkKey,
    );
    networkAttempts += attempts;
    assert.equal(attempts, 0, "Disposable GUI attempted a network request.");
  } finally {
    await current.close();
  }
}

async function visibleRuns(page) {
  return page
    .locator(".run-section")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-run-id")),
    );
}

async function openRecovery(page, text) {
  await page.getByRole("button", { name: "진단·복구", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "진단·복구", exact: true });
  await expect(dialog.getByText(text, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    dialog.getByRole("button", { name: "다시 진단", exact: true }),
  ).toBeEnabled();
  return dialog;
}

try {
  await mkdir(screenshots, { recursive: true });
  const history = await seedHistory(await fixture("history"));
  const page = await launch(history);
  await expect.poll(() => visibleRuns(page)).toEqual(history.runIds.slice(-20));
  await expect(
    page.getByRole("button", { name: "이전 기록", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "이전 기록", exact: true }).click();
  await expect
    .poll(() => visibleRuns(page))
    .toEqual(history.runIds.slice(0, 5));
  await expect(
    page.getByText("이전 기록을 보고 있어요.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이전 기록", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "최신 기록", exact: true }).click();
  await expect.poll(() => visibleRuns(page)).toEqual(history.runIds.slice(-20));
  assert.deepEqual(
    await command(page, "session.getSnapshot", {
      sessionId: history.sessionId,
    }),
    history.snapshot,
  );
  checks.push(
    "25 real terminal Scripted runs display latest 20, older 5 and latest 20 with the original full journal unchanged",
  );

  let dialog = await openRecovery(page, "복구가 필요한 기록이 없어요.");
  await expect(
    dialog.getByRole("button", { name: "백업 후 복구", exact: true }),
  ).toBeDisabled();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  const healthy = await page.evaluate(() =>
    window.moodcode.getRecoveryStatus(),
  );
  assert.equal(healthy.state, "clear");
  assert.equal(healthy.pendingRestoreCount, 0);
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();

  await page
    .getByRole("textbox", { name: "작업 요청" })
    .fill("Cancel this local slow fixture while viewing older history.");
  await page.getByRole("button", { name: "작업 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeEnabled({ timeout: 5_000 });
  const active = (
    await command(page, "session.getSnapshot", { sessionId: history.sessionId })
  ).runs.at(-1);
  assert.equal(active.state, "running");
  await page.getByRole("button", { name: "이전 기록", exact: true }).click();
  await expect
    .poll(() => visibleRuns(page))
    .toEqual(history.runIds.slice(0, 6));
  await expect(
    page.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeEnabled();
  dialog = await openRecovery(page, "현재 복구가 차단돼 있어요.");
  await expect(
    dialog.getByRole("button", { name: "백업 후 복구", exact: true }),
  ).toBeDisabled();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  const busy = await page.evaluate(() => window.moodcode.getRecoveryStatus());
  assert.equal(busy.state, "blocked");
  assert.equal(busy.activeRunCount, 1);
  assert.ok(busy.blockers.includes("RECOVERY_OWNER_BUSY"));
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();
  await page.getByRole("button", { name: "작업 중지", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await command(page, "session.getSnapshot", {
            sessionId: history.sessionId,
          })
        ).runs.at(-1).state,
      { timeout: 10_000 },
    )
    .toBe("cancelled");
  await page.getByRole("button", { name: "최신 기록", exact: true }).click();
  await expect(page.locator(".run-state.cancelled")).toBeVisible();
  await expect
    .poll(() => visibleRuns(page))
    .toEqual([...history.runIds.slice(-19), active.id]);
  const afterCancel = await command(page, "session.getSnapshot", {
    sessionId: history.sessionId,
  });
  assert.deepEqual(afterCancel.runs.slice(0, 25), history.snapshot.runs);
  assert.deepEqual(
    afterCancel.messages.filter((value) => value.runId !== active.id),
    history.snapshot.messages,
  );
  assert.equal(afterCancel.runs.length, 26);
  assert.equal(
    await readFile(join(history.workspace, "fixture.mjs"), "utf8"),
    source,
  );
  dialog = await openRecovery(page, "복구가 필요한 기록이 없어요.");
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "history.png") });
  checks.push(
    "active Run controls remain usable on an older history page; recovery blocks active work; cancel completes once and idle diagnosis becomes clear",
  );
  await close();

  const recovery = await seedInterruptedRestore(await fixture("recovery"));
  const primaryBefore = databaseRows(recovery.dbPath, primaryTables);
  const recoveryPage = await launch(recovery);
  const historyBefore = await command(recoveryPage, "review.history", {
    runId: recovery.runId,
  });
  assert.equal(historyBefore.operations.length, 1);
  assert.equal(historyBefore.operations[0].id, recovery.operationId);
  assert.equal(historyBefore.operations[0].state, "interrupted");
  assert.equal(historyBefore.operations[0].error.code, "RESTORE_INTERRUPTED");
  assert.deepEqual(
    await command(recoveryPage, "session.getSnapshot", {
      sessionId: recovery.sessionId,
    }),
    recovery.snapshot,
  );
  const reviewBefore = databaseRows(`${recovery.dbPath}.review.sqlite`, [
    "review_operations",
  ]);
  const rejected = await rawCommand(recoveryPage, "run.submit", {
    sessionId: recovery.sessionId,
    requestId: randomUUID(),
    prompt: "This quarantined admission must be rejected.",
    config: { mode: "plan" },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "CLEANUP_PENDING");
  dialog = await openRecovery(recoveryPage, "확인 후 복구할 수 있어요.");
  await expect(
    dialog.getByText("미확인 복원 1개 · 확인된 기록 0개", { exact: true }),
  ).toBeVisible();
  const recoverButton = dialog.getByRole("button", {
    name: "백업 후 복구",
    exact: true,
  });
  await expect(recoverButton).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(recoverButton).toBeEnabled();
  await dialog.getByRole("button", { name: "다시 진단", exact: true }).click();
  await expect(
    dialog.getByText("확인 후 복구할 수 있어요.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(recoverButton).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  const generation = (
    await recoveryPage.evaluate(() => window.moodcode.getBootstrap())
  ).host.generation;
  const diagnosed = await recoveryPage.evaluate(() =>
    window.moodcode.getRecoveryStatus(),
  );
  assert.equal(diagnosed.state, "recoverable");
  assert.equal(diagnosed.pendingRestoreCount, 1);
  await recoverButton.click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "백업을 검증하고 복구 기록 1개를 저장했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    dialog.getByText("복구가 필요한 기록이 없어요.", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    dialog.getByText("미확인 복원 0개 · 확인된 기록 1개", { exact: true }),
  ).toBeVisible();
  await expect(recoverButton).toBeDisabled();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  const restarted = await recoveryPage.evaluate(() =>
    window.moodcode.getBootstrap(),
  );
  assert.equal(restarted.host.state, "ready");
  assert.equal(restarted.host.generation, generation + 1);
  assert.equal(restarted.settings.providerId, "scripted");
  const recoveredStatus = await recoveryPage.evaluate(() =>
    window.moodcode.getRecoveryStatus(),
  );
  assert.equal(recoveredStatus.state, "clear");
  assert.equal(recoveredStatus.pendingRestoreCount, 0);
  assert.equal(recoveredStatus.resolvedRestoreCount, 1);
  assert.deepEqual(
    await command(recoveryPage, "session.getSnapshot", {
      sessionId: recovery.sessionId,
    }),
    recovery.snapshot,
  );
  assert.deepEqual(
    await command(recoveryPage, "review.history", { runId: recovery.runId }),
    historyBefore,
  );
  assert.equal(
    await readFile(join(recovery.workspace, "fixture.mjs"), "utf8"),
    fixed,
  );
  assert.deepEqual(databaseRows(recovery.dbPath, primaryTables), primaryBefore);
  assert.deepEqual(
    databaseRows(`${recovery.dbPath}.review.sqlite`, ["review_operations"]),
    reviewBefore,
  );
  checks.push(
    "real interrupted restore is quarantined on startup; acknowledgment resets on re-diagnosis; confirmed backup recovery restarts the utility and preserves the original terminal Run and interrupted review row",
  );

  const ledger = new DatabaseSync(`${recovery.dbPath}.recovery.sqlite`, {
    readOnly: true,
    timeout: 0,
  });
  let audit;
  try {
    assert.equal(
      ledger.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    const rows = ledger
      .prepare("SELECT data FROM recovery_audit ORDER BY ordinal")
      .all();
    assert.equal(rows.length, 1);
    audit = JSON.parse(rows[0].data);
    assert.equal(audit.fingerprint, diagnosed.fingerprint);
    assert.equal(audit.acknowledgments.length, 1);
    assert.equal(audit.acknowledgments[0].id, recovery.operationId);
    assert.equal(audit.acknowledgments[0].state, "interrupted");
    assert.equal(audit.markerClearRequested, false);
  } finally {
    ledger.close();
  }
  const backupRoot = join(recovery.artifactDir, "recovery");
  assert.deepEqual(await readdir(backupRoot), [audit.id]);
  const backupDirectory = join(backupRoot, audit.id);
  for (const label of ["primary", "review"]) {
    const file = join(backupDirectory, `${label}.sqlite`);
    const bytes = await readFile(file);
    assert.equal(bytes.length, audit.backups[label].bytes);
    assert.equal(digest(bytes), audit.backups[label].sha256);
    const expectedSchemaVersion = label === "primary" ? 23 : 1;
    assert.equal(audit.backups[label].schemaVersion, expectedSchemaVersion);
    const backup = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get().user_version,
        expectedSchemaVersion,
      );
    } finally {
      backup.close();
    }
    assert.deepEqual(
      databaseRows(
        file,
        label === "primary" ? primaryTables : ["review_operations"],
      ),
      label === "primary" ? primaryBefore : reviewBefore,
    );
  }
  await dialog.getByRole("button", { name: "다시 진단", exact: true }).click();
  await expect(
    dialog.getByText("복구가 필요한 기록이 없어요.", { exact: true }),
  ).toBeVisible();
  await expect(recoverButton).toBeDisabled();
  assert.deepEqual(await readdir(backupRoot), [audit.id]);
  assert.equal(
    await readFile(join(recovery.workspace, "fixture.mjs"), "utf8"),
    fixed,
  );
  await recoveryPage.screenshot({
    path: join(screenshots, "history-recovery.png"),
  });
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();
  await recoveryPage.reload();
  await expect(recoveryPage.locator(".run-section")).toHaveCount(1);
  assert.deepEqual(
    await command(recoveryPage, "session.getSnapshot", {
      sessionId: recovery.sessionId,
    }),
    recovery.snapshot,
  );
  dialog = await openRecovery(recoveryPage, "복구가 필요한 기록이 없어요.");
  await expect(
    dialog.getByText("미확인 복원 0개 · 확인된 기록 1개", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();
  checks.push(
    "both primary/review backups pass SQLite integrity and exact row/hash verification; repeated diagnosis and GUI reload create no second recovery or filesystem effect",
  );
  await close();

  // Reopening the same disposable app proves acknowledgment survives an actual
  // process restart; only a newly submitted Scripted request may execute again.
  const reopened = await launch(recovery);
  assert.deepEqual(
    await command(reopened, "review.history", { runId: recovery.runId }),
    historyBefore,
  );
  assert.deepEqual(
    await command(reopened, "session.getSnapshot", {
      sessionId: recovery.sessionId,
    }),
    recovery.snapshot,
  );
  dialog = await openRecovery(reopened, "복구가 필요한 기록이 없어요.");
  await dialog.getByRole("button", { name: "진단 닫기", exact: true }).click();
  await reopened
    .getByRole("textbox", { name: "작업 요청" })
    .fill("A new local request after recovery may be cancelled.");
  await reopened
    .getByRole("button", { name: "작업 시작", exact: true })
    .click();
  await expect(
    reopened.getByRole("button", { name: "작업 중지", exact: true }),
  ).toBeEnabled();
  await reopened
    .getByRole("button", { name: "작업 중지", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await command(reopened, "session.getSnapshot", {
            sessionId: recovery.sessionId,
          })
        ).runs.at(-1).state,
      { timeout: 10_000 },
    )
    .toBe("cancelled");
  const afterNewRequest = await command(reopened, "session.getSnapshot", {
    sessionId: recovery.sessionId,
  });
  assert.equal(afterNewRequest.runs.length, 2);
  assert.deepEqual(afterNewRequest.runs[0], recovery.snapshot.runs[0]);
  assert.deepEqual(
    afterNewRequest.messages.filter((value) => value.runId === recovery.runId),
    recovery.snapshot.messages,
  );
  assert.deepEqual(
    await command(reopened, "review.history", { runId: recovery.runId }),
    historyBefore,
  );
  assert.equal(
    await readFile(join(recovery.workspace, "fixture.mjs"), "utf8"),
    fixed,
  );
  assert.deepEqual(await readdir(backupRoot), [audit.id]);
  checks.push(
    "recovery acknowledgment survives a full app restart and permits a new request; the old tool/restore is never replayed and its file image stays unchanged",
  );
  await close();
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks,
        offlineSeedProviderCalls: 28,
        cancelledGuiFixtureRuns: 2,
        networkAttempts,
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
      ).screenshot({ path: join(screenshots, "history-recovery-failure.png") });
    } catch {}
  }
  console.error(
    error instanceof Error
      ? error.message
      : "Desktop history/recovery verification failed.",
  );
  process.exitCode = 1;
} finally {
  try {
    await close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
