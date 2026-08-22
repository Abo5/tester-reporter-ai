// =============================================================================
// e2e/full-pipeline.e2e.mjs
//
// THE WHOLE THING, once, for real:
//   real Chromium -> real extension -> real page -> real capture
//   -> real redaction gate -> real Gemini call -> real bug report
//
// Every other test checks one link in that chain. This checks the chain.
//
// It needs a key in .env and is skipped without one, so it never blocks a run.
// Node loads .env itself via --env-file-if-exists; nothing here reads that file.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, callExtension, readStore, openExtensionPage, waitFor,
  readRecordingState, grantOriginLikeATester,
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
    console.log("\n  No GEMINI_API_KEY in .env - the full-pipeline check is skipped.\n");
    return;
  }
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

});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test("a real session becomes a real AI bug report", async (t) => {
  if (!HAVE_KEY) {
    t.skip("no GEMINI_API_KEY in .env");
    return;
  }

  // --- Put the key where the extension expects it. ------------------------
  // The value comes from Node's environment, not from anything this test reads.
  await extensionPage.evaluate(async (settings) => {
    const stored = await chrome.storage.local.get("extensionSettings");
    const existing = stored.extensionSettings ?? {};
    await chrome.storage.local.set({
      extensionSettings: {
        ...existing,
        geminiApiKey: settings.apiKey,
        modelId: settings.modelId || existing.modelId || "gemini-3.5-flash",
        reportLanguage: "en",
        neverUploadVideo: true,      // no video in this environment anyway
        videoUploadConsentGiven: false,
        customRedactionPatterns: existing.customRedactionPatterns ?? [],
      },
    });
  }, { apiKey: API_KEY, modelId: MODEL_ID });

  // --- Record a session on the seeded bench. ------------------------------
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/bench.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);

  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("recording", async () =>
    (await readRecordingState(browser.serviceWorker))?.status === "recording");
  await page.bringToFront();
  await page.waitForTimeout(400);

  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(400);
  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(800);
  await page.click("#lookup-btn");
  await page.waitForTimeout(2000);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });

  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 45000);
  await page.close();

  // --- Open the review page: it runs the real pipeline. -------------------
  const reviewPage = await openExtensionPage(browser.context, browser.extensionId,
    `review/review.html?session=${encodeURIComponent(session.id)}`);

  const statusLine = reviewPage.locator("#report-status-text");
  await statusLine.waitFor({ timeout: 20000 });

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
  }, 120000);

  // The DB write happens inside handleOutcome BEFORE the page re-renders, so
  // waiting on IndexedDB alone races the UI. Wait for what the tester actually
  // sees.
  await reviewPage.locator("#report-text").waitFor({ state: "visible", timeout: 30000 });
  await waitFor("the report textarea to be filled", async () => {
    const value = await reviewPage.locator("#report-text").inputValue();
    return value.trim().length > 0;
  }, 30000);

  const statusText = await statusLine.textContent();
  console.log(`\n  review page says: ${String(statusText).trim().slice(0, 160)}`);

  if (!finished.ok) {
    const raw = await reviewPage.locator("#raw-response-text").textContent()
      .catch(() => "");
    assert.fail("the pipeline failed: "
      + finished.session.reportFailureReason + "\n" + String(raw).slice(0, 1200));
  }

  const report = finished.session.bugReport;

  console.log("\n" + "=".repeat(70));
  console.log("  REPORT FROM A REAL RECORDED SESSION");
  console.log("=".repeat(70));
  console.log(await reviewPage.locator("#report-text").inputValue());
  console.log("=".repeat(70));
  console.log("  evidenceUsed: " + JSON.stringify(report.evidenceUsed));
  console.log("  confidence:   " + report.confidence
    + "   severity: " + report.severityGuess
    + "   type: " + report.defectType);
  console.log("  supporting:   " + JSON.stringify(report.supportingEvidence, null, 2));
  console.log("  unverified:   " + JSON.stringify(report.unverifiedClaims, null, 2));
  console.log("  secondary:    " + JSON.stringify(report.secondaryIssues, null, 2));

  // --- What the report must get right. ------------------------------------
  assert.equal(report.evidenceUsed.video, false,
    "no video existed, so the model must not claim it watched one");
  assert.equal(report.evidenceUsed.pageCode, true,
    "page code was captured and sent; the model should have used it");

  const body = [
    report.title, report.description, report.currentBehavior,
    report.supportingEvidence.join(" "), report.secondaryIssues.join(" "),
  ].join(" ").toLowerCase();

  // It must be grounded in something actually captured from THIS page.
  const grounded = ["500", "tn-40192", "8 digits", "aria-invalid",
    "tenant_not_found", "contract"].some((needle) => body.includes(needle));
  assert.ok(grounded,
    "the report cites nothing that was actually captured:\n" + body.slice(0, 600));

  // The steps must read like instructions, not code.
  assert.ok(report.stepsToReproduce.length >= 1);
  for (const step of report.stepsToReproduce) {
    // Match actual CALLS, not the word "page". An earlier version of this
    // pattern used /page\./ and flagged the sentence "…the Bench page." as
    // code, which is the kind of false positive that makes people delete tests.
    const looksLikeCode =
      /\bgetBy(Role|TestId|Label|Text|Placeholder|AltText|Title)\s*\(/.test(step)
      || /\bpage\.\w+\s*\(/.test(step)
      || /\blocator\s*\(/.test(step)
      || /\bawait\s+\w/.test(step);
    assert.ok(!looksLikeCode,
      `a reproduction step contains code rather than instructions: ${step}`);
  }

  // The badges the tester relies on must render.
  const badges = await reviewPage.locator("#evidence-badges .badge").allTextContents();
  console.log("  badges rendered: " + JSON.stringify(badges));
  assert.ok(badges.length >= 5, "the evidence badges did not render");
  assert.ok(badges.some((b) => b.includes("Video")));

  await reviewPage.close();
});
