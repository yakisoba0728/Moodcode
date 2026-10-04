import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { createCommandEnvironment } from "../packages/engine/dist/tools/command/process-control.js";
const userData = await mkdtemp(join(tmpdir(), "moodcode-package-smoke-"));
let app;
try {
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
  app = await electron.launch({
    executablePath: resolve(
      "release/mac-arm64/Moodcode.app/Contents/MacOS/Moodcode",
    ),
    args: [],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: userData,
      MOODCODE_DESKTOP_TEST: "1",
      MOODCODE_DESKTOP_TEST_SCENARIO: "coding",
    },
  });
  const page = await app.firstWindow();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const runtime = await app.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    node: process.versions.node,
    electron: process.versions.electron,
    isolation:
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
        .contextIsolation,
  }));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.isolation, true);
  const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.equal(bootstrap.host.state, "ready");
  assert.equal(bootstrap.settings.providerId, "scripted");
  assert.equal(
    bootstrap.settings.modelId,
    "local",
    "Packaged builds must ignore the test scenario override.",
  );
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await app.close();
  app = undefined;
  await writeFile(
    join(userData, "packaged.test.mjs"),
    "import {test} from 'node:test';import assert from 'node:assert/strict';test('packaged supervisor executes node',()=>assert.equal(2+3,5));\n",
  );
  const child = fork(
    resolve(
      "release/mac-arm64/Moodcode.app/Contents/Resources/app.asar/dist/main/supervisor.js",
    ),
    [],
    {
      cwd: userData,
      execPath: resolve(
        "release/mac-arm64/Moodcode.app/Contents/MacOS/Moodcode",
      ),
      execArgv: [],
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  let outcome,
    output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  const closed = new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => {
      child.send({ type: "stop" });
      reject(new Error("Packaged supervisor deadline exceeded"));
    }, 15000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("message", (message) => {
      if (message.type === "ready") child.send({ type: "start" });
      if (message.type === "result") outcome = message.outcome;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveClose(code);
    });
  });
  child.send({
    type: "init",
    input: {
      command: "node --test packaged.test.mjs",
      cwd: userData,
      timeoutMs: 5000,
    },
    executionLockPath: join(userData, "packaged.effects.sqlite"),
  });
  assert.equal(await closed, 0);
  assert.equal(outcome?.exitCode, 0);
  assert.equal(outcome?.cleanupConfirmed, true);
  assert.match(output, /packaged supervisor executes node/);
  console.log(
    JSON.stringify({
      ok: true,
      runtime,
      host: bootstrap.host.state,
      provider: bootstrap.settings.providerId,
      testOverridesIgnored: true,
      asarSupervisor: {
        exitCode: outcome.exitCode,
        cleanupConfirmed: outcome.cleanupConfirmed,
      },
    }),
  );
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
}
