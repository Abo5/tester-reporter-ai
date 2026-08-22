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
      // Grant getUserMedia without a prompt, and feed it a synthetic device so
      // the microphone path can be exercised on a machine with no hardware.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      ...(options.extraArgs ?? []),
    ],
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
