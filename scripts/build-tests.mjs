// =============================================================================
// scripts/build-tests.mjs
// Bundles tests/test-api.ts into one ESM file the node:test suite can import.
// =============================================================================

import * as esbuild from "esbuild";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

await esbuild.build({
  entryPoints: [path.join(ROOT, "tests/test-api.ts")],
  outfile: path.join(ROOT, "dist-test/test-api.mjs"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["node22"],
  sourcemap: false,
  minify: false,
  logLevel: "warning",
});

console.log("Test bundle written to dist-test/test-api.mjs");
