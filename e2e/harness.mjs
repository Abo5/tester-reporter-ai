// =============================================================================
// e2e/harness.mjs
// Launches a REAL Chromium with the built extension loaded, and gives the tests
// a handle on the service worker so they can drive a recording session exactly
// the way the side panel does.
//
// MV3 extensions do not load in headless Chromium, so these tests run headed.
// On a machine with no display, run them under Xvfb (see npm run test:e2e).
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const EXTENSION_DIR = path.resolve(import.meta.dirname, "..", "dist");

/**
 * Launches Chromium with the extension and waits for its service worker.
 * Returns { context, serviceWorker, extensionId, close }.
 */
export async function launchWithExtension(options = {}) {
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error("dist/ is not built. Run `npm run build` first.");
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-e2e-"));

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      // Force the X11 backend. On a Wayland desktop Chromium may pick the
      // Wayland ozone platform and ignore DISPLAY entirely, which leaves no
      // X11 window for xdotool to focus - and therefore no way to deliver a
      // real browser-level keyboard shortcut.
      "--ozone-platform=x11",
      // Give the browser a real window.
      //
      // Without an explicit size the window came up 10x10 pixels under
      // XWayland, which is a rendering surface of essentially nothing - and
      // tabCapture aborts when there is no surface to capture. That was the
      // real cause of "AbortError: Error starting tab capture", not the absence
      // of a GPU.
      "--window-size=1280,900",
      "--window-position=0,0",
      // Grant getUserMedia without a prompt so the microphone path can run on a
      // machine with no hardware.
      //
      // NOTE: --use-fake-device-for-media-stream is deliberately NOT set here.
      // It substitutes a synthetic camera/microphone, and it also interferes
      // with tabCapture's chromeMediaSource:"tab" constraint, which resolves to
      // a NotFoundError when a fake device is in play.
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",

      ...(options.extraArgs ?? []),
    ],
    // viewport: null means "use the real window", instead of overriding the
    // renderer's metrics via CDP. With an override the renderer reports
    // 1280x860 while the actual OS window stays 10x10 - and tabCapture
    // captures the real surface, not the emulated one.
    viewport: null,
    ...options.contextOptions,
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 30000 });
  }

  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    serviceWorker,
    extensionId,
    profileDir,
    async close() {
      await context.close().catch(() => {});
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

/**
 * Sends a message to the extension exactly as the side panel does.
 *
 * IMPORTANT: this must run from an EXTENSION PAGE, not from the service worker.
 * chrome.runtime.sendMessage never delivers to the context that sent it, so a
 * message posted from inside the worker would never reach the worker's own
 * router. Posting from an extension page is precisely what the side panel, the
 * options page and the review page all do, so this exercises the shipped
 * routing rather than a test-only back door.
 */
export async function callExtension(extensionPage, message) {
  return await extensionPage.evaluate(async (msg) => {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (reply) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message });
          return;
        }
        resolve(reply ?? null);
      });
    });
  }, message);
}

/** Reads the extension's session-scoped recording state. */
export async function readRecordingState(serviceWorker) {
  const stored = await serviceWorker.evaluate(
    () => chrome.storage.session.get("activeRecordingState"));
  return stored.activeRecordingState ?? null;
}

/** Reads the whole IndexedDB store from inside an extension page. */
export async function readStore(page, storeName) {
  return await page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("tester-reporter-ai");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains(name)) {
      return [];
    }
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }, storeName);
}

/** Opens an extension page (options/review/sidepanel) as a normal tab. */
export async function openExtensionPage(context, extensionId, relativePath) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relativePath}`);
  return page;
}

/** Polls until the predicate returns truthy, or throws after timeoutMs. */
export async function waitFor(description, predicate, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${description} (last value: ${JSON.stringify(lastValue)})`);
}

/**
 * Sends a REAL keyboard shortcut to the browser window via the X server.
 *
 * WHY not page.keyboard.press(): Playwright dispatches key events into the
 * RENDERER through CDP, so the page sees them but the browser never does.
 * Extension commands are handled by the browser, not the page, which makes
 * them unreachable that way - and the extension command is the only thing a
 * harness can use to grant the activeTab permission tabCapture requires.
 *
 * xdotool injects at the X level, so the event travels the same path a real
 * keypress does. Three things all have to be true for it to work, which is why
 * this returns false rather than throwing:
 *   - a window manager is running (no _NET_ACTIVE_WINDOW without one);
 *   - Chromium is on the X11 backend, not Wayland (see --ozone-platform above);
 *   - xdotool is installed.
 * Callers skip honestly when it returns false rather than reporting coverage
 * they do not have.
 */
export async function sendBrowserShortcut(keys) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  // Find the REAL browser window, not one of Chromium's helpers.
  //
  // Chromium creates several X windows: a 10x10 "chrome" window and a 10x10
  // "Chromium clipboard" window alongside the actual browser. Searching by
  // class matched a helper, so the shortcut was being activated against a
  // window with no tabs in it. The real one is identifiable by size: it is the
  // only one big enough to hold a page.
  const windowId = await findBrowserWindowId(run);
  if (windowId === "") {
    return false;
  }

  try {
    await run("xdotool", ["windowactivate", "--sync", windowId]);
    await new Promise((r) => setTimeout(r, 600));

    // Deliberately WITHOUT --window. That flag makes xdotool use XSendEvent,
    // and Chromium - like most X clients - ignores synthetic events delivered
    // that way. Without it xdotool uses the XTEST extension, which produces a
    // real input event indistinguishable from a physical keypress. That
    // distinction is the whole difference between this working and not.
    await run("xdotool", ["key", "--clearmodifiers", keys]);
    return true;
  } catch (sendError) {
    return false;
  }
}

/**
 * Returns the X window id of the actual browser window, or "".
 *
 * Chromium puts several windows on the display - a 10x10 "chrome" helper and a
 * 10x10 clipboard window among them - and only one of them is the browser.
 * Picking by geometry is the reliable discriminator: the browser window is the
 * only one large enough to render a page into.
 */
async function findBrowserWindowId(run) {
  let ids = [];
  try {
    const { stdout } = await run("xdotool", ["search", "--name", "."]);
    ids = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (searchError) {
    return "";
  }

  let bestId = "";
  let bestArea = 0;

  for (const id of ids) {
    try {
      const { stdout } = await run("xdotool", ["getwindowgeometry", id]);
      const match = /Geometry:\s*(\d+)x(\d+)/.exec(stdout);
      if (match === null) {
        continue;
      }
      const area = Number(match[1]) * Number(match[2]);
      if (area > bestArea) {
        bestArea = area;
        bestId = id;
      }
    } catch (geometryError) {
      // Window vanished between listing and querying; skip it.
    }
  }

  // A browser window is at least a few hundred pixels on a side. Anything
  // smaller is a helper, and activating it would send the shortcut nowhere.
  return bestArea > 200 * 200 ? bestId : "";
}
