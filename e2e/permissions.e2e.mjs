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
  sendBrowserShortcut,
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

test("the ungranted fallback survives a full page navigation", async () => {
  // THE BUG THIS PINS. Recording on a site with no grant injects the content
  // scripts under activeTab, and that injection belongs to one document. The
  // first real session run against a live site recorded ten interactions on the
  // login page and then, after the first navigation, seven bare navigations and
  // not a single click. The generated script was a list of page.goto() calls.
  //
  // Nothing in the suite caught it, because every other test records on one
  // page. This one navigates in the middle, with nothing granted.
  const permissions = await extensionPage.evaluate(
    () => new Promise((resolve) => chrome.permissions.getAll(resolve)));
  assert.deepEqual(permissions.origins, [
    "https://generativelanguage.googleapis.com/*",
  ], "this test is only meaningful with nothing granted");

  const page = await browser.context.newPage();
  await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
  await page.bringToFront();

  const tabId = await browser.serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });

  // Started with the KEYBOARD SHORTCUT, not a message. activeTab - the whole
  // basis of the ungranted fallback - is only granted by a real invocation, so
  // a test that starts recording by posting a message is testing a path no
  // tester can reach.
  const delivered = await sendBrowserShortcut("ctrl+shift+e");
  assert.ok(delivered, "could not deliver the shortcut; is xdotool installed?");
  await waitFor("session to reach 'recording'", async () => {
    const state = await readRecordingState(browser.serviceWorker);
    return state?.status === "recording";
  });

  await page.bringToFront();
  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(400);

  // A REAL navigation, the kind that destroys an injected script.
  await page.goto(`${server.url}/bilingual.html`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.bringToFront();

  // An interaction AFTER the navigation. This is the one that used to vanish.
  const afterNav = page.locator("input, button, a").first();
  await afterNav.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  await sendBrowserShortcut("ctrl+shift+e");
  await waitFor("session to leave 'processing'", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const session = sessions.find((s) => s.status !== "processing"
      && s.status !== "recording");
    return session || null;
  }, 40000);

  const events = await readStore(extensionPage, "events");
  const afterNavigation = events.filter((event) =>
    event.pageUrl.includes("bilingual.html")
    && event.type !== "navigate" && event.type !== "reload");

  const shape = {};
  for (const event of events) { shape[event.type] = (shape[event.type] || 0) + 1; }
  console.log(`  events: ${JSON.stringify(shape)}`);
  console.log(`  interactions after the navigation: ${afterNavigation.length}`);

  assert.ok(afterNavigation.length >= 1,
    "an ungranted session stopped capturing interactions after navigating; "
    + "the activeTab injection was not restored");

  await page.close();
});

test("the side panel warns about an ungranted site, and stops once granted", async () => {
  // THE FIX FOR THE REPORTED PROBLEM. The tester recorded a journey that
  // captured one click and nine navigations and was told nothing about it. The
  // panel now says so BEFORE the recording.
  //
  // The panel is opened as a tab here, so the active-tab query would return the
  // panel itself. Activating the fixture tab afterwards makes it the active tab
  // and fires the panel's own tabs.onActivated listener - which is the real
  // code path, not a simulation of it.
  const permissions = await extensionPage.evaluate(
    () => new Promise((resolve) => chrome.permissions.getAll(resolve)));
  assert.deepEqual(permissions.origins, [
    "https://generativelanguage.googleapis.com/*",
  ], "this test needs to start with nothing granted");

  const panel = await openExtensionPage(browser.context, browser.extensionId,
    "sidepanel/sidepanel.html");
  await panel.waitForTimeout(800);

  const site = await browser.context.newPage();
  await site.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
  await site.bringToFront();
  await panel.waitForTimeout(1500);

  const warningShown = await panel.evaluate(
    () => !document.getElementById("grant-card").hidden);
  const warningText = await panel.evaluate(
    () => document.getElementById("grant-body").textContent);
  console.log(`  warning shown: ${warningShown}`);
  console.log(`  warning text : ${(warningText || "").slice(0, 90)}…`);

  assert.equal(warningShown, true,
    "the panel said nothing about an ungranted site, which is the exact "
    + "failure the tester reported");
  assert.match(warningText, /will not be recorded/,
    "the warning must say what is lost, not merely that something is wrong");

  // Grant it, and the warning must go away by itself - the panel listens for
  // permissions.onAdded, so the tester does not have to reopen anything.
  await grantOriginLikeATester(extensionPage, server.url);
  await site.bringToFront();
  await panel.waitForTimeout(1500);

  const stillShown = await panel.evaluate(
    () => !document.getElementById("grant-card").hidden);
  assert.equal(stillShown, false,
    "the warning stayed up after the site was granted");

  await panel.close();
  await site.close();
});
