// =============================================================================
// e2e/permissions.e2e.mjs
//
// The install prompt is the first thing a tester sees, and for most of this
// project's life it said "Read and change your data on all websites" - because
// <all_urls> was in host_permissions.
//
// Section 13.3 of the plan required it to be optional, and carried a VERIFY
// asking whether a static content_scripts entry with <all_urls> matches forces
// the broad grant anyway. It does. Measured: with the static entries present,
// permissions.getAll() reported both origin patterns as granted on a fresh
// profile; with the same manifest and the entries deleted, it reported only the
// API origin. So the entries are gone and registration happens at run time.
//
// These tests pin the resulting behaviour, because every part of it is
// invisible until something is broken: nobody notices a content script that
// quietly stopped being registered.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, openExtensionPage, callExtension, readStore, waitFor,
  readRecordingState,
  grantOriginLikeATester,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

let browser;
let server;
let extensionPage;

/** The origin pattern Chrome will have granted for the fixture server. */
function fixtureOriginPattern() {
  const parsed = new URL(server.url);
  return parsed.protocol + "//" + parsed.hostname + "/*";
}

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

test("a fresh install holds no page access at all", async () => {
  const permissions = await extensionPage.evaluate(
    () => new Promise((resolve) => chrome.permissions.getAll(resolve)));

  assert.deepEqual(permissions.origins, [
    "https://generativelanguage.googleapis.com/*",
  ], "a fresh install must hold nothing but the API origin");

  const manifest = await browser.serviceWorker.evaluate(
    () => chrome.runtime.getManifest());
  assert.equal(manifest.content_scripts, undefined,
    "a static content_scripts entry forces the broad grant; there must not be one");
  assert.deepEqual(manifest.optional_host_permissions,
    ["http://*/*", "https://*/*"]);
});

test("with nothing granted, no content script is registered", async () => {
  const registered = await browser.serviceWorker.evaluate(
    () => chrome.scripting.getRegisteredContentScripts());
  assert.equal(registered.length, 0,
    "content scripts were registered for origins nobody granted");
});

test("granting a site registers the content scripts for it, and only it", async () => {
  const granted = await grantOriginLikeATester(extensionPage, server.url);
  assert.ok(granted, "the grant flow did not complete; is a window manager running?");

  // The service worker registers on permissions.onAdded, so give it a moment.
  await waitFor("content scripts to be registered", async () => {
    const registered = await browser.serviceWorker.evaluate(
      () => chrome.scripting.getRegisteredContentScripts());
    return registered.length === 2;
  });

  const registered = await browser.serviceWorker.evaluate(
    () => chrome.scripting.getRegisteredContentScripts());

  const ids = registered.map((script) => script.id).sort();
  assert.deepEqual(ids, ["tra-page-world", "tra-recorder"]);

  for (const script of registered) {
    assert.deepEqual(script.matches, [fixtureOriginPattern()],
      "a script matched more than the granted origin");
  }

  const mainWorld = registered.find((s) => s.id === "tra-page-world");
  assert.equal(mainWorld.world, "MAIN");
  assert.equal(mainWorld.runAt, "document_start",
    "the fetch patch has to land before the page makes its first request");
});

test("and then a recording on that site actually captures events", async () => {
  const page = await browser.context.newPage();
  await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });
  assert.ok(tabId > 0, "could not find the active tab");

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
  await page.waitForTimeout(800);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  await waitFor("session to leave 'processing'", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const session = sessions[0];
    return session && session.status !== "processing"
      && session.status !== "recording" ? session : null;
  }, 40000);

  const events = await readStore(extensionPage, "events");
  console.log(`  events captured after granting: ${events.length}`);
  assert.ok(events.length >= 2,
    `granting the origin must make recording work; got ${events.length} events`);

  await page.close();
});

test("revoking the site unregisters the content scripts again", async () => {
  await extensionPage.evaluate((pattern) => new Promise((resolve) =>
    chrome.permissions.remove({ origins: [pattern] }, resolve)),
    fixtureOriginPattern());

  await waitFor("content scripts to be unregistered", async () => {
    const registered = await browser.serviceWorker.evaluate(
      () => chrome.scripting.getRegisteredContentScripts());
    return registered.length === 0;
  });

  const permissions = await extensionPage.evaluate(
    () => new Promise((resolve) => chrome.permissions.getAll(resolve)));
  assert.ok(!(permissions.origins || []).includes(fixtureOriginPattern()),
    "the origin is still granted after revoking it");
});
