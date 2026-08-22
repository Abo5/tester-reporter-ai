// =============================================================================
// tests/live/gemini.live.mjs
//
// THE ONLY TEST THAT TOUCHES THE NETWORK. It calls the real Gemini API and
// checks that a real model, given real evidence, produces a report this
// extension can actually use.
//
// Run it with:   npm run test:live
//
// It is deliberately NOT part of `npm test`, because a test suite that needs an
// API key and an internet connection is a test suite people stop running.
//
// The API key comes from .env, which Node loads itself via --env-file-if-exists.
// Nothing in this repository reads that file's contents.
// =============================================================================

import { test, before } from "node:test";
import assert from "node:assert/strict";

const api = await import("../../dist-test/test-api.mjs");

const API_KEY = (process.env.GEMINI_API_KEY ?? "").trim();
const MODEL_ID = (process.env.GEMINI_MODEL ?? "").trim() || api.SUPPORTED_MODELS[0];
const LANGUAGE = (process.env.GEMINI_REPORT_LANGUAGE ?? "en").trim() === "ar"
  ? "ar" : "en";

const HAVE_KEY = API_KEY !== "";

/** Prints a labelled block so the tester can SEE what the model said. */
function show(label, body) {
  console.log("\n" + "=".repeat(72));
  console.log("  " + label);
  console.log("=".repeat(72));
  console.log(body);
}

before(() => {
  if (!HAVE_KEY) {
    console.log(
      "\n  No GEMINI_API_KEY found.\n"
      + "  Put your key in .env (copy .env.example) and run this again.\n"
      + "  Every check below is skipped.\n",
    );
    return;
  }

  // The shipped client refuses a model id that is not on the supported list, so
  // a typo cannot silently become a 404. For a live run the tester has chosen
  // the model deliberately, so register it for this process only.
  if (!api.SUPPORTED_MODELS.includes(MODEL_ID)) {
    api.SUPPORTED_MODELS.push(MODEL_ID);
    console.log(
      "\n  NOTE: '" + MODEL_ID + "' is not in SUPPORTED_MODELS.\n"
      + "  Registered for this test run only. To make it permanent, add it to\n"
      + "  SUPPORTED_MODELS in src/shared/constants.ts (one line).\n",
    );
  }
  console.log("\n  Live run against: " + MODEL_ID + "  (language: " + LANGUAGE + ")\n");
});

// ---------------------------------------------------------------------------
// A realistic session: the tester searches for a tenant and the page misbehaves.
//
// The defect is deliberately only fully visible IN THE PAGE CODE:
//   - an error message that is in the DOM but NOT on screen
//   - aria-invalid="true" on the field
//   - a 500 from the API
// That is exactly the class of defect this product exists to catch.
// ---------------------------------------------------------------------------

const PRUNED_HTML = `<document lang="en" dir="ltr" title="Service Catalog">
<main>
<div role="tablist">
<button role="tab" aria-selected="true">Initiating the Rental Relationship</button>
<button role="tab">Contract Renewal &amp; Continuation</button>
<button role="tab">Managing Contract Parties &amp; Authorizations</button>
<button role="tab">Ending the Rental Relationship</button>
</div>
<form>
<label for="tenant">Tenant ID</label>
<input id="tenant" name="tenantId" type="text" value="TN-40192" aria-invalid="true" aria-describedby="tenant-error" />
<p id="tenant-error" data-qa-hidden="true">Tenant ID must be 8 digits</p>
<button type="submit" disabled>Search</button>
</form>
<div role="status"></div>
</main>
</document>`;

function buildBundle() {
  return {
    sessionId: "live-test-session",
    reportLanguage: LANGUAGE,
    actionTrace: [
      {
        stepNumber: 1, actionType: "navigate",
        elementDescription: "the page", inputValue: "", wasRedacted: false,
        pageUrl: "https://staging.example.sa/services",
        wallClockMs: 0, videoTimestamp: "00:00", videoOffsetMs: 0,
      },
      {
        stepNumber: 2, actionType: "click",
        elementDescription: '"Contract Renewal & Continuation" (role=tab)',
        inputValue: "", wasRedacted: false,
        pageUrl: "https://staging.example.sa/services",
        wallClockMs: 4200, videoTimestamp: "00:04", videoOffsetMs: 4200,
      },
      {
        stepNumber: 3, actionType: "input",
        elementDescription: '"Tenant ID" (role=textbox)',
        inputValue: "TN-40192", wasRedacted: false,
        pageUrl: "https://staging.example.sa/services",
        wallClockMs: 9800, videoTimestamp: "00:09", videoOffsetMs: 9800,
      },
      {
        stepNumber: 4, actionType: "press-key",
        elementDescription: '"Tenant ID" (role=textbox)',
        inputValue: "Enter", wasRedacted: false,
        pageUrl: "https://staging.example.sa/services",
        wallClockMs: 11100, videoTimestamp: "00:11", videoOffsetMs: 11100,
      },
    ],
    playwrightScript: [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('Service Catalog - tenant search', async ({ page }) => {",
      "  await page.goto('https://staging.example.sa/services');",
      "  await page.getByRole('tab', { name: 'Contract Renewal & Continuation' }).click();",
      "  await page.getByLabel('Tenant ID').fill('TN-40192');",
      "  await page.getByLabel('Tenant ID').press('Enter');",
      "});",
    ].join("\n"),
    domSnapshots: [{
      snapshotId: "snap-1",
      trigger: "network-failure",
      significanceReason:
        "The page at the moment a network request failed.",
      videoTimestamp: "00:11",
      pageUrl: "https://staging.example.sa/services",
      documentLang: "en",
      documentDir: "ltr",
      prunedHtml: PRUNED_HTML,
      wasTruncated: false,
    }],
    elementContext: [{
      stepNumber: 3,
      elementDescription: '"Tenant ID" (role=textbox)',
      videoTimestamp: "00:09",
      elementHtml: '<input id="tenant" name="tenantId" type="text" value="TN-40192" aria-invalid="true" aria-describedby="tenant-error" />',
      ancestorHtml: '<form><label for="tenant">Tenant ID</label><input id="tenant" aria-invalid="true" /><p id="tenant-error" data-qa-hidden="true">Tenant ID must be 8 digits</p><button type="submit" disabled>Search</button></form>',
      siblingHtml: [
        '<label for="tenant">Tenant ID</label>',
        '<p id="tenant-error" data-qa-hidden="true">Tenant ID must be 8 digits</p>',
      ],
      computedStyles: { display: "block", visibility: "visible", direction: "ltr" },
      ariaState: {
        role: "", ariaLabel: "", ariaDescribedByText: "Tenant ID must be 8 digits",
        ariaExpanded: "", ariaInvalid: "true", ariaDisabled: "", ariaChecked: "",
        ariaSelected: "", ariaHidden: "", isNativelyDisabled: false,
        isReadOnly: false, isRequired: false, validationMessage: "",
      },
      inheritedLang: "en",
      inheritedDir: "ltr",
    }],
    networkFailures: [{
      id: "net-1", sessionId: "live-test-session", source: "page-world-patch",
      method: "GET", url: "https://staging.example.sa/api/contracts/TN-40192",
      statusCode: 500, statusText: "Internal Server Error",
      startedAtMs: 11400, durationMs: 240, videoOffsetMs: 11400,
      requestBodyExcerpt: "",
      responseBodyExcerpt: '{"error":"tenant_not_found","traceId":"9f21"}',
      requestHeaders: {}, responseContentType: "application/json",
      isFailure: true,
      initiatorPageUrl: "https://staging.example.sa/services",
    }],
    consoleErrors: [{
      id: "con-1", sessionId: "live-test-session", level: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'contractId')",
      stackExcerpt: "at renderContract (app.js:2841)",
      wallClockMs: 11500, videoOffsetMs: 11500,
      pageUrl: "https://staging.example.sa/services",
    }],
    video: {
      deliveryMode: "omitted", fileUri: "", base64Data: "",
      keyFrameBase64: [], keyFrameOffsetsMs: [], mimeType: "",
      durationMs: 18000, sizeBytes: 0,
      downgradeReason: "No video was sent with this live test run.",
    },
    pageMeta: {
      title: "Service Catalog",
      url: "https://staging.example.sa/services",
      documentLang: "en", documentDir: "ltr",
      viewportWidth: 1280, viewportHeight: 720,
      detectedEnvironment: "staging",
      userAgent: "live-test",
    },
    redactionCompleted: false,
    redactionSummary: {},
    truncationNotes: [],
    estimatedInputTokens: 0,
  };
}

/** Runs the real pipeline once and caches the outcome for every assertion. */
let cachedOutcome = null;
let cachedBundle = null;

async function runOnce() {
  if (cachedOutcome !== null) {
    return cachedOutcome;
  }

  // The gate runs first, exactly as it does in the extension.
  cachedBundle = api.redactSensitiveData(buildBundle(), []);
  assert.equal(cachedBundle.redactionCompleted, true);

  cachedOutcome = await api.generateBugReport({
    apiKey: API_KEY,
    modelId: MODEL_ID,
    bundle: cachedBundle,
    videoBlob: null,
    events: [],
    failureEventIndexes: [],
  });
  return cachedOutcome;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

test("the real model returns a report the extension can use", {
  skip: !HAVE_KEY ? "no GEMINI_API_KEY in .env" : false,
}, async () => {
  const outcome = await runOnce();

  if (outcome.kind !== "success") {
    // Print everything useful before failing: this is the test that tells you
    // whether the VERIFY items in the plan are actually correct.
    show("REQUEST FAILED: " + outcome.kind, JSON.stringify(outcome, null, 2).slice(0, 3000));
    assert.fail(
      "The live call did not succeed (kind='" + outcome.kind + "'). If this is "
      + "'http-error' with 404, the model id is wrong. If it is 'malformed-json', "
      + "the structured-output parameter names in src/ai/schema.ts and "
      + "src/ai/gemini.ts need checking against current documentation.",
    );
  }

  const validation = api.validateBugReport(outcome.report);
  assert.equal(validation.isValid, true,
    "the model's JSON failed our validator: " + validation.problems.join("; "));
});

test("the model does NOT claim it watched a video we never sent", {
  skip: !HAVE_KEY ? "no GEMINI_API_KEY in .env" : false,
}, async () => {
  const outcome = await runOnce();
  if (outcome.kind !== "success") {
    return;   // Already reported by the first test.
  }

  assert.equal(outcome.report.evidenceUsed.video, false,
    "the model claimed video evidence for a request that carried none - this is "
    + "the exact hallucination reconcileEvidenceUsed() exists to catch");
});

test("the model used the page code and grounded its report in it", {
  skip: !HAVE_KEY ? "no GEMINI_API_KEY in .env" : false,
}, async () => {
  const outcome = await runOnce();
  if (outcome.kind !== "success") {
    return;
  }

  assert.equal(outcome.report.evidenceUsed.pageCode, true,
    "page code was provided and should have been used");

  // Tolerant on purpose: we assert the report is GROUNDED, not that it used any
  // particular wording. Asserting exact model prose would be a flaky test.
  const haystack = [
    outcome.report.currentBehavior,
    outcome.report.description,
    outcome.report.title,
    outcome.report.supportingEvidence.join(" "),
  ].join(" ").toLowerCase();

  const grounded =
    haystack.includes("500")
    || haystack.includes("8 digits")
    || haystack.includes("tn-40192")
    || haystack.includes("aria-invalid")
    || haystack.includes("tenant_not_found");

  assert.ok(grounded,
    "the report quotes none of the captured facts (500, 'Tenant ID must be 8 "
    + "digits', TN-40192, aria-invalid, tenant_not_found). It may be "
    + "hallucinating rather than reading the evidence.\n\n"
    + api.formatReportAsPlainText(outcome.report));
});

test("Expected Behavior is either derived or honestly marked undeterminable", {
  skip: !HAVE_KEY ? "no GEMINI_API_KEY in .env" : false,
}, async () => {
  const outcome = await runOnce();
  if (outcome.kind !== "success") {
    return;
  }

  const report = outcome.report;
  if (report.expectedBehaviorDeterminable === false) {
    assert.equal(report.expectedBehavior, api.NOT_DETERMINABLE_SENTENCE,
      "the model must use the exact sentence, byte for byte");
  } else {
    assert.ok(report.expectedBehavior.trim().length > 0);
    assert.notEqual(report.expectedBehavior, api.NOT_DETERMINABLE_SENTENCE);
  }
});

test("the finished report renders into the fixed template", {
  skip: !HAVE_KEY ? "no GEMINI_API_KEY in .env" : false,
}, async () => {
  const outcome = await runOnce();
  if (outcome.kind !== "success") {
    return;
  }

  const text = api.formatReportAsPlainText(outcome.report);

  show("THE AI's BUG REPORT", text);
  show("ANTI-HALLUCINATION CHANNEL", JSON.stringify({
    confidence: outcome.report.confidence,
    severityGuess: outcome.report.severityGuess,
    defectType: outcome.report.defectType,
    evidenceUsed: outcome.report.evidenceUsed,
    supportingEvidence: outcome.report.supportingEvidence,
    unverifiedClaims: outcome.report.unverifiedClaims,
    secondaryIssues: outcome.report.secondaryIssues,
  }, null, 2));

  assert.ok(text.startsWith("Title: "));
  assert.ok(text.includes("\nSteps to Reproduce:\n1. "));
  assert.ok(text.includes("\nCurrent Behavior: "));
  assert.ok(text.includes("\nExpected Behavior: "));
});
