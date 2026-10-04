module.exports = {
  appId: "dev.moodcode.desktop",
  productName: "Moodcode",
  directories: { app: "apps/desktop", output: "release" },
  files: ["dist/main/**", "dist/renderer/**", "package.json"],
  asar: true,
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    identity: null,
  },
  npmRebuild: false,
};
