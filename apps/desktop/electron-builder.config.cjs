const release = process.env.MOODCODE_DESKTOP_RELEASE === "1";

module.exports = {
  appId: "dev.moodcode.desktop",
  productName: "Moodcode",
  directories: { app: "apps/desktop", output: "release" },
  files: ["dist/main/**", "dist/renderer/**", "package.json"],
  asar: true,
  asarUnpack: ["node_modules/node-pty/**", "node_modules/@moodcode/windows-job/**"],
  forceCodeSigning: release && process.platform !== "linux",
  electronUpdaterCompatibility: ">=2.16",
  publish: release ? [{ provider: "github", owner: "yakisoba0728", repo: "Moodcode", releaseType: "draft" }] : null,
  mac: {
    target: release ? ["dmg", "zip"] : ["dir"],
    category: "public.app-category.developer-tools",
    ...(release ? { hardenedRuntime: true, notarize: true, entitlements: "apps/desktop/build/entitlements.mac.plist", entitlementsInherit: "apps/desktop/build/entitlements.mac.plist" } : { identity: null, notarize: false }),
  },
  linux: {
    target: release ? ["AppImage"] : ["dir"],
    category: "Development",
  },
  win: {
    target: release ? ["nsis"] : ["dir"],
    verifyUpdateCodeSignature: true,
    ...(release && process.env.MOODCODE_WINDOWS_PUBLISHER_NAME ? { publisherName: process.env.MOODCODE_WINDOWS_PUBLISHER_NAME } : {}),
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  npmRebuild: false,
};
