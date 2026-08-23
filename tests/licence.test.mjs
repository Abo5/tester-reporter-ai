// =============================================================================
// tests/licence.test.mjs
//
// The 14-day trial.
//
// Read src/shared/licence.ts first. This layer runs on the customer's machine
// and can be bypassed by anyone who wants to; what it CAN do is be correct for
// the honest customer and impossible to extend by accident. These tests hold it
// to that, and no more than that.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../dist-test/test-api.mjs");

const DAY = 24 * 60 * 60 * 1000;
const INSTALLED_AT = Date.parse("2026-08-01T09:00:00.000Z");

/** A trial that started at INSTALLED_AT and has run for `days`. */
function trialAfterDays(days) {
  const state = api.createInitialLicenceState(INSTALLED_AT);
  return api.advanceClock(state, INSTALLED_AT + days * DAY);
}

test("a fresh install has the full fourteen days", () => {
  const state = api.createInitialLicenceState(INSTALLED_AT);
  assert.equal(api.trialDaysRemaining(state), 14);
  assert.equal(api.readLicenceStatus(state), "trial-active");
  assert.equal(api.mayGenerateReport(state), true);
});

test("day 13 still works, day 14 does not", () => {
  // The boundary is where a trial is worth testing: an off-by-one here either
  // gives away a day or cuts a customer off while they still believe they have
  // time, and the second one costs a sale.
  const dayThirteen = trialAfterDays(13);
  assert.equal(api.trialDaysRemaining(dayThirteen), 1);
  assert.equal(api.readLicenceStatus(dayThirteen), "trial-active");
  assert.equal(api.mayGenerateReport(dayThirteen), true);
  assert.match(api.describeLicenceStatus(dayThirteen), /Last day/);

  const dayFourteen = trialAfterDays(14);
  assert.equal(api.trialDaysRemaining(dayFourteen), 0);
  assert.equal(api.readLicenceStatus(dayFourteen), "trial-expired");
  assert.equal(api.mayGenerateReport(dayFourteen), false);
});

test("setting the clock back does not extend the trial", () => {
  // The first thing anyone tries. The trial is measured against the furthest
  // point this installation has ever seen, which cannot go backwards.
  const used = trialAfterDays(14);
  assert.equal(api.readLicenceStatus(used), "trial-expired");

  const rolledBack = api.advanceClock(used, INSTALLED_AT + 2 * DAY);
  assert.equal(api.trialDaysRemaining(rolledBack), 0,
    "winding the clock back must buy nothing");
  assert.equal(api.readLicenceStatus(rolledBack), "trial-expired");
});

test("a verified licence outlives an expired trial", () => {
  const expired = trialAfterDays(30);
  const licensed = {
    ...expired,
    licenceKey: "TRA-XXXX-YYYY-ZZZZ",
    licenceVerifiedAtMs: INSTALLED_AT + 20 * DAY,
  };

  assert.equal(api.readLicenceStatus(licensed), "licensed");
  assert.equal(api.mayGenerateReport(licensed), true);
  assert.match(api.describeLicenceStatus(licensed), /Licensed/);
});

test("a key that was never verified is not a licence", () => {
  const expired = trialAfterDays(30);
  const claimed = { ...expired, licenceKey: "TRA-XXXX-YYYY-ZZZZ", licenceVerifiedAtMs: 0 };

  assert.equal(api.readLicenceStatus(claimed), "licence-invalid");
  assert.equal(api.mayGenerateReport(claimed), false,
    "typing something in the box must not unlock the product");
});

test("the expiry message says what still works", () => {
  // A tester whose trial ends mid-session keeps their recording. Telling them
  // so is the difference between a lapsed trial and a lost customer.
  const message = api.describeLicenceStatus(trialAfterDays(20));
  assert.match(message, /Recording and the Playwright script still work/);
  assert.match(message, /14-day trial/);
});

test("the remaining count is always in front of the customer", () => {
  // Never a silent trial. Every non-final day names the number.
  for (const day of [0, 1, 5, 12]) {
    const message = api.describeLicenceStatus(trialAfterDays(day));
    assert.match(message, /\d+ days left|Last day/,
      `day ${day} did not name the remaining days: ${message}`);
  }
});

test("a state stored by an older version does not reset the trial", () => {
  // The lesson from PLAN.md 19.t, applied before it costs anything: undefined
  // is not 0, and a missing field must not silently hand out a new fortnight.
  const partial = api.normaliseLicenceState(
    { firstRunAtMs: INSTALLED_AT }, INSTALLED_AT + 10 * DAY);

  assert.equal(partial.firstRunAtMs, INSTALLED_AT,
    "the original install date must survive");
  assert.equal(partial.licenceKey, "");
  assert.equal(partial.licenceVerifiedAtMs, 0);
  assert.equal(typeof partial.lastVerificationMessage, "string");
});

test("a corrupted state starts a fresh trial rather than crashing", () => {
  const fresh = api.normaliseLicenceState(null, INSTALLED_AT);
  assert.equal(fresh.firstRunAtMs, INSTALLED_AT);
  assert.equal(api.trialDaysRemaining(fresh), 14);
});

test("the shape test rejects an empty box and a pasted sentence", () => {
  // It cannot tell a real key from an invented one and does not claim to. Its
  // only job is to stop obvious nonsense reaching a server that is not there.
  assert.equal(api.looksLikeALicenceKey(""), false);
  assert.equal(api.looksLikeALicenceKey("short"), false);
  assert.equal(api.looksLikeALicenceKey("please let me in"), false);
  assert.equal(api.looksLikeALicenceKey("TRA-4F2A-9C31-88BE"), true);
});

// -----------------------------------------------------------------------------
// Where the credential comes from
//
// The tester supplies no key. The build either proxies through a server or
// carries one, and which it is decides whether the key is published.
// -----------------------------------------------------------------------------

test("an unconfigured build says so rather than failing mysteriously", () => {
  // Both constants are empty in the repository, deliberately: a key committed
  // here would be a key on GitHub.
  assert.equal(api.readCredentialMode(), "unconfigured");
});

test("with no proxy the request goes to Gemini with the key header", () => {
  const url = api.buildEndpointUrl("gemini-3.5-flash");
  assert.match(url, /generativelanguage\.googleapis\.com/);
  assert.match(url, /models\/gemini-3\.5-flash:generateContent$/);

  const headers = api.buildRequestHeaders("AIza-example");
  assert.equal(headers["x-goog-api-key"], "AIza-example");
});

// -----------------------------------------------------------------------------
// Licensed-only surfaces
// -----------------------------------------------------------------------------

test("the Actions list describes every event type it may be given", () => {
  // The raw record. Its value is that nothing was filtered, so an event type it
  // does not know would show as a bare slug in the middle of readable lines.
  const base = {
    index: 0, sessionId: "s", wallClockMs: 0, videoOffsetMs: 0,
    pageUrl: "https://x.test/", pageTitle: "", tabId: 1, frameId: 0,
    locator: null, value: "", valueWasRedacted: false, clientX: -1, clientY: -1,
    domSnapshotId: "", elementContextId: "", keystrokes: [],
    dropTargetLocator: null,
  };

  assert.match(api.describeActionLine({ ...base, type: "mouse-path", value: "1,1 2,2 3,3" }),
    /moved the pointer \(3 points\)/);
  assert.match(api.describeActionLine({ ...base, type: "input", value: "Admin" }),
    /typed "Admin"/);
  assert.match(api.describeActionLine({ ...base, type: "copy", value: "TN-40192" }),
    /copy "TN-40192"/);
  assert.match(api.describeActionLine({ ...base, type: "press-key", value: "Control+f" }),
    /pressed Control\+f/);
  assert.match(api.describeActionLine({ ...base, type: "navigate", pageUrl: "https://x.test/y" }),
    /went to https:\/\/x\.test\/y/);
});

test("a hidden value stays hidden in the Actions list", () => {
  const line = api.describeActionLine({
    index: 0, sessionId: "s", type: "input", wallClockMs: 0, videoOffsetMs: 0,
    pageUrl: "", pageTitle: "", tabId: 1, frameId: 0, locator: null,
    value: "[REDACTED:password]", valueWasRedacted: true, clientX: -1,
    clientY: -1, domSnapshotId: "", elementContextId: "", keystrokes: [],
    dropTargetLocator: null,
  });

  assert.match(line, /a hidden value/);
  assert.ok(!line.includes("REDACTED"),
    "the marker is machinery; the tester should see plain words");
});

test("typing corrections are shown in the raw record", () => {
  // The report leaves these out. This list is where they belong: a field typed,
  // deleted and retyped is often a field that rejected something.
  const line = api.describeActionLine({
    index: 0, sessionId: "s", type: "input", wallClockMs: 0, videoOffsetMs: 0,
    pageUrl: "", pageTitle: "", tabId: 1, frameId: 0, locator: null,
    value: "Admin", valueWasRedacted: false, clientX: -1, clientY: -1,
    domSnapshotId: "", elementContextId: "",
    keystrokes: ["A", "d", "m", "n", "Backspace", "i", "n"],
    dropTargetLocator: null,
  });

  assert.match(line, /\[A d m n Backspace i n\]/);
});
