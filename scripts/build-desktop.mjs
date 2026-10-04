import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const app = resolve("apps/desktop");
await mkdir(resolve(app, "dist/main"), { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron"],
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
  outdir: resolve(app, "dist/main"),
});
await build({
  ...common,
  format: "cjs",
  entryPoints: [resolve(app, "src/preload/index.ts")],
  outfile: resolve(app, "dist/main/preload.cjs"),
});
await buildRenderer({ configFile: resolve(app, "vite.config.mjs") });
