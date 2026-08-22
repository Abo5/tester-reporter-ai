// =============================================================================
// e2e/perf.e2e.mjs
//
// How long does capture block the page under test?
//
// This has to be measured in a REAL browser. jsdom's getComputedStyle and
// querySelectorAll are orders of magnitude slower than Chrome's, so a number
// from a unit test says nothing useful about what a tester feels.
//
// The measurement that matters is the delay between the tester's click and the
// application's own handler running, because capture runs synchronously in the
// capture phase, ahead of it.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, callExtension, openExtensionPage, waitFor,
  readRecordingState, readStore,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

let browser;
let server;
let extensionPage;

before(async () => {
  server = await startFixtureServer();
  browser = await launchWithExtension();
  extensionPage = await openExtensionPage(browser.context, browser.extensionId,
    "options/options.html");
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test("capture does not make a 600-row page feel slow", async () => {
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/large-table.html`, { waitUntil: "load" });
  await page.bringToFront();

  const elementCount = await page.evaluate(() => document.querySelectorAll("*").length);
  console.log(`  page elements: ${elementCount}`);

  // Baseline: how long does a click take with NO recording running?
  const measure = async (label) => {
    const samples = [];
    for (let index = 0; index < 6; index += 1) {
      const row = 100 + index * 60;
      const took = await page.evaluate((rowIndex) => {
        const button = document.querySelectorAll("tbody tr")[rowIndex]
          .querySelector("button");
        const started = performance.now();
        button.click();                 // synchronous: capture runs inline
        return performance.now() - started;
      }, row);
      samples.push(took);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const worst = samples[samples.length - 1];
    console.log(`  ${label}: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    return { median, worst };
  };

  const baseline = await measure("no recording ");

  const tabId = await browser.serviceWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);
  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("recording", async () =>
    (await readRecordingState(browser.serviceWorker))?.status === "recording");
  await page.bringToFront();
  await page.waitForTimeout(400);

  const recording = await measure("while recording");

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  await waitFor("done", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording";
  }, 45000);

  const overhead = recording.median - baseline.median;
  console.log(`  capture overhead per click: ${overhead.toFixed(1)} ms`);

  // 100 ms is the threshold at which an interaction stops feeling instant.
  // Capture runs before the application's own handler, so anything above this
  // is a lag the tester notices - on exactly the large enterprise pages this
  // extension was built for.
  assert.ok(recording.median < 100,
    `a click took ${recording.median.toFixed(0)} ms with capture running on a `
    + `${elementCount}-element page. Capture runs synchronously ahead of the `
    + `application's own handler, so this is felt as lag.`);

  assert.ok(recording.worst < 250,
    `worst-case click was ${recording.worst.toFixed(0)} ms`);

  await page.close();
});
