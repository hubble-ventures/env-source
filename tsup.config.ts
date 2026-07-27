import { defineConfig } from "tsup";

// Two build targets from one core:
//
//  1. The library + CLI — ESM, published to npm. `zod`/`smol-toml` stay external
//     (declared runtime deps); consumers get a slim, tree-shakeable package.
//     Type declarations are emitted separately by `tsc -p tsconfig.build.json`.
//  2. The GitHub Action — a single self-contained CommonJS file committed to the
//     repo so `uses: hubble-ventures/env-source@v1` runs with no install step.
//     Everything is bundled in (noExternal).
export default defineConfig([
  {
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  {
    entry: { index: "src/action.ts" },
    format: ["cjs"],
    target: "node20",
    outDir: "action",
    outExtension: () => ({ js: ".cjs" }),
    noExternal: [/.*/],
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
  },
]);
