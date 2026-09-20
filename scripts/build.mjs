import { build as bundle } from "esbuild";
import { build as vite } from "vite";
import { existsSync } from "node:fs";

export async function buildHost() {
  await bundle({
    entryPoints: ["extensions/eve-workbench/src/extension.ts"],
    outfile: "extensions/eve-workbench/dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    sourcemap: true,
  });
  const entries = {
    main: "apps/desktop/host/main.ts",
    preload: "apps/desktop/host/preload.ts",
    core: "apps/desktop/host/core-worker.ts",
    "overlay-preload": "apps/desktop/host/overlay-preload.ts",
    model: "apps/desktop/host/model-worker.ts",
  };
  await bundle({
    entryPoints: Object.fromEntries(
      Object.entries(entries).filter(([, file]) => existsSync(file)),
    ),
    outdir: "dist/host",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "better-sqlite3"],
    sourcemap: true,
  });
}
if (process.argv[1]?.endsWith("build.mjs")) {
  await buildHost();
  await vite();
}
