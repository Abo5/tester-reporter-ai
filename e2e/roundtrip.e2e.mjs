// =============================================================================
// e2e/roundtrip.e2e.mjs
//
// THE PROOF. Everything else checks that the extension captured plausible data.
// This one records a session, takes the .spec.ts the extension generated, and
// RUNS IT with Playwright against the same page.
//
// If the generated script does not replay, the product's central promise -
// "a runnable Playwright script" - is not true, however good the report looks.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  launchWithExtension, callExtension, readStore, openExtensionPage, waitFor,
  readRecordingState, grantOriginLikeATester,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const execFileAsync = promisify(execFile);

let browser;
let server;
let extensionPage;
let workDir;

before(async () => {
  server = await startFixtureServer();
  browser = await launchWithExtension();
  extensionPage = await openExtensionPage(browser.context, browser.extensionId,
    "options/options.html");
  // The extension ships with NO page access - <all_urls> is optional, and the
  // content scripts are registered at run time for granted origins only. So a
  // test grants first, through the real options-page flow, exactly as a tester
  // would. Without this the session records a video and zero events.
  const granted = await grantOriginLikeATester(extensionPage, server.url);
  assert.ok(granted, "the fixture origin was not granted; is a window manager running?");

  // Two constraints on where the generated spec lives:
  //  - it imports '@playwright/test', so Node must be able to resolve that,
  //    which means inside this project rather than /tmp;
  //  - the directory must not start with a dot, because the Playwright runner
  //    skips hidden directories and reports "No tests found".
  workDir = fs.mkdtempSync(path.join(process.cwd(), "roundtrip-tmp-"));
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/** Records one session and returns the generated spec source. */
async function recordAndGenerate(fixturePath, interact) {
  const page = await browser.context.newPage();
  await page.goto(`${server.url}${fixturePath}`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);

  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("recording", async () =>
    (await readRecordingState(browser.serviceWorker))?.status === "recording");
  await page.bringToFront();
  await page.waitForTimeout(300);

  await interact(page);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 40000);

  await page.close();
  return session;
}

/** Writes the spec to disk and runs it with the real Playwright runner. */
async function runGeneratedSpec(specSource, name) {
  const specDir = path.join(workDir, name);
  fs.mkdirSync(specDir, { recursive: true });

  const specFile = path.join(specDir, `${name}.spec.ts`);
  fs.writeFileSync(specFile, specSource, "utf8");

  fs.writeFileSync(path.join(specDir, "playwright.config.ts"), `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  // The generated spec raises its own timeout with test.setTimeout(), because
  // it waits on purpose. This config value is only the floor; leaving it at the
  // default was what made the paced script die mid-replay with "Target page,
  // context or browser has been closed".
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  use: { headless: false, launchOptions: { args: ['--no-sandbox'] } },
});
`, "utf8");

  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["playwright", "test", "--config", path.join(specDir, "playwright.config.ts")],
      { cwd: process.cwd(), timeout: 180000, env: { ...process.env } },
    );
    return { ok: true, output: stdout + stderr };
  } catch (error) {
    return { ok: false, output: (error.stdout ?? "") + (error.stderr ?? "") + String(error.message) };
  }
}

test("a recorded session produces a script that actually replays", async () => {
  const session = await recordAndGenerate("/catalog.html", async (page) => {
    await page.click('[data-testid="tab-renewal"]');
    await page.waitForTimeout(300);
    await page.fill("#tenant", "TN-40192");
    await page.waitForTimeout(800);
    await page.press("#tenant", "Enter");
    await page.waitForTimeout(1200);
    await page.click("tbody tr:nth-child(3) .view");
    await page.waitForTimeout(600);
  });

  assert.ok(session.playwrightScript.length > 100,
    "no script was generated");

  console.log("\n--- generated spec ---\n" + session.playwrightScript);

  const result = await runGeneratedSpec(session.playwrightScript, "catalog");
  console.log("\n--- replay output ---\n" + result.output.slice(0, 2500));

  assert.ok(result.ok,
    "THE GENERATED SCRIPT DID NOT REPLAY. This is the product's central "
    + "promise.\n" + result.output.slice(0, 2500));
});

test("a bilingual RTL page also produces a replayable script", async () => {
  const session = await recordAndGenerate("/bilingual.html", async (page) => {
    await page.fill("#name", "شركة الرياض للتطوير");
    await page.waitForTimeout(800);
    await page.selectOption("#duration", "36");
    await page.waitForTimeout(300);
    await page.check("#agree");
    await page.waitForTimeout(300);
    await page.click("#submit-renew");
    await page.waitForTimeout(600);
  });

  console.log("\n--- generated spec (RTL) ---\n" + session.playwrightScript);

  const result = await runGeneratedSpec(session.playwrightScript, "bilingual");
  console.log("\n--- replay output ---\n" + result.output.slice(0, 2000));

  assert.ok(result.ok,
    "the Arabic/RTL script did not replay\n" + result.output.slice(0, 2000));
});
