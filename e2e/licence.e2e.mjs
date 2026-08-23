// =============================================================================
// e2e/licence.e2e.mjs
//
// The trial, in a real browser.
//
// A paywall that only passes unit tests is not a paywall: the question is
// whether the REPORT BUTTON actually stops working when the trial ends, and
// whether everything the tester already recorded survives it.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, openExtensionPage, callExtension, readStore, waitFor,
  readRecordingState, grantOriginLikeATester,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

let browser;
let server;
let extensionPage;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  server = await startFixtureServer();
  browser = await launchWithExtension();
  extensionPage = await openExtensionPage(browser.context, browser.extensionId,
    "options/options.html");
  const granted = await grantOriginLikeATester(extensionPage, server.url);
  assert.ok(granted, "the fixture origin was not granted");
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Rewrites the stored licence state, the way time passing would. */
async function setTrialAge(days) {
  await browser.serviceWorker.evaluate(async (elapsedMs) => {
    const now = Date.now();
    await chrome.storage.local.set({
      licenceState: {
        firstRunAtMs: now - elapsedMs,
        highWaterMarkMs: now,
        licenceKey: "",
        licenceVerifiedAtMs: 0,
        lastVerificationMessage: "",
      },
    });
  }, days * DAY);
}

test("a fresh install is inside its trial", async () => {
  const state = await browser.serviceWorker.evaluate(
    async () => (await chrome.storage.local.get("licenceState")).licenceState);

  assert.ok(state, "the trial was never started on install");
  assert.ok(state.firstRunAtMs > 0, "no install date was recorded");
});

test("the side panel names the days left", async () => {
  await setTrialAge(3);

  const panel = await openExtensionPage(browser.context, browser.extensionId,
    "sidepanel/sidepanel.html");
  await panel.waitForTimeout(1200);

  const line = await panel.evaluate(() => {
    const el = document.getElementById("trial-line");
    return { hidden: el.hidden, text: el.textContent };
  });
  console.log(`  panel says: ${JSON.stringify(line)}`);

  assert.equal(line.hidden, false, "the panel said nothing about the trial");
  assert.match(line.text, /11 days left/,
    "a silent trial is one the customer discovers by being cut off");

  await panel.close();
});

test("an expired trial blocks the report and says what still works", async () => {
  await setTrialAge(20);

  const panel = await openExtensionPage(browser.context, browser.extensionId,
    "sidepanel/sidepanel.html");
  await panel.waitForTimeout(1200);

  const line = await panel.evaluate(() => {
    const el = document.getElementById("trial-line");
    return { classes: el.className, text: el.textContent };
  });
  console.log(`  panel says: ${line.text}`);

  assert.match(line.text, /trial has ended/);
  assert.match(line.text, /Playwright script still work/,
    "the tester must be told their recording is safe");
  assert.match(line.classes, /trial-over/);

  await panel.close();
});

test("recording still works after the trial ends", async () => {
  // The trial gates the REPORT, not the product. A tester whose trial expires
  // mid-session must not lose the session.
  await setTrialAge(20);

  const page = await browser.context.newPage();
  await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);

  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("session to reach 'recording'", async () => {
    const state = await readRecordingState(browser.serviceWorker);
    return state?.status === "recording";
  });

  await page.bringToFront();
  await page.click('[data-testid="tab-renewal"]');
  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(700);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session to finish", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const finished = sessions.filter((s) => s.status !== "processing"
      && s.status !== "recording");
    if (finished.length === 0) { return null; }
    finished.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return finished[0];
  }, 40000);

  console.log(`  events: ${session.eventCount}, script: `
    + `${session.playwrightScript.length} chars`);

  assert.ok(session.eventCount >= 2,
    "an expired trial stopped the recording; it must only stop the report");
  assert.ok(session.playwrightScript.length > 100,
    "the Playwright script must still be generated after the trial ends");

  await page.close();
});

test("the options page never claims a key was verified when nothing verified it", async () => {
  // With no licence server configured the check is a shape test on the
  // customer's own machine. Reporting that as verification would be lying to
  // the operator about how much revenue is protected.
  await extensionPage.reload();
  await extensionPage.waitForTimeout(900);

  await extensionPage.fill("#licence-input", "TRA-4F2A-9C31-88BE");
  await extensionPage.click("#licence-verify-button");
  await extensionPage.waitForTimeout(1200);

  const message = await extensionPage.textContent("#licence-message");
  console.log(`  verification says: ${message}`);

  assert.match(message, /no licence server is configured/,
    "the UI must say the check was local, not call it verification");

  const buyNote = await extensionPage.textContent("#licence-buy-note");
  assert.match(buyNote, /No payment link is configured/,
    "a Buy button with no link behind it must say so");
});
