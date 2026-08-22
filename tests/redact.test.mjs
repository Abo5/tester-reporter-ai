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
    finalScreenshotBase64: "",
    finalScreenshotMimeType: "image/png",
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

// --- Secrets written as labelled page text ----------------------------------

test("a credential printed as page text is redacted, but its label survives", () => {
  // Found on the real OrangeHRM demo site, which advertises its own login on
  // the page: "Username : Admin  Password : admin123". Staging environments do
  // this constantly with "test credentials" banners.
  const counter = {};
  const result = api.redactValuePatterns(
    "<p>Username : Admin</p><p>Password : admin123</p>", counter, []);

  assert.ok(!result.includes("admin123"), "the printed password survived");
  assert.ok(result.includes("Password :"),
    "the label must survive - knowing a password was on screen is evidence, "
      + "knowing what it was is a liability");
  assert.ok(result.includes("[REDACTED:labelled-secret]"));
  assert.ok(result.includes("Admin"),
    "a username is not a secret and must not be over-redacted");
});

test("labelled-secret matching covers the common spellings", () => {
  const cases = [
    "password: hunter2xyz", "Passwd = s3cr3tval", "PWD:abc12345",
    "API key = AK12345678", "auth_token: zzzz9999", "OTP: 483920",
  ];
  for (const text of cases) {
    const counter = {};
    const result = api.redactValuePatterns(text, counter, []);
    assert.ok(result.includes("[REDACTED:labelled-secret]"),
      `not redacted: ${text} -> ${result}`);
  }
});

test("ordinary prose containing the word password is not mangled", () => {
  const counter = {};
  const text = "The password field is required and must be 8 characters.";
  const result = api.redactValuePatterns(text, counter, []);
  assert.equal(result, text,
    "a sentence with no colon or equals must not trigger the rule");
});

// --- The structural guard ---------------------------------------------------

test("NO string field anywhere in the bundle escapes the gate", () => {
  // This is the test that matters. Checking one field at a time is how the
  // significanceReason leak survived: it embedded the raw page URL, redaction
  // never touched that field, and every existing test happened to look
  // somewhere else.
  //
  // So: plant the same recognisable secret in EVERY string in a fully populated
  // bundle, run the gate, and walk the result. Any surviving copy is a leak,
  // whatever field it is in and whenever it was added.
  const SECRET = "SA0380000000608010167519";     // an IBAN shape the gate knows

  const bundle = {
    sessionId: "s1",
    reportLanguage: "en",
    actionTrace: [{
      stepNumber: 1,
      actionType: "input",
      elementDescription: `field near ${SECRET}`,
      inputValue: SECRET,
      wasRedacted: false,
      pageUrl: `https://staging.example.sa/x?iban=${SECRET}`,
      wallClockMs: 1,
      videoTimestamp: "00:01",
      videoOffsetMs: 1000,
    }],
    playwrightScript: `await page.getByLabel('IBAN').fill('${SECRET}');`,
    domSnapshots: [{
      snapshotId: "d1",
      trigger: "navigation",
      significanceReason: `The page after navigating to /x?iban=${SECRET}`,
      videoTimestamp: "00:01",
      pageUrl: `https://staging.example.sa/x?iban=${SECRET}`,
      documentLang: "en",
      documentDir: "ltr",
      prunedHtml: `<document><p>IBAN: ${SECRET}</p></document>`,
      wasTruncated: false,
    }],
    elementContext: [{
      stepNumber: 1,
      elementDescription: `the IBAN field (${SECRET})`,
      videoTimestamp: "00:01",
      elementHtml: `<input name="iban" value="${SECRET}" />`,
      ancestorHtml: `<form>${SECRET}</form>`,
      siblingHtml: [`<span>${SECRET}</span>`],
      computedStyles: { direction: "ltr" },
      ariaState: {
        role: "", ariaLabel: SECRET, ariaDescribedByText: SECRET,
        ariaExpanded: "", ariaInvalid: "", ariaDisabled: "", ariaChecked: "",
        ariaSelected: "", ariaHidden: "", isNativelyDisabled: false,
        isReadOnly: false, isRequired: false, validationMessage: SECRET,
      },
      inheritedLang: "en",
      inheritedDir: "ltr",
    }],
    networkFailures: [{
      id: "n1", sessionId: "s1", source: "page-world-patch",
      method: "POST", url: `https://staging.example.sa/api?iban=${SECRET}`,
      statusCode: 500, statusText: "err", startedAtMs: 1, durationMs: 1,
      videoOffsetMs: 1,
      requestBodyExcerpt: `{"iban":"${SECRET}"}`,
      responseBodyExcerpt: `{"echo":"${SECRET}"}`,
      requestHeaders: { "X-Trace": SECRET },
      responseContentType: "application/json",
      isFailure: true,
      initiatorPageUrl: `https://staging.example.sa/p?iban=${SECRET}`,
    }],
    consoleErrors: [{
      id: "c1", sessionId: "s1", level: "error",
      message: `failed for ${SECRET}`,
      stackExcerpt: `at handler (${SECRET}.js:1)`,
      wallClockMs: 1, videoOffsetMs: 1,
      pageUrl: `https://staging.example.sa/p?iban=${SECRET}`,
    }],
    video: {
      deliveryMode: "omitted", fileUri: "", base64Data: "",
      keyFrameBase64: [], keyFrameOffsetsMs: [], mimeType: "",
      durationMs: 0, sizeBytes: 0, downgradeReason: "",
    },
    pageMeta: {
      title: `Account ${SECRET}`,
      url: `https://staging.example.sa/p?iban=${SECRET}`,
      documentLang: "en", documentDir: "ltr",
      viewportWidth: 1280, viewportHeight: 720,
      detectedEnvironment: "staging", userAgent: "test",
    },
    redactionCompleted: false,
    redactionSummary: {},
    truncationNotes: [],
    finalScreenshotBase64: "",
    finalScreenshotMimeType: "image/png",
    estimatedInputTokens: 0,
  };

  const clean = api.redactSensitiveData(bundle, []);

  // Walk every string in the result and report the exact path of any survivor,
  // so a failure names the field instead of just saying "somewhere".
  const leaks = [];
  const walk = (node, path) => {
    if (typeof node === "string") {
      if (node.includes(SECRET)) {
        leaks.push(path);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(clean, "");

  assert.deepEqual(leaks, [],
    "the secret survived the redaction gate in these fields:\n  "
      + leaks.join("\n  "));
  assert.equal(clean.redactionCompleted, true);
});

// --- The shapes a secret actually arrives in --------------------------------

test("secrets are redacted in the shapes real traffic uses", () => {
  // Each of these leaked before the labelled-secret rule was rewritten. A login
  // request body and an OAuth callback are precisely where a real secret shows
  // up, so missing both made the rule close to decorative.
  const cases = [
    ["JSON body", '{"username":"admin","password":"admin123"}', "admin123"],
    ["quoted assignment", 'password = "hunter2secret"', "hunter2secret"],
    ["OAuth fragment",
      "https://x.test/cb#access_token=ya29AbCdEfGhIjKlMnOp&state=1",
      "ya29AbCdEfGhIjKlMnOp"],
    ["refresh token", "refresh_token=1//0gAbCdEfGhIjKlMn", "1//0gAbCdEfGhIjKlMn"],
    ["form encoded", "username=admin&password=s3cr3tvalue", "s3cr3tvalue"],
    ["api key", '{"api_key": "AK-99887766"}', "AK-99887766"],
  ];

  for (const [label, text, secret] of cases) {
    const result = api.redactValuePatterns(text, {}, []);
    assert.ok(!result.includes(secret), `${label} leaked: ${result}`);
    assert.ok(result.includes("[REDACTED:"), `${label} produced no marker`);
  }
});

test("the surrounding text survives so the evidence stays readable", () => {
  const result = api.redactValuePatterns(
    "https://x.test/cb#access_token=ya29AbCdEfGhIjKl&state=xyz", {}, []);

  assert.ok(result.includes("access_token="),
    "the parameter name must survive - a callback carrying a token is "
      + "different evidence from one that is not");
  assert.ok(result.includes("state=xyz"),
    "an adjacent non-secret parameter was swallowed");
});

test("ordinary text mentioning these words is left alone", () => {
  // Over-redaction makes the report useless, which is its own kind of failure.
  const untouched = [
    "The password field is required.",
    "Token expiry: 30 days",
    "Tenant ID: TN-40192",
    "Status: Active",
  ];
  for (const text of untouched) {
    assert.equal(api.redactValuePatterns(text, {}, []), text,
      `over-redacted: ${text}`);
  }
});

test("the generated script is redacted by FIELD, not only by value shape", () => {
  // The action trace is redacted by field name; the script used to be redacted
  // by value pattern alone. A six-digit verification code matches no value
  // pattern, so it was stripped from the trace and left in the fill() beside it.
  const script = [
    "await page.getByLabel('Account Number').fill('SA55123456789012');",
    "await page.getByLabel('Verification Code').fill('884210');",
    "await page.getByRole('textbox', { name: 'CVV' }).fill('417');",
    "await page.getByLabel('Tenant ID').fill('TN-40192');",
  ].join("\n");

  const result = api.redactPlaywrightScript(script, {}, []);

  assert.ok(!result.includes("884210"),
    "a verification code survived because it matches no value pattern");
  assert.ok(!result.includes("SA55123456789012"));
  assert.ok(!result.includes("'417'"));
  assert.ok(result.includes("TN-40192"),
    "a harmless tenant id must survive - over-redaction makes the script "
      + "useless to replay");
});
