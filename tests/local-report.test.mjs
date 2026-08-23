// =============================================================================
// tests/local-report.test.mjs
//
// The free report.
//
// It transcribes; it does not diagnose. These tests hold it to BOTH halves of
// that: everything it says must be traceable to something recorded, and it must
// not quietly read like the paid report when it is not.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../dist-test/test-api.mjs");

function step(actionType, overrides = {}) {
  return {
    stepNumber: 1,
    actionType,
    elementDescription: "",
    inputValue: "",
    wasRedacted: false,
    pageUrl: "https://staging.example.sa/tenants",
    wallClockMs: 1000,
    videoTimestamp: "00:01",
    videoOffsetMs: 1000,
    keystrokes: [],
    ...overrides,
  };
}

const SESSION = {
  id: "s1",
  name: "Tenant list",
  originUrl: "https://staging.example.sa/tenants",
  originTitle: "Tenant list",
  recordedDurationMs: 173000,
  testerExpectedResult: "",
};

test("a step becomes the sentence a tester would have written", () => {
  assert.equal(
    api.describeStepInWords(step("input", {
      elementDescription: 'the "Tenant" field', inputValue: "TN-40192",
    })),
    'Typed "TN-40192" on the "Tenant" field');

  assert.equal(
    api.describeStepInWords(step("click", { elementDescription: 'the "Save" button' })),
    'Clicked on the "Save" button');

  assert.equal(
    api.describeStepInWords(step("press-key", { inputValue: "Control+f" })),
    "Pressed Control+f");
});

test("copy and paste appear as steps, with what was moved", () => {
  // The tester's own words: "if I copy something and paste it somewhere, it
  // should count as a step."
  assert.equal(
    api.describeStepInWords(step("copy", {
      elementDescription: "the results row", inputValue: "TN-40192",
    })),
    'Copied "TN-40192" on the results row');

  assert.equal(
    api.describeStepInWords(step("paste", {
      elementDescription: 'the "Filter" field', inputValue: "TN-40192",
    })),
    'Pasted "TN-40192" on the "Filter" field');
});

test("a secret is described but never repeated", () => {
  const typed = api.describeStepInWords(step("input", {
    elementDescription: "the password field",
    inputValue: "[REDACTED:password]",
    wasRedacted: true,
  }));
  assert.equal(typed, "Typed a hidden value on the password field");
  assert.ok(!typed.includes("REDACTED"),
    "the marker is machinery, not something to put in a ticket");
});

test("pointer movement is left out of the numbered steps", () => {
  // Evidence for someone investigating; clutter for someone reproducing. A
  // numbered list is an instruction to follow, and "moved the pointer" is not.
  const steps = api.buildStepsInWords([
    step("click", { elementDescription: "a button" }),
    step("mouse-path", { inputValue: "10,10 300,400" }),
    step("hover", { elementDescription: "a menu" }),
    step("input", { inputValue: "x" }),
  ]);

  assert.equal(steps.length, 2);
  assert.ok(!steps.join(" ").includes("pointer"));
});

test("failures are quoted, not interpreted", () => {
  const text = api.describeObservedFailures(
    [{ method: "GET", url: "https://x.test/api/tenants?id=1", statusCode: 500 }],
    [{ message: "TypeError: cannot read length of undefined" }]);

  assert.match(text, /GET \/api\/tenants\?id=1 returned 500/);
  assert.match(text, /the page logged: TypeError/);
  // The word that would make this an analysis rather than a transcript.
  assert.ok(!/because|caused by|due to/i.test(text),
    "this generator must never explain WHY; it does not know");
});

test("the whole report fills the template from the recording", () => {
  const report = api.buildLocalReport({
    session: SESSION,
    actionTrace: [
      step("navigate"),
      step("input", { elementDescription: 'the "Tenant" field', inputValue: "TN-40192" }),
      step("click", { elementDescription: 'the "Search" button' }),
    ],
    networkFailures: [
      { method: "GET", url: "https://x.test/api/tenants", statusCode: 500 },
    ],
    consoleErrors: [],
  });

  assert.match(report.title, /Failure during a recorded session on Tenant list/);
  assert.equal(report.stepsToReproduce.length, 3);
  assert.match(report.description, /2-minute 53-second/);
  assert.match(report.currentBehavior, /returned 500/);
  assert.ok(report.supportingEvidence.length >= 1);
});

test("with no failure captured it says so instead of inventing one", () => {
  const report = api.buildLocalReport({
    session: SESSION,
    actionTrace: [step("click", { elementDescription: "a button" })],
    networkFailures: [],
    consoleErrors: [],
  });

  assert.match(report.title, /^Recorded session on/,
    "no failure means no claim of failure in the title");
  assert.match(report.currentBehavior, /visible in the video/,
    "it must point at where the answer is, not guess at it");
});

test("Expected Behavior stays honest, or becomes the tester's", () => {
  const withoutTester = api.buildLocalReport({
    session: SESSION, actionTrace: [], networkFailures: [], consoleErrors: [],
  });
  assert.match(withoutTester.expectedBehavior, /not determinable/);
  assert.equal(withoutTester.expectedBehaviorDeterminable, false);

  const withTester = api.buildLocalReport({
    session: { ...SESSION, testerExpectedResult: "the row should stay selected" },
    actionTrace: [], networkFailures: [], consoleErrors: [],
  });
  assert.match(withTester.expectedBehavior, /stated by the tester/);
  assert.equal(withTester.expectedBehaviorDeterminable, true);
});

test("the report never claims evidence it did not read", () => {
  const report = api.buildLocalReport({
    session: SESSION, actionTrace: [step("click")],
    networkFailures: [], consoleErrors: [],
  });

  // This generator does not look at the video or the page code. Saying it did
  // would be the exact dishonesty the AI path is built to avoid.
  assert.equal(report.evidenceUsed.video, false);
  assert.equal(report.evidenceUsed.pageCode, false);
  assert.equal(report.confidence, "low");
});

test("the banner says which report this is", () => {
  // The two tiers share six headings. A reader who does not know which one they
  // have will read a transcript as an analysis.
  assert.match(api.LOCAL_REPORT_BANNER, /not by AI/);
  assert.match(api.LOCAL_REPORT_BANNER, /does not diagnose/);
});
