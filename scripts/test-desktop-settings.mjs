import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const data = await mkdtemp(join(tmpdir(), "moodcode-native-settings-"));
const sentinel = "synthetic-moodcode-key-for-local-encryption-test";
let app;
try {
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      providerId: "scripted",
      modelId: "local",
      baseURL: "",
    }),
    { mode: 0o600 },
  );
  app = await electron.launch({
    args: [resolve("apps/desktop")],
    env: {
      ...process.env,
      MOODCODE_DESKTOP_USER_DATA: data,
      MOODCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
  const page = await app.firstWindow();
  await expect(
    page.getByText("무엇을 만들어볼까요?", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const initial = await page.evaluate(() => window.moodcode.getBootstrap());
  await page.getByRole("button", { name: "모델 설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("연결 방식").selectOption("openai-responses");
  await page.getByLabel("모델 ID").fill("fixture-model");
  if (initial.settings.credentialStorage === "unavailable") {
    await expect(page.getByLabel("API 키", { exact: true })).toBeDisabled();
    console.log(
      JSON.stringify({
        ok: true,
        nativeStorage: "unavailable",
        persistentKeyInputDisabled: true,
        providerRequests: 0,
      }),
    );
  } else {
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(/requires.*credential/);
    await page.getByLabel("API 키", { exact: true }).fill(sentinel);
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0, {
      timeout: 15000,
    });
    const serialized = await readFile(join(data, "settings.json"), "utf8");
    assert.ok(!serialized.includes(sentinel));
    assert.equal((await stat(join(data, "settings.json"))).mode & 0o777, 0o600);
    const configured = await page.evaluate(() =>
      window.moodcode.getBootstrap(),
    );
    assert.equal(configured.settings.keySource, "stored");
    assert.ok(!JSON.stringify(configured).includes(sentinel));
    assert.ok(!("apiKey" in configured.settings));
    await page.getByRole("button", { name: "모델 설정", exact: true }).click();
    await page.getByLabel("저장된 API 키 제거").check();
    await page.getByLabel("연결 방식").selectOption("scripted");
    await expect(page.getByLabel("저장된 API 키 제거")).toBeChecked();
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0, {
      timeout: 15000,
    });
    const cleared = JSON.parse(
      await readFile(join(data, "settings.json"), "utf8"),
    );
    assert.equal(cleared.credential, undefined);
    if (
      initial.settings.codexAuthState === "available" &&
      initial.settings.codexModelId
    ) {
      await page
        .getByRole("button", { name: "모델 설정", exact: true })
        .click();
      await page.getByLabel("연결 방식").selectOption("codex");
      await expect(page.getByLabel("모델 ID")).toHaveValue(
        initial.settings.codexModelId,
      );
      await page
        .getByRole("button", { name: "설정 저장", exact: true })
        .click();
      await expect(page.locator("dialog[open]")).toHaveCount(0, {
        timeout: 15000,
      });
      const connected = await page.evaluate(() =>
        window.moodcode.getBootstrap(),
      );
      assert.equal(connected.settings.providerId, "codex");
      assert.equal(connected.settings.baseURL, "");
      assert.equal(connected.settings.modelId, initial.settings.codexModelId);
    }
    console.log(
      JSON.stringify({
        ok: true,
        nativeStorage: "available",
        fileMode: "0600",
        plaintextStored: false,
        rendererCredentialReflected: false,
        settingsErrorVisibleInDialog: true,
        storedKeyRemoved: true,
        codexSettingsSwitch: initial.settings.codexAuthState === "available",
        providerRequests: 0,
      }),
    );
  }
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
