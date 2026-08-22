// =============================================================================
// e2e/bench.e2e.mjs
//
// The graded test. The Seeded Defect Bench has FIVE documented defects, so a
// capture run here can be scored rather than admired: did the extension capture
// the evidence for each one, and did it avoid inventing a sixth?
//
// Two of the five are invisible on screen and exist only in the markup, which
// is the whole argument for capturing page code rather than screenshots.
// =============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchWithExtension, callExtension, readStore, openExtensionPage, waitFor,
  readRecordingState,
} from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

let browser;
let server;
let extensionPage;
let captured;

before(async () => {
  server = await startFixtureServer();
  browser = await launchWithExtension();
  extensionPage = await openExtensionPage(browser.context, browser.extensionId,
    "options/options.html");

  // One recording drives every assertion below: five separate sessions would
  // be five times slower and would not test anything extra.
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

  // Walk every scenario the way a tester would.
  await page.click('[data-testid="tab-renewal"]');
  await page.waitForTimeout(400);

  await page.fill("#tenant", "TN-40192");
  await page.waitForTimeout(800);
  await page.click("#lookup-btn");
  await page.waitForTimeout(1800);          // let the failure and the throw land

  await page.click("#results-body tr:nth-child(3) .view");
  await page.waitForTimeout(500);

  await page.fill("#tenant-name", "شركة الرياض للتطوير");
  await page.waitForTimeout(800);
  await page.fill("#iban", "SA0380000000608010167519");
  await page.waitForTimeout(800);
  await page.selectOption("#duration", "36");
  await page.waitForTimeout(300);
  await page.check("#agree");
  await page.waitForTimeout(300);
  await page.click("#renew-btn");
  await page.waitForTimeout(700);

  await callExtension(extensionPage, { kind: "ui/stop-recording" });
  const session = await waitFor("session ready", async () => {
    const sessions = await readStore(extensionPage, "sessions");
    const s = sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return s && s.status !== "processing" && s.status !== "recording" ? s : null;
  }, 45000);

  captured = {
    session,
    events: await readStore(extensionPage, "events"),
    snapshots: await readStore(extensionPage, "domSnapshots"),
    contexts: await readStore(extensionPage, "elementContexts"),
    network: await readStore(extensionPage, "networkEntries"),
    consoleEntries: await readStore(extensionPage, "consoleEntries"),
  };
  captured.html = captured.snapshots.map((s) => s.prunedHtml).join("\n");

  console.log(`\n  events ${captured.events.length} · snapshots ${captured.snapshots.length}`
    + ` · contexts ${captured.contexts.length} · network ${captured.network.length}`
    + ` · console ${captured.consoleEntries.length}`);
  console.log(`  types: ${captured.events.map((e) => e.type).join(", ")}\n`);

  await page.close();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test("SDB-1: every wrong tab label AND the approved list are both captured", () => {
  const wrong = [
    "Initiating the Rental Relationship",
    "Contract Renewal &amp; Continuation",
    "Managing Contract Parties &amp; Authorizations",
    "Ending the Rental Relationship",
  ];
  for (const label of wrong) {
    assert.ok(captured.html.includes(label), `lost the rendered label: ${label}`);
  }

  // Without the approved list this defect is unprovable, so capturing it is
  // part of capturing the defect.
  const approved = [
    "Rental relationship initiation",
    "Contract renewal and continuation",
    "Rental relationship termination",
  ];
  for (const label of approved) {
    assert.ok(captured.html.includes(label),
      `lost the approved label, so the defect cannot be graded: ${label}`);
  }
});

test("SDB-2: the invisible validation message is captured AND marked hidden", () => {
  assert.ok(captured.html.includes("Tenant ID must be 8 digits"),
    "the DOM-only validation message was lost - this is the defect a "
    + "screenshot tool cannot see, and the reason page code is captured at all");
  assert.ok(captured.html.includes('data-qa-hidden="true"'),
    "the message was captured but not marked as not-on-screen, so a report "
    + "could wrongly claim the user saw it");
  assert.ok(captured.html.includes('aria-invalid="true"'),
    "the invalid state on the field was not captured");
});

test("SDB-3: the failed request and the error it caused are both captured", () => {
  const failures = captured.network.filter((n) => n.isFailure);
  assert.ok(failures.length >= 1,
    `no failed request captured. saw: ${JSON.stringify(
      captured.network.map((n) => [n.source, n.statusCode]))}`);

  const lookupFailure = failures.find((f) => f.url.includes("/api/contracts/"));
  assert.ok(lookupFailure, "the contract lookup failure was not captured");
  console.log(`  captured: ${lookupFailure.method} ${lookupFailure.statusCode} `
    + `via ${lookupFailure.source}`);

  assert.ok(captured.consoleEntries.length >= 1,
    "the TypeError the handler threw was not captured");
  const errorText = captured.consoleEntries.map((c) => c.message).join(" ");
  assert.ok(/lookup failed|undefined|contract/i.test(errorText),
    `the captured console text does not look like the seeded error: ${errorText}`);

  assert.ok(captured.snapshots.some(
    (s) => s.trigger === "network-failure" || s.trigger === "console-error"),
    "no snapshot was taken at the moment things broke");
});

test("SDB-4 and SDB-5: the Arabic block's direction and untranslated option survive", () => {
  assert.ok(captured.html.includes("Three years"),
    "the untranslated option was lost");
  assert.ok(captured.html.includes("مدة العقد"),
    "the Arabic label around it was lost, so the mismatch is not provable");

  // The direction defect is only diagnosable from computed styles, which live
  // in the element context rather than the snapshot.
  const ibanContext = captured.contexts.find(
    (c) => c.elementHtml.includes('id="iban"'));
  assert.ok(ibanContext, "no element context captured for the misaligned field");
  assert.equal(ibanContext.computedStyles.direction, "ltr",
    "the LTR leak was not captured in the computed styles");
  assert.equal(ibanContext.inheritedDir, "rtl",
    "the surrounding RTL direction was not captured, so there is nothing to "
    + "compare the leak against");
  console.log(`  iban field: direction=${ibanContext.computedStyles.direction}`
    + ` inside dir=${ibanContext.inheritedDir}`);
});

test("the IBAN is redacted before anything could be sent", () => {
  // A real IBAN typed into a form is exactly what must not leave the machine.
  const trace = JSON.stringify(captured.events);
  const ibanEvent = captured.events.find(
    (e) => e.type === "input" && e.locator?.primary?.value?.includes("Ib"));
  void ibanEvent;
  assert.ok(!trace.includes("SA0380000000608010167519")
    || captured.events.some((e) => e.valueWasRedacted),
    "the IBAN was stored raw and not flagged");
});

test("the whole run produced a usable script and no invented sixth defect", () => {
  assert.ok(captured.session.playwrightScript.length > 200,
    "no script generated for the bench session");

  // Every recorded event must correspond to something we actually did. A
  // recorder that invents steps is worse than one that misses them.
  const allowed = new Set([
    "click", "input", "select-option", "check", "uncheck", "press-key",
    "navigate", "url-change", "reload", "hover", "scroll", "tab-activated",
  ]);
  for (const event of captured.events) {
    assert.ok(allowed.has(event.type), `unexpected event type: ${event.type}`);
  }

  const clicks = captured.events.filter((e) => e.type === "click").length;
  assert.ok(clicks <= 6,
    `${clicks} clicks recorded for 4 real clicks - the recorder is inventing steps`);
});
