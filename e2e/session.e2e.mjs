// =============================================================================
// e2e/session.e2e.mjs
// The test that was impossible until now: a REAL Chromium, the REAL extension,
// a REAL page, and a full record -> interact -> stop -> artifacts cycle.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, callExtension, readStore, openExtensionPage, waitFor,
  readRecordingState, grantOriginLikeATester,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

let browser;
let server;
let extensionPage;   // any extension-origin page can read the shared IndexedDB

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

  console.log(`\n  extension: ${browser.extensionId}\n  fixtures:  ${server.url}\n`);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test("the extension loads and its service worker is alive", async () => {
  const manifest = await browser.serviceWorker.evaluate(
    () => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Tester-Reporter-AI");
});

test("content scripts inject into a normal http page", async () => {
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/catalog.html`, { waitUntil: "domcontentloaded" });

  // The MAIN-world script sets a marker on window; the ISOLATED one does too,
  // but in its own world, so only the MAIN marker is visible from page context.
  const mainWorldInstalled = await page.evaluate(
    () => window.__testerReporterAiPageWorldInstalled === true);
  assert.equal(mainWorldInstalled, true,
    "the MAIN-world patch script did not run");

  await page.close();
});

test("a full recording session captures events, page code and a script",
  async () => {
    const page = await browser.context.newPage();
    await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
    await page.bringToFront();

    const tabId = await browser.serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id ?? -1;
    });
    assert.ok(tabId > 0, "could not find the active tab");

    // --- Start, exactly as the side panel does. ---------------------------
    const startReply = await callExtension(extensionPage, {
      kind: "ui/start-recording", tabId, captureMicrophone: false,
    });
    assert.ok(startReply === null || startReply.ok !== false,
      `start failed: ${JSON.stringify(startReply)}`);

    await waitFor("session to reach 'recording'", async () => {
      const state = await readRecordingState(browser.serviceWorker);
      return state?.status === "recording";
    });

    // The page must be the focused tab for the content script to receive the
    // start signal, and the tester's clicks have to land on it.
    await page.bringToFront();

    // --- Do what a tester does. -------------------------------------------
    await page.click('[data-testid="tab-renewal"]');
    await page.fill("#tenant", "TN-40192");
    await page.press("#tenant", "Enter");
    await page.waitForTimeout(1500);          // let the 500 and the TypeError land
    await page.click("tbody tr:nth-child(3) .view");
    await page.waitForTimeout(800);

    // --- Stop. ------------------------------------------------------------
    await callExtension(extensionPage, { kind: "ui/stop-recording" });

    const session = await waitFor("session to leave 'processing'", async () => {
      const sessions = await readStore(extensionPage, "sessions");
      const s = sessions[0];
      return s && s.status !== "processing" && s.status !== "recording" ? s : null;
    }, 40000);

    console.log(`  session status: ${session.status}`);
    console.log(`  events: ${session.eventCount}, snapshots: ${session.domSnapshotCount}`);
    console.log(`  media: ${session.media.state} (${session.media.sizeBytes} bytes, ${session.media.mimeType || "none"})`);
    console.log(`  network failures: ${session.networkFailureCount}, console errors: ${session.consoleErrorCount}`);

    // --- What must be true. -----------------------------------------------
    const events = await readStore(extensionPage, "events");
    const snapshots = await readStore(extensionPage, "domSnapshots");
    const contexts = await readStore(extensionPage, "elementContexts");
    const network = await readStore(extensionPage, "networkEntries");
    const consoleEntries = await readStore(extensionPage, "consoleEntries");

    assert.ok(events.length >= 4,
      `expected at least 4 events, got ${events.length}: `
      + JSON.stringify(events.map((e) => e.type)));

    const types = events.map((e) => e.type);
    assert.ok(types.includes("click"), `no click recorded: ${types}`);
    assert.ok(types.includes("input"), `no input recorded: ${types}`);
    assert.ok(types.includes("press-key"), `no key press recorded: ${types}`);

    // The typed value must have survived.
    const inputEvent = events.find((e) => e.type === "input");
    assert.equal(inputEvent.value, "TN-40192");

    // The tab click must have produced a usable locator.
    const tabClick = events.find(
      (e) => e.type === "click" && e.locator?.primary?.value?.includes("tab-renewal"));
    assert.ok(tabClick, "the tab click did not produce a test-id locator");

    // Page code.
    assert.ok(snapshots.length >= 1, "no DOM snapshot captured");
    const allHtml = snapshots.map((s) => s.prunedHtml).join("\n");
    assert.ok(allHtml.includes("Contract Renewal &amp; Continuation"),
      "the captured page code lost the tab labels");
    assert.ok(allHtml.includes("Tenant ID must be 8 digits"),
      "the hidden error message was not captured - it is exactly the evidence "
      + "the AI needs");
    assert.ok(allHtml.includes('data-qa-hidden="true"'),
      "the hidden element was not tagged as hidden");

    assert.ok(contexts.length >= 1, "no element context captured");

    // The deliberate 500 must have been seen.
    const failures = network.filter((n) => n.isFailure);
    assert.ok(failures.length >= 1,
      `the 500 was not captured. entries: ${JSON.stringify(network.map((n) => [n.source, n.method, n.statusCode]))}`);
    const five00 = failures.find((f) => f.statusCode === 500);
    assert.ok(five00, "no 500 among the failures");
    console.log(`  captured failure: ${five00.source} ${five00.method} ${five00.statusCode}`);

    // The TypeError the page throws afterwards.
    assert.ok(consoleEntries.length >= 1,
      "the console error was not captured");

    // The final-state snapshot must exist.
    assert.ok(snapshots.some((s) => s.trigger === "session-stop"),
      `no session-stop snapshot. triggers: ${snapshots.map((s) => s.trigger)}`);

    await page.close();
  });
