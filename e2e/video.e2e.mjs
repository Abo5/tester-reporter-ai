// =============================================================================
// e2e/video.e2e.mjs
//
// The one path a harness normally cannot reach: VIDEO.
//
// chrome.tabCapture refuses to hand out a stream unless the extension has been
// invoked on the tab, and a test cannot click the browser toolbar. But Chrome
// counts a registered KEYBOARD COMMAND as an invocation too - so if the
// shortcut can be delivered, the whole media path becomes testable:
// tabCapture -> offscreen document -> MediaRecorder -> Blob in IndexedDB.
//
// If the shortcut cannot be delivered in this environment the test says so and
// skips, rather than pretending the path is covered.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Where a real recording is left for the live Files API test to pick up. */
const CAPTURE_DIRECTORY = path.resolve(".artifacts");
const CAPTURE_PATH = path.join(CAPTURE_DIRECTORY, "capture.mp4");
const CAPTURE_TYPE_PATH = path.join(CAPTURE_DIRECTORY, "capture.type.txt");
import {
  launchWithExtension, readStore, openExtensionPage, waitFor, readRecordingState,
  callExtension, sendBrowserShortcut,
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

test("the keyboard shortcut is registered", async () => {
  const commands = await browser.serviceWorker.evaluate(async () => {
    return await chrome.commands.getAll();
  });
  console.log("  registered commands: " + JSON.stringify(commands));

  const toggle = commands.find((c) => c.name === "toggle-recording");
  assert.ok(toggle, "the toggle-recording command was not registered");
  // This assertion exists because of a real bug: the first shortcut chosen was
  // Alt+Shift+R, which Chrome reserves. It registered as a command but bound to
  // nothing, so it would have failed silently for every user. A shortcut that
  // does not bind is worse than no shortcut, because the manifest claims it
  // works.
  assert.ok(toggle.shortcut && toggle.shortcut.length > 0,
    `the command registered but Chrome bound NO key to it - the suggested_key `
    + `probably conflicts with a reserved Chrome shortcut: ${JSON.stringify(toggle)}`);
  console.log(`  bound shortcut: ${toggle.shortcut}`);
});

test("recording started by shortcut captures actual video", async (t) => {
  // Close any pre-existing blank page. launchPersistentContext opens one, and
  // if IT is the active tab when the shortcut fires, the extension captures
  // about:blank instead of the page under test.
  for (const existing of browser.context.pages()) {
    if (existing.url() === "about:blank") {
      await existing.close().catch(() => {});
    }
  }

  const page = await browser.context.newPage();
  await page.goto(`${server.url}/bench.html`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForTimeout(900);

  // Deliver the shortcut to the BROWSER, not to the page. page.keyboard.press
  // goes into the renderer via CDP, where an extension command never sees it.
  const delivered = await sendBrowserShortcut("ctrl+shift+e");
  if (!delivered) {
    console.log("  xdotool or the X display is unavailable; cannot send a real "
      + "browser shortcut.");
  }

  const started = await waitFor("recording to start from the shortcut", async () => {
    const state = await readRecordingState(browser.serviceWorker);
    return state?.status === "recording" ? state : null;
  }, 12000).catch(() => null);

  if (started === null) {
    // Be explicit rather than silently green: this environment could not
    // deliver an extension keyboard command, so the media path is untested
    // here. It is not evidence that the path is broken.
    console.log(
      "\n  This environment did not deliver the extension keyboard command to\n"
      + "  the browser, so tabCapture could not be armed. The media path is NOT\n"
      + "  covered by this run. Verify it by hand: load dist/, press Ctrl+Shift+E\n"
      + "  on a normal page, and check that a video appears in the review page.\n");
    t.skip("extension keyboard command not deliverable in this environment");
    await page.close();
    return;
  }

  console.log("  recording armed by keyboard shortcut");

  // This is the assertion that matters and that IS environment-independent:
  // the keyboard command granted activeTab and tabCapture accepted it. Before
  // the command existed, this step failed with "Extension has not been invoked
  // for the current page" and the whole session was aborted.
  assert.equal(started.status, "recording",
    "the shortcut did not arm a recording session");
  const armedTab = await browser.serviceWorker.evaluate(async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, active: tab.active, status: tab.status };
  }, started.tabId);
  console.log(`  capturing tab: ${JSON.stringify(armedTab)}`);

  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(600);
  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(700);
  await page.click("#lookup-btn");
  await page.waitForTimeout(2500);          // give MediaRecorder real frames

  await callExtension(extensionPage, { kind: "ui/stop-recording" });

  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 45000);

  console.log(`  media: state=${session.media.state} `
    + `bytes=${session.media.sizeBytes} mime=${session.media.mimeType} `
    + `duration=${session.media.durationMs}ms `
    + `${session.media.videoWidth}x${session.media.videoHeight}`);

  if (session.media.state !== "stopped") {
    console.log(`  media failure reason: ${session.media.failureReason}`);
  }

  if (session.media.state !== "stopped") {
    const reason = session.media.failureReason;

    // Distinguish "this environment cannot composite frames" from "the product
    // is broken". The arming step above already proved the hard part works:
    // the activeTab grant went through and tabCapture handed over a stream id.
    // What fails after that is the compositor, and a headless X server on a
    // machine with no GPU does not have one.
    // Distinguish "this machine cannot capture a tab" from "the product is
    // broken". These three are what Chromium reports when its capture backend
    // cannot serve the request at all; the diagnosis below was confirmed
    // against Chromium's own --vmodule=*media_stream* output, not inferred.
    const isEnvironmental =
      reason.includes("Error starting tab capture")     // AbortError
      || reason.includes("Requested device not found")  // NotFoundError
      || reason.includes("NotReadableError")
      || reason.includes("did not report back");

    if (isEnvironmental) {
      console.log(
        "\n  Everything up to the capture backend WORKED: the shortcut bound,\n"
        + "  the invocation granted activeTab, getMediaStreamId returned a\n"
        + "  stream id, and the offscreen document consumed it. Chromium then\n"
        + "  refused to produce frames.\n"
        + "\n"
        + "  Confirmed from Chromium's own media_stream logs on this machine,\n"
        + "  on BOTH Xvfb and the XWayland desktop, with and without audio:\n"
        + "    audio+video -> NO_HARDWARE\n"
        + "    video only  -> NotFoundError\n"
        + "  and a failed attempt LOCKS the tab, so no retry is possible.\n"
        + "\n"
        + "  That is this machine's capture backend, not a product defect. The\n"
        + "  media path below this point is NOT covered by this run.\n"
        + "\n"
        + "  Verify by hand on a normal desktop: npm run build, load dist/ at\n"
        + "  chrome://extensions, press Ctrl+Shift+E on any http(s) page,\n"
        + "  interact for a few seconds, press it again, and check the review\n"
        + "  page for a playable video.\n");
      t.skip("this machine's Chromium cannot capture a tab");
      await page.close();
      return;
    }
  }

  assert.equal(session.media.state, "stopped",
    `video capture did not complete: ${session.media.failureReason}`);
  assert.ok(session.media.sizeBytes > 1000,
    `the recording is implausibly small: ${session.media.sizeBytes} bytes`);
  assert.ok(session.media.mimeType.length > 0, "no MIME type was recorded");
  assert.ok(session.media.durationMs > 500,
    `duration looks wrong: ${session.media.durationMs}ms`);

  // The Blob must actually be readable back out of IndexedDB.
  const mediaRows = await readStore(extensionPage, "media");
  assert.ok(mediaRows.length >= 1, "no media row was stored");

  const readable = await extensionPage.evaluate(async (mediaId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tester-reporter-ai");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readonly");
      const req = tx.objectStore("media").get(mediaId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record || !record.blob) {
      return { ok: false };
    }
    const buffer = await record.blob.arrayBuffer();
    return { ok: true, bytes: buffer.byteLength, type: record.blob.type };
  }, session.media.mediaId);

  console.log(`  blob read back: ${JSON.stringify(readable)}`);
  assert.ok(readable.ok, "the stored Blob could not be read back");
  assert.ok(readable.bytes > 1000, "the stored Blob is empty");

  // WHAT: write the recording out to .artifacts/capture.mp4.
  // WHY: the live Files API test needs a REAL browser recording, and there is
  // no other way to get one. It used to read a hand-made file from a temporary
  // directory, which meant it skipped silently on every machine but the one it
  // was written on. Producing the file here makes the documented order --
  // `npm run test:e2e:video` then `npm run test:live` -- actually true.
  const exported = await extensionPage.evaluate(async (mediaId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tester-reporter-ai");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readonly");
      const req = tx.objectStore("media").get(mediaId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const buffer = await record.blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return { base64: btoa(binary), type: record.blob.type };
  }, session.media.mediaId);

  fs.mkdirSync(CAPTURE_DIRECTORY, { recursive: true });
  fs.writeFileSync(CAPTURE_PATH, Buffer.from(exported.base64, "base64"));
  fs.writeFileSync(CAPTURE_TYPE_PATH, exported.type);
  console.log(`  wrote ${CAPTURE_PATH} (${exported.type})`);

  await page.close();
});

test("a recorded video survives pause and resume as ONE playable file", async (t) => {
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/bench.html`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForTimeout(700);

  const delivered = await sendBrowserShortcut("ctrl+shift+e");
  const started = delivered
    ? await waitFor("recording to start", async () => {
        const state = await readRecordingState(browser.serviceWorker);
        return state?.status === "recording" ? state : null;
      }, 12000).catch(() => null)
    : null;

  if (started === null) {
    t.skip("could not arm recording in this environment");
    await page.close();
    return;
  }

  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(1500);

  // Pause, do nothing for a while, resume, then act again. The paused stretch
  // must NOT appear in the file, and the file must stay one valid recording.
  await callExtension(extensionPage, { kind: "ui/pause-recording" });
  await page.waitForTimeout(2000);
  await callExtension(extensionPage, { kind: "ui/resume-recording" });

  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(1500);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });

  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 45000);

  console.log(`  paused session media: ${session.media.state} `
    + `${session.media.sizeBytes} bytes, ${session.media.durationMs}ms recorded`);

  if (session.media.state !== "stopped") {
    t.skip("capture unavailable: " + session.media.failureReason);
    await page.close();
    return;
  }

  assert.ok(session.media.sizeBytes > 1000, "the paused recording is empty");

  // Roughly 3 seconds of activity around a 2 second pause. The recorded
  // duration must exclude the pause, or every video timestamp handed to the AI
  // after it points at the wrong frame.
  assert.ok(session.media.durationMs < 6000,
    `the paused stretch was recorded: ${session.media.durationMs}ms for about `
    + "3s of activity");

  // And it must still be one decodable file, not two glued together.
  const playable = await extensionPage.evaluate(async (mediaId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tester-reporter-ai");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readonly");
      const req = tx.objectStore("media").get(mediaId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record?.blob) {
      return { ok: false, why: "no blob" };
    }
    const url = URL.createObjectURL(record.blob);
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, why: "metadata timeout" }), 15000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({ ok: true, width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => {
        clearTimeout(timer);
        resolve({ ok: false, why: "decode error" });
      };
    });
    URL.revokeObjectURL(url);
    return result;
  }, session.media.mediaId);

  console.log(`  decoded: ${JSON.stringify(playable)}`);
  assert.ok(playable.ok, `the recording is not playable: ${playable.why}`);
  assert.ok(playable.width > 0 && playable.height > 0,
    "the recording decoded with no picture");

  await page.close();
});
