// =============================================================================
// scripts/build.mjs
// The whole build. One esbuild call per entry point, then a copy pass.
//
// WHY esbuild directly instead of a bundler config: an extension has seven
// entry points that need DIFFERENT output formats. Content scripts must be IIFE
// because a content script cannot be an ES module; the service worker and the
// extension pages must be ESM. Expressing that is three lines here and a fight
// with any bundler's conventions.
// =============================================================================

import * as esbuild from "esbuild";
import { mkdir, copyFile, readdir, rm, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");
const WATCH = process.argv.includes("--watch");

/**
 * Every bundle we produce, with the format each context requires.
 */
const ENTRY_POINTS = [
  { in: "src/background/service-worker.ts", out: "background/service-worker.js", format: "esm" },
  { in: "src/content/page-world.ts",        out: "content/page-world.js",        format: "iife" },
  { in: "src/content/recorder.ts",          out: "content/recorder.js",          format: "iife" },
  { in: "src/offscreen/offscreen.ts",       out: "offscreen/offscreen.js",       format: "esm" },
  { in: "src/sidepanel/sidepanel.ts",       out: "sidepanel/sidepanel.js",       format: "esm" },
  { in: "src/review/review.ts",             out: "review/review.js",            format: "esm" },
  { in: "src/options/options.ts",           out: "options/options.js",          format: "esm" },
];

/**
 * Static files copied verbatim, as [source, destination] relative pairs.
 */
const STATIC_FILES = [
  ["public/manifest.json",            "manifest.json"],
  ["src/offscreen/offscreen.html",    "offscreen/offscreen.html"],
  ["src/sidepanel/sidepanel.html",    "sidepanel/sidepanel.html"],
  ["src/sidepanel/sidepanel.css",     "sidepanel/sidepanel.css"],
  ["src/review/review.html",          "review/review.html"],
  ["src/review/review.css",           "review/review.css"],
  ["src/options/options.html",        "options/options.html"],
  ["src/options/options.css",         "options/options.css"],
];

/** Copies one file, creating its parent directory first. */
async function copyOne(relativeSource, relativeDestination) {
  const source = path.join(ROOT, relativeSource);
  const destination = path.join(OUT_DIR, relativeDestination);
  if (!existsSync(source)) {
    throw new Error("Missing static file: " + relativeSource);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Copies the icons directory. */
async function copyIcons() {
  const source = path.join(ROOT, "public/icons");
  const destination = path.join(OUT_DIR, "icons");
  await mkdir(destination, { recursive: true });
  const names = await readdir(source);
  for (const name of names) {
    await copyFile(path.join(source, name), path.join(destination, name));
  }
}

/** Builds (or watches) one entry point. */
async function buildEntry(entry) {
  const options = {
    entryPoints: [path.join(ROOT, entry.in)],
    outfile: path.join(OUT_DIR, entry.out),
    bundle: true,
    format: entry.format,
    target: ["chrome116"],
    platform: "browser",
    sourcemap: WATCH ? "inline" : false,
    minify: !WATCH,
    legalComments: "none",
    logLevel: "warning",
  };

  if (WATCH) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  await esbuild.build(options);
}

/** Reports the size of everything we produced, so bloat is visible. */
async function reportSizes() {
  const rows = [];
  async function walk(directory, prefix) {
    for (const name of await readdir(directory)) {
      const full = path.join(directory, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full, prefix + name + "/");
      } else {
        rows.push([prefix + name, info.size]);
      }
    }
  }
  await walk(OUT_DIR, "");
  rows.sort((left, right) => right[1] - left[1]);

  let total = 0;
  for (const [, size] of rows) {
    total += size;
  }
  console.log("\n  dist/ contents:");
  for (const [name, size] of rows) {
    console.log("    " + String(Math.ceil(size / 1024)).padStart(5) + " KB  " + name);
  }
  console.log("    " + "-".repeat(40));
  console.log("    " + String(Math.ceil(total / 1024)).padStart(5) + " KB  total\n");
}

/**
 * Checks that every path the manifest and the HTML files reference actually
 * exists in dist/.
 *
 * WHY it runs on every build: a renamed entry point or a moved stylesheet
 * produces an extension that loads and then fails at runtime with a blank
 * panel, which is a slow and confusing thing to debug. Catching it here costs
 * milliseconds.
 */
async function validateDist() {
  const missing = [];

  const check = (relative, label) => {
    if (!existsSync(path.join(OUT_DIR, relative))) {
      missing.push(label + ": " + relative);
    }
  };

  const manifest = JSON.parse(
    await readFile(path.join(OUT_DIR, "manifest.json"), "utf8"),
  );

  check(manifest.background.service_worker, "background.service_worker");
  check(manifest.side_panel.default_path, "side_panel.default_path");
  check(manifest.options_page, "options_page");

  for (const [size, relative] of Object.entries(manifest.icons)) {
    check(relative, "icons[" + size + "]");
  }
  for (const [size, relative] of Object.entries(manifest.action.default_icon)) {
    check(relative, "action.default_icon[" + size + "]");
  }
  // The content scripts are registered at run time, not declared in the
  // manifest, so the manifest no longer names the files that have to exist.
  // They still have to exist: chrome.scripting.registerContentScripts fails at
  // run time with a path that is not in the package, and that failure would
  // show up as "recording captured nothing" rather than as a build error.
  // These are the two paths src/background/content-script-registration.ts asks
  // for, checked here so a rename cannot ship silently.
  check("content/page-world.js", "registerContentScripts");
  check("content/recorder.js", "registerContentScripts");

  if (manifest.content_scripts !== undefined) {
    for (let index = 0; index < manifest.content_scripts.length; index += 1) {
      for (const js of manifest.content_scripts[index].js) {
        check(js, "content_scripts[" + index + "].js");
      }
    }
  }

  // Every src=/href= in a built HTML file must resolve next to that file.
  const htmlFiles = [];
  const walk = async (directory) => {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, name.name);
      if (name.isDirectory()) {
        await walk(full);
      } else if (name.name.endsWith(".html")) {
        htmlFiles.push(full);
      }
    }
  };
  await walk(OUT_DIR);

  for (const htmlFile of htmlFiles) {
    const contents = await readFile(htmlFile, "utf8");
    for (const match of contents.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (reference.startsWith("http") || reference.startsWith("data:")
          || reference.startsWith("#")) {
        continue;
      }
      if (!existsSync(path.resolve(path.dirname(htmlFile), reference))) {
        missing.push(path.relative(OUT_DIR, htmlFile) + " -> " + reference);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      "dist/ is missing files that are referenced:\n  " + missing.join("\n  "),
    );
  }
}

async function main() {
  if (!WATCH) {
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });

  for (const entry of ENTRY_POINTS) {
    await buildEntry(entry);
  }
  for (const [source, destination] of STATIC_FILES) {
    await copyOne(source, destination);
  }
  await copyIcons();

  if (WATCH) {
    console.log("Watching for changes. Press Ctrl+C to stop.");
    return;
  }

  await validateDist();
  await reportSizes();
  console.log("Build complete. Load dist/ as an unpacked extension.");
}

main().catch((error) => {
  console.error("Build failed:", error);
  process.exitCode = 1;
});
