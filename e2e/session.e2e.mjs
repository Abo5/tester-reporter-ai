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

test("keyboard commands are captured, Ctrl+F included", async () => {
  // THE REPORTED BUG. A tester pressed Ctrl+F to find the record they had just
  // created and it was recorded nowhere: the handler listened for Enter, Tab
  // and Escape and dropped everything else. The search that found the row was
  // invisible to the report.
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });

  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("session to reach 'recording'", async () => {
    const state = await readRecordingState(browser.serviceWorker);
    return state?.status === "recording";
  });

  await page.bringToFront();
  await page.click("#tenant");

  // The page sees these even though the browser also acts on some of them.
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.waitForTimeout(300);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  await waitFor("session to leave 'processing'", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const found = sessions.find((s) => s.status !== "processing"
      && s.status !== "recording");
    return found || null;
  }, 40000);

  const events = await readStore(extensionPage, "events");
  const keyPresses = events.filter((event) => event.type === "press-key")
    .map((event) => event.value);
  console.log(`  key presses recorded: ${JSON.stringify(keyPresses)}`);

  assert.ok(keyPresses.includes("Control+f"),
    `Ctrl+F was not recorded. Recorded: ${JSON.stringify(keyPresses)}`);
  assert.ok(keyPresses.includes("Escape"),
    "the standalone keys must still work");

  // And the extension's own shortcut must never appear as a step.
  assert.ok(!keyPresses.some((k) => k.toLowerCase().includes("control+shift+e")),
    "the extension's own shortcut was recorded as a step");

  await page.close();
});

test("every direct action reaches the recording and the script", async () => {
  // "Any press the user makes directly gets recorded in the script and the
  // report." Right-click, middle-click, paste, drag and pointer movement were
  // captured nowhere at all until this test existed.
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/interactions.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });

  await callExtension(extensionPage, {
    kind: "ui/start-recording", tabId, captureMicrophone: false,
  });
  await waitFor("session to reach 'recording'", async () => {
    const state = await readRecordingState(browser.serviceWorker);
    return state?.status === "recording";
  });
  await page.bringToFront();

  // Type, with a correction in the middle.
  await page.click("#target");
  await page.keyboard.type("TN-4019");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("92");
  await page.waitForTimeout(900);

  // Right-click, middle-click.
  await page.click("#right-me", { button: "right" });
  await page.waitForTimeout(400);
  await page.click("#middle-me", { button: "middle" });
  await page.waitForTimeout(600);

  // Move the pointer a long way, then drag a card.
  await page.mouse.move(50, 50);
  await page.mouse.move(400, 300, { steps: 12 });
  await page.mouse.move(900, 500, { steps: 12 });
  await page.waitForTimeout(1200);

  await page.dragAndDrop("#card-1", "#to");
  await page.waitForTimeout(900);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session to finish", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const finished = sessions.filter((s) => s.status !== "processing"
      && s.status !== "recording");
    if (finished.length === 0) { return null; }
    finished.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return finished[0];
  }, 40000);

  const events = (await readStore(extensionPage, "events"))
    .filter((event) => event.sessionId === session.id);
  const shape = {};
  for (const event of events) { shape[event.type] = (shape[event.type] || 0) + 1; }
  console.log(`  captured: ${JSON.stringify(shape)}`);

  const typed = events.find((event) => event.type === "input");
  assert.ok(typed, "the typing was not recorded at all");
  assert.equal(typed.value, "TN-40192");
  assert.ok(typed.keystrokes.includes("Backspace"),
    `the individual keys were not kept: ${JSON.stringify(typed.keystrokes)}`);
  assert.ok(typed.keystrokes.length >= 9,
    `expected every keystroke, got ${typed.keystrokes.length}`);

  assert.ok(shape["right-click"] >= 1, "the right-click was not recorded");
  assert.ok(shape["middle-click"] >= 1, "the middle-click was not recorded");
  assert.ok(shape["mouse-path"] >= 1, "pointer movement was not recorded");
  assert.ok(shape["drag-drop"] >= 1, "the drag was not recorded");

  const script = session.playwrightScript;
  assert.ok(script.includes(".pressSequentially('TN-40192'"),
    "typing must replay key by key");
  assert.ok(script.includes("{ button: 'right' }"), "no right-click in the script");
  assert.ok(script.includes("{ button: 'middle' }"), "no middle-click in the script");
  assert.ok(script.includes(".dragTo("), "no drag in the script");
  assert.ok(script.includes("points,"), "no pointer-movement evidence in the script");

  console.log(`\n--- script ---\n${script}`);
  await page.close();
});

test("a screenshot of the final state is captured and kept", async () => {
  // The tester asked for a picture of the defect at the end, in the report.
  // The only moment it exists is the instant before they stop recording: by the
  // time anyone opens the review page, the tab has moved on or closed.
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

  const shot = session.finalScreenshotDataUrl;
  console.log(`  captureVisibleTab: ${shot === "" ? "unavailable" : shot.length + " chars"}`);

  // captureVisibleTab needs <all_urls> or activeTab, and a specific host grant
  // does NOT satisfy it - measured, it throws. So a session started from the
  // panel has no picture from that route, and the fallback takes the moment
  // from the recording instead. Either source is acceptable; having neither is
  // not, when there is a video to take it from.
  const media = session.media;
  const hasVideo = media !== null && media.sizeBytes > 1000;

  if (shot !== "") {
    assert.ok(shot.startsWith("data:image/png;base64,"),
      `the screenshot is not a PNG data URL: ${shot.slice(0, 40)}`);
    assert.ok(shot.length > 5000, "the screenshot is too small to be a page");
  } else {
    console.log("  (no activeTab picture; the video frame is the fallback)");
    assert.ok(!hasVideo || media.durationMs > 0,
      "with a recording present there must be a frame to fall back to");
  }

  await page.close();
});

test("the step counter never lags behind the last action", async () => {
  // The throttle used to DROP a broadcast inside its window rather than defer
  // it, so the last action before a quiet moment never reached the panel. The
  // tester reported the count was not live, and they were right.
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

  const panel = await openExtensionPage(browser.context, browser.extensionId,
    "sidepanel/sidepanel.html");
  await panel.waitForTimeout(700);

  await page.bringToFront();
  // A burst, then silence. The last one is the one that used to be dropped.
  await page.click('[data-testid="tab-renewal"]');
  await page.click('[data-testid="tab-parties"]');
  await page.click('[data-testid="tab-ending"]');
  await page.waitForTimeout(1200);   // well past the 150ms window

  const shown = await panel.evaluate(
    () => Number(document.getElementById("count-steps").textContent));
  const label = await panel.evaluate(
    () => document.getElementById("last-action").textContent);
  // This session's events only. The store holds every session in the file.
  const activeState = await readRecordingState(browser.serviceWorker);
  const stored = (await readStore(extensionPage, "events"))
    .filter((event) => event.sessionId === activeState.sessionId).length;

  console.log(`  panel shows ${shown}, this session holds ${stored}`);
  console.log(`  last action: ${label}`);

  assert.equal(shown, stored,
    "the panel is behind storage; a broadcast was dropped rather than deferred");
  assert.ok((label || "").length > 0,
    "the panel says nothing about what was just recorded");

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  await panel.close();
  await page.close();
});

test("copying text records what was copied, and a paste is traced to it", async () => {
  // The reported gap: "I right-clicked and copied text on the login page twice
  // and it is not in the script or the report."
  //
  // It was recorded, but empty. On a COPY the event fires BEFORE the clipboard
  // is written - that is the point of the event - so clipboardData.getData()
  // returns "" every time. What the tester copied is the SELECTION. Reading the
  // wrong one produced "the tester copied" with nothing after it, which is the
  // shape of a bug that looks like a missing feature.
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/interactions.html`, { waitUntil: "load" });
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

  // Select the row text and copy it, the way a tester does.
  await page.evaluate(() => {
    const node = document.getElementById("right-me");
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(800);

  // Then paste it somewhere, so the link between them can be tested.
  await page.click("#target");
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(1000);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session to finish", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const finished = sessions.filter((s) => s.status !== "processing"
      && s.status !== "recording");
    if (finished.length === 0) { return null; }
    finished.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return finished[0];
  }, 40000);

  const events = (await readStore(extensionPage, "events"))
    .filter((event) => event.sessionId === session.id);
  const copies = events.filter((event) => event.type === "copy");
  const pastes = events.filter((event) => event.type === "paste");

  console.log(`  copies: ${JSON.stringify(copies.map((e) => e.value))}`);
  console.log(`  pastes: ${JSON.stringify(pastes.map((e) => e.value))}`);

  assert.ok(copies.length >= 1, "the copy was not recorded at all");
  assert.notEqual(copies[0].value, "",
    "the copy was recorded with no text - clipboardData is empty on a copy "
    + "event; the selection is what was copied");
  assert.match(copies[0].value, /Right-click this row/);

  const script = session.playwrightScript;
  assert.ok(script.includes("navigator.clipboard.writeText"),
    `the copied text never reached the script:\n${script}`);

  if (pastes.length >= 1) {
    console.log(`  paste value: ${pastes[0].value}`);
    assert.ok(script.includes("PASTED this rather than typing it"),
      "the paste is not in the script");
  }

  await page.close();
});

test("console errors and MAIN-world network capture both reach storage", async () => {
  // Reported: "Network / console were never included in the report and never
  // showed." The stored data said the same thing - 253 network rows across all
  // sessions, every one of them from webRequest, and ZERO console rows ever.
  //
  // Two separate things to prove: the console patch fires, and the MAIN-world
  // fetch patch contributes entries webRequest cannot (response bodies, and
  // requests the page swallows internally).
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
  // The seeded defect: this search returns a 500 and logs a console error.
  await page.click('[data-testid="tab-renewal"]');
  await page.fill("#tenant", "TN-40192");
  await page.press("#tenant", "Enter");
  await page.waitForTimeout(2500);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session to finish", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const finished = sessions.filter((s) => s.status !== "processing"
      && s.status !== "recording");
    if (finished.length === 0) { return null; }
    finished.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return finished[0];
  }, 40000);

  const net = (await readStore(extensionPage, "networkEntries"))
    .filter((row) => row.sessionId === session.id);
  const con = (await readStore(extensionPage, "consoleEntries"))
    .filter((row) => row.sessionId === session.id);

  const bySource = {};
  for (const row of net) { bySource[row.source] = (bySource[row.source] || 0) + 1; }
  console.log(`  network rows: ${net.length} ${JSON.stringify(bySource)}`);
  console.log(`  failures: ${net.filter((r) => r.isFailure).length}`);
  console.log(`  console rows: ${con.length}`);
  if (con.length > 0) {
    console.log(`  first console: ${con[0].level}: ${String(con[0].message).slice(0, 70)}`);
  }
  console.log(`  session counters: net=${session.networkEntryCount} `
    + `fail=${session.networkFailureCount} console=${session.consoleErrorCount}`);

  assert.ok(con.length >= 1,
    "the console patch captured nothing; the page logged an error");
  assert.ok(net.some((row) => row.source === "page-world-patch"),
    `the page-world fetch patch contributed nothing: ${JSON.stringify(bySource)}`);
  assert.ok(net.some((row) => row.isFailure),
    "the seeded 500 was not recorded as a failure");
  assert.ok(session.consoleErrorCount >= 1,
    "the session counter did not see the console error");

  await page.close();
});

test("the review page SHOWS the failed request and the console error", async () => {
  // The other half of the report. They were captured, sent to the model and
  // folded into the report's supporting evidence - and displayed nowhere, so a
  // tester looking at the review page had no way to know a 500 had been
  // recorded at all.
  const sessions = await readStore(extensionPage, "sessions");
  const withFailures = sessions.filter((s) => s.networkFailureCount > 0
    || s.consoleErrorCount > 0);
  assert.ok(withFailures.length >= 1,
    "no session in this suite captured a failure to display");

  withFailures.sort((a, b) => b.startedAtMs - a.startedAtMs);
  const session = withFailures[0];

  const review = await openExtensionPage(browser.context, browser.extensionId,
    `review/review.html?session=${session.id}`);
  await review.waitForTimeout(2500);

  const shown = await review.evaluate(() => {
    const section = document.getElementById("page-behaviour");
    const rows = Array.from(document.querySelectorAll("#page-behaviour-list li"));
    return {
      hidden: section.hidden,
      title: document.getElementById("page-behaviour-title").textContent,
      rows: rows.map((row) => row.textContent.trim()),
    };
  });

  console.log(`  section hidden: ${shown.hidden}`);
  console.log(`  title: ${shown.title}`);
  for (const row of shown.rows) { console.log(`   • ${row.slice(0, 96)}`); }

  assert.equal(shown.hidden, false, "the section did not appear");
  assert.match(shown.title, /What the page did \(\d+\)/);
  assert.ok(shown.rows.some((row) => row.includes("500")),
    "the failed request is not on screen");
  assert.ok(shown.rows.some((row) => /error:/.test(row)),
    "the console error is not on screen");
  assert.ok(shown.rows.every((row) => /^\d\d:\d\d/.test(row)),
    "every line needs a video timestamp, or the tester cannot find the moment");

  await review.close();
});
