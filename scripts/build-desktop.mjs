import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const app = resolve("apps/desktop");
await mkdir(resolve(app, "dist/main"), { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron", "electron-updater", "jose", "node-pty"],
  sourcemap: false,
  logLevel: "info",
};
await build({
  ...common,
  format: "esm",
  entryPoints: {
    index: resolve(app, "src/main/index.ts"),
    "engine-worker": resolve(app, "src/worker/index.ts"),
    supervisor: resolve("packages/engine/src/tools/command/supervisor.ts"),
  },
  plugins: [{
    name: "preserve-pty-supervisor-owner",
    setup(builder) {
      // The PTY backend resolves its sibling supervisor from import.meta.url.
      // Keep that boundary distinct from the command supervisor at main/supervisor.js.
      builder.onResolve({ filter: /backend\.js$/ }, args => {
        if (/[\\/]packages[\\/]engine[\\/](?:src|dist)[\\/]terminals[\\/]/u.test(args.importer)) {
          return { path: "./terminals/backend.js", external: true };
        }
      });
    },
  }],
  outdir: resolve(app, "dist/main"),
});
await build({
  ...common,
  format: "esm",
  entryPoints: {
    backend: resolve("packages/engine/src/terminals/backend.ts"),
    supervisor: resolve("packages/engine/src/terminals/supervisor.ts"),
  },
  outdir: resolve(app, "dist/main/terminals"),
});
await writeFile(resolve(app, "dist/main/release-policy.json"), JSON.stringify({
  schemaVersion: 1,
  profile: process.env.MOODCODE_DESKTOP_RELEASE === "1" ? "release" : "development",
  channel: "stable",
  provider: "github",
  owner: "yakisoba0728",
  repo: "Moodcode",
}));
await build({
  ...common,
  format: "cjs",
  entryPoints: [resolve(app, "src/preload/index.ts")],
  outfile: resolve(app, "dist/main/preload.cjs"),
});
await buildRenderer({ configFile: resolve(app, "vite.config.mjs") });
