// =============================================================================
// e2e/video-ai.e2e.mjs
//
// The last unproven link: a REAL recorded video, sent to the REAL Gemini API.
//
// Until tab capture started working, every AI run went out with
// deliveryMode "omitted", so nothing had ever exercised the video half of the
// pipeline - and uploadVideoToFilesApi still carries a comment saying it is a
// sketch of the flow rather than verified code.
//
// Needs a key in .env. Skips without one.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, callExtension, readStore, openExtensionPage, waitFor,
  readRecordingState, sendBrowserShortcut,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const API_KEY = (process.env.GEMINI_API_KEY ?? "").trim();
const MODEL_ID = (process.env.GEMINI_MODEL ?? "").trim();
const HAVE_KEY = API_KEY !== "";

let browser;
let server;
let extensionPage;

before(async () => {
  if (!HAVE_KEY) {
    console.log("\n  No GEMINI_API_KEY in .env - the video/AI check is skipped.\n");
    return;
  }
  server = await startFixtureServer();
  browser = await launchWithExtension();
  extensionPage = await openExtensionPage(browser.context, browser.extensionId,
    "options/options.html");
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test("a really recorded video is accepted and analysed by the model", async (t) => {
  if (!HAVE_KEY) {
    t.skip("no GEMINI_API_KEY in .env");
    return;
  }

  // Key in, and video upload permitted - the opposite of the other AI test.
  await extensionPage.evaluate(async (settings) => {
    const stored = await chrome.storage.local.get("extensionSettings");
    await chrome.storage.local.set({
      extensionSettings: {
        ...(stored.extensionSettings ?? {}),
        geminiApiKey: settings.apiKey,
        modelId: settings.modelId || "gemini-3.5-flash",
        reportLanguage: "en",
        neverUploadVideo: false,
        videoUploadConsentGiven: true,   // consent is a UI gate, tested elsewhere
        captureTabAudio: true,
      },
    });
  }, { apiKey: API_KEY, modelId: MODEL_ID });

  for (const existing of browser.context.pages()) {
    if (existing.url() === "about:blank") {
      await existing.close().catch(() => {});
    }
  }

  const page = await browser.context.newPage();
  await page.goto(`${server.url}/bench.html`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForTimeout(800);

  const delivered = await sendBrowserShortcut("ctrl+shift+e");
  const started = delivered
    ? await waitFor("recording", async () => {
        const state = await readRecordingState(browser.serviceWorker);
        return state?.status === "recording" ? state : null;
      }, 12000).catch(() => null)
    : null;

  if (started === null) {
    t.skip("could not arm recording in this environment");
    await page.close();
    return;
  }

  // Drive the seeded failure so there is something for the model to find.
  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(700);
  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(700);
  await page.click("#lookup-btn");
  await page.waitForTimeout(2500);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });

  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 45000);
  await page.close();

  console.log(`  recorded: ${session.media.sizeBytes} bytes `
    + `${session.media.mimeType} ${session.media.durationMs}ms`);

  if (session.media.state !== "stopped" || session.media.sizeBytes < 1000) {
    t.skip("no video was captured: " + session.media.failureReason);
    return;
  }

  // The review page runs the real pipeline, video and all.
  const reviewPage = await openExtensionPage(browser.context, browser.extensionId,
    `review/review.html?session=${encodeURIComponent(session.id)}`);
  await reviewPage.locator("#report-text").waitFor({ state: "visible", timeout: 30000 });

  const finished = await waitFor("the report to come back", async () => {
    const rows = await readStore(extensionPage, "sessions");
    const s = rows.find((row) => row.id === session.id);
    if (s && s.bugReport !== null) {
      return { ok: true, session: s };
    }
    if (s && s.status === "report-failed") {
      return { ok: false, session: s };
    }
    return null;
  }, 180000);

  // The DB write happens before the page re-renders, so waiting on IndexedDB
  // alone races the UI. Wait for what the tester actually sees.
  await waitFor("the report textarea to be filled", async () => {
    const value = await reviewPage.locator("#report-text").inputValue();
    return value.trim().length > 0;
  }, 30000);

  const status = String(await reviewPage.locator("#report-status-text").textContent()).trim();
  console.log(`  review page: ${status.slice(0, 200)}`);

  if (!finished.ok) {
    const raw = await reviewPage.locator("#raw-response-text").textContent().catch(() => "");
    assert.fail("the pipeline failed WITH video: "
      + finished.session.reportFailureReason + "\n" + String(raw).slice(0, 1500));
  }

  const report = finished.session.bugReport;
  console.log(`  video delivery: ${finished.session.lastVideoDeliveryMode}`);
  console.log(`  downgrade note: ${finished.session.videoDowngradeReason || "(none)"}`);
  console.log(`  evidenceUsed  : ${JSON.stringify(report.evidenceUsed)}`);
  console.log(`  confidence    : ${report.confidence}`);
  console.log("\n--- REPORT FROM A SESSION WITH REAL VIDEO ---");
  console.log(await reviewPage.locator("#report-text").inputValue());

  // The point of the test: the video actually went, and was actually used.
  assert.notEqual(finished.session.lastVideoDeliveryMode, "omitted",
    "the video was recorded but never sent: "
    + finished.session.videoDowngradeReason);

  assert.equal(report.evidenceUsed.video, true,
    "video was sent, so the model should report having used it. "
    + `Delivery mode was ${finished.session.lastVideoDeliveryMode}.`);

  const badges = await reviewPage.locator("#evidence-badges .badge").allTextContents();
  console.log(`  badges: ${JSON.stringify(badges)}`);
  assert.ok(badges.some((b) => b.startsWith("✓") && b.includes("Video")),
    `the Video badge should be lit: ${JSON.stringify(badges)}`);

  await reviewPage.close();
});
