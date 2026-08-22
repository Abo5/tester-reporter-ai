// =============================================================================
// tests/redact.test.mjs
// The gate. If these tests are weak, secrets reach Google.
//
// The most important test in this file is the one asserting that a fill() call
// in the GENERATED SCRIPT is redacted. That surface is the easiest to forget
// and the most dangerous, because it contains literal typed values.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../dist-test/test-api.mjs");

/** Builds a minimal but complete bundle so the gate can run over it. */
function makeBundle(overrides = {}) {
  return {
    sessionId: "s1",
    reportLanguage: "en",
    actionTrace: [],
    playwrightScript: "",
    domSnapshots: [],
    elementContext: [],
    networkFailures: [],
    consoleErrors: [],
    video: {
      deliveryMode: "omitted",
      fileUri: "",
      base64Data: "",
      keyFrameBase64: [],
      keyFrameOffsetsMs: [],
      mimeType: "",
      durationMs: 0,
      sizeBytes: 0,
      downgradeReason: "",
    },
    pageMeta: {
      title: "Service Catalog",
      url: "https://staging.example.sa/services",
      documentLang: "en",
      documentDir: "ltr",
      viewportWidth: 1280,
      viewportHeight: 720,
      detectedEnvironment: "staging",
      userAgent: "test",
    },
    redactionCompleted: false,
    redactionSummary: {},
    truncationNotes: [],
    estimatedInputTokens: 0,
    ...overrides,
  };
}

test("a value typed into a password-named field is replaced, not deleted", () => {
  const bundle = makeBundle({
    actionTrace: [{
      stepNumber: 1,
      actionType: "input",
      elementDescription: '"Password" (role=textbox)',
      inputValue: "hunter2secret",
      wasRedacted: false,
      pageUrl: "https://staging.example.sa/login",
      wallClockMs: 0,
      videoTimestamp: "00:03",
      videoOffsetMs: 3000,
    }],
  });

  const result = api.redactSensitiveData(bundle, []);

  assert.equal(result.actionTrace[0].inputValue, "[REDACTED:password]");
  assert.equal(result.actionTrace[0].wasRedacted, true);
  assert.equal(result.redactionCompleted, true);
  assert.ok(
    result.actionTrace[0].inputValue !== "",
    "redaction must REPLACE, not delete: the model still has to know a value "
      + "was entered",
  );
});

test("a fill() in the GENERATED SCRIPT loses a card number", () => {
  const script = [
    "test('x', async ({ page }) => {",
    "  await page.getByLabel('Card number').fill('4111 1111 1111 1111');",
    "  await page.getByLabel('Tenant ID').fill('TN-40192');",
    "});",
  ].join("\n");

  const bundle = makeBundle({ playwrightScript: script });
  const result = api.redactSensitiveData(bundle, []);

  assert.ok(!result.playwrightScript.includes("4111 1111 1111 1111"),
    "a card number survived in the generated script");
  assert.ok(result.playwrightScript.includes("[REDACTED:card]"));
  assert.ok(result.playwrightScript.includes("TN-40192"),
    "a harmless tenant id should NOT be redacted");
});

test("a password input's value attribute is scrubbed out of captured HTML", () => {
  const html = '<document><input type="password" name="userPassword" '
    + 'value="hunter2secret" /></document>';

  const bundle = makeBundle({
    domSnapshots: [{
      snapshotId: "d1",
      trigger: "interaction",
      significanceReason: "test",
      videoTimestamp: "00:01",
      pageUrl: "https://staging.example.sa/login",
      documentLang: "en",
      documentDir: "ltr",
      prunedHtml: html,
      wasTruncated: false,
    }],
  });

  const result = api.redactSensitiveData(bundle, []);
  const output = result.domSnapshots[0].prunedHtml;

  assert.ok(!output.includes("hunter2secret"), "the password survived in the DOM");
  assert.ok(output.includes("[REDACTED:password]"));
});

test("bearer tokens, JWTs and API keys are removed from text", () => {
  const counter = {};
  const text = [
    "Authorization: Bearer abcdefghijklmnop1234567890",
    "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh",
    "key AIzaSyD1234567890abcdefghijklmnopqrstuvw",
  ].join("\n");

  const result = api.redactValuePatterns(text, counter, []);

  assert.ok(!result.includes("abcdefghijklmnop1234567890"));
  assert.ok(!result.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(!result.includes("AIzaSyD1234567890"));
});

test("Saudi national id and IBAN shapes are removed", () => {
  const counter = {};
  const result = api.redactValuePatterns(
    "Applicant 1098765432 with IBAN SA0380000000608010167519 applied.",
    counter,
    [],
  );

  assert.ok(!result.includes("1098765432"), "a national id survived");
  assert.ok(!result.includes("SA0380000000608010167519"), "an IBAN survived");
});

test("sensitive query parameters are scrubbed but their names survive", () => {
  const counter = {};
  const result = api.redactUrl(
    "https://staging.example.sa/callback?access_token=abc123xyz&tenant=TN-40192",
    counter,
    [],
  );

  assert.ok(!result.includes("abc123xyz"));
  assert.ok(result.includes("access_token="),
    "the parameter NAME should survive: a 401 with a token is a different bug "
      + "from a 401 without one");
  assert.ok(result.includes("tenant=TN-40192"), "a harmless parameter was lost");
});

test("Authorization and Cookie headers are stripped even if somehow collected", () => {
  const bundle = makeBundle({
    networkFailures: [{
      id: "n1",
      sessionId: "s1",
      source: "web-request-api",
      method: "GET",
      url: "https://staging.example.sa/api/contracts",
      statusCode: 500,
      statusText: "Internal Server Error",
      startedAtMs: 0,
      durationMs: 120,
      videoOffsetMs: 1000,
      requestBodyExcerpt: "",
      responseBodyExcerpt: '{"error":"tenant_not_found"}',
      requestHeaders: { Authorization: "Bearer secret-value-here", Accept: "application/json" },
      responseContentType: "application/json",
      isFailure: true,
      initiatorPageUrl: "https://staging.example.sa/services",
    }],
  });

  const result = api.redactSensitiveData(bundle, []);
  const headers = result.networkFailures[0].requestHeaders;

  assert.equal(headers.Authorization, "[REDACTED:header]");
  assert.equal(headers.Accept, "application/json");
  assert.ok(result.networkFailures[0].responseBodyExcerpt.includes("tenant_not_found"),
    "the error body is the evidence and must survive");
});

test("custom patterns from settings are applied", () => {
  const counter = {};
  const rules = api.compileCustomPatterns(["\\bEMP-\\d{6}\\b"]);
  const result = api.redactValuePatterns("Employee EMP-004321 opened it.", counter, rules);

  assert.ok(!result.includes("EMP-004321"));
  assert.ok(result.includes("[REDACTED:custom]"));
});

test("an invalid custom pattern is skipped, not thrown", () => {
  const rules = api.compileCustomPatterns(["([unclosed", "\\bOK-\\d+\\b"]);
  assert.equal(rules.length, 1, "the invalid line should be dropped silently");
});

test("the redaction summary counts what was removed, so the gate is observable", () => {
  const bundle = makeBundle({
    actionTrace: [{
      stepNumber: 1,
      actionType: "input",
      elementDescription: '"Password"',
      inputValue: "secret",
      wasRedacted: false,
      pageUrl: "https://staging.example.sa/login",
      wallClockMs: 0,
      videoTimestamp: "00:01",
      videoOffsetMs: 1000,
    }],
  });

  const result = api.redactSensitiveData(bundle, []);
  assert.ok(Object.keys(result.redactionSummary).length > 0);
  assert.ok(result.redactionSummary.password >= 1);
});

test("redaction failure BLOCKS the call by throwing", () => {
  // A bundle whose actionTrace is not iterable makes the gate throw internally.
  const broken = makeBundle({ actionTrace: 42 });

  assert.throws(
    () => api.redactSensitiveData(broken, []),
    /Redaction failed, so nothing was sent/,
    "redaction must throw rather than degrade silently",
  );
});

test("a global regex does not skip matches on the second string it sees", () => {
  // Regression guard: /g patterns carry lastIndex between calls, which silently
  // drops matches unless a fresh RegExp is built each time.
  const counter = {};
  const first = api.redactValuePatterns("a@b.com and c@d.com", counter, []);
  const second = api.redactValuePatterns("e@f.com and g@h.com", counter, []);

  assert.ok(!first.includes("@"), "first string not fully redacted");
  assert.ok(!second.includes("@"), "second string not fully redacted - lastIndex bug");
});
