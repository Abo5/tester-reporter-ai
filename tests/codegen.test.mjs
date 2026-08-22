// =============================================================================
// tests/codegen.test.mjs
// The generated spec is read and edited by a junior tester, so it is tested for
// the properties a human cares about: no arbitrary sleeps, real waits, honest
// comments, and never leaking a redacted value.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../dist-test/test-api.mjs");

/** Builds a locator of the given strategy without needing a DOM. */
function makeLocator(overrides = {}) {
  return {
    strategy: "role-and-name",
    primary: {
      strategy: "role-and-name",
      value: "Contract Renewal & Continuation",
      role: "tab",
      matchCount: 1,
      isUniqueAtCaptureTime: true,
    },
    fallbacks: [],
    framePath: [],
    isInShadowDom: false,
    isClosedShadowHost: false,
    shadowHostSelectors: [],
    isInsideRepeatedList: false,
    listRowAnchorText: "",
    listRowRole: "",
    tagName: "button",
    ariaRole: "tab",
    visibleText: "Contract Renewal & Continuation",
    accessibleName: "Contract Renewal & Continuation",
    ...overrides,
  };
}

/** Builds a recorded event without needing a DOM. */
function makeEvent(index, type, overrides = {}) {
  return {
    index,
    sessionId: "s1",
    type,
    wallClockMs: 1000 + index * 1000,
    videoOffsetMs: index * 1000,
    pageUrl: "https://staging.example.sa/services",
    pageTitle: "Service Catalog",
    tabId: 1,
    frameId: 0,
    locator: null,
    value: "",
    valueWasRedacted: false,
    clientX: -1,
    clientY: -1,
    domSnapshotId: "",
    elementContextId: "",
    ...overrides,
  };
}

const SESSION = {
  id: "s1",
  name: "Service Catalog - contract renewal",
  status: "ready",
  startedAtMs: Date.parse("2026-08-21T09:14:22.000Z"),
  stoppedAtMs: 0,
  wallClockDurationMs: 18000,
  recordedDurationMs: 18000,
  originTabId: 1,
  originUrl: "https://staging.example.sa/services",
  originTitle: "Service Catalog",
  visitedUrls: [],
  eventCount: 6,
  domSnapshotCount: 0,
  networkEntryCount: 0,
  networkFailureCount: 1,
  consoleErrorCount: 0,
  media: {
    mediaId: "m1", mimeType: "video/webm", sizeBytes: 1, durationMs: 18000,
    videoWidth: 1280, videoHeight: 720, frameRate: 10,
    hasMicrophoneAudio: true, hasTabAudio: true, state: "stopped", failureReason: "",
  },
  playwrightScript: "",
  bugReport: null,
  editedReportText: "",
  reportLanguage: "en",
  reportFailureReason: "",
  videoUploadConsentGiven: false,
  redactionSummary: {},
  lastVideoDeliveryMode: "omitted",
  videoDowngradeReason: "",
};

/** The worked example from the plan, as a recorded trace. */
function buildWorkedExampleTrace() {
  return [
    makeEvent(1, "click", {
      videoOffsetMs: 4200,
      locator: makeLocator(),
    }),
    makeEvent(2, "input", {
      videoOffsetMs: 9800,
      value: "TN-40192",
      locator: makeLocator({
        strategy: "label",
        primary: {
          strategy: "label", value: "Tenant ID", role: "",
          matchCount: 1, isUniqueAtCaptureTime: true,
        },
        ariaRole: "textbox", tagName: "input",
        visibleText: "", accessibleName: "Tenant ID",
      }),
    }),
    makeEvent(3, "press-key", {
      videoOffsetMs: 11100,
      value: "Enter",
      locator: makeLocator({
        strategy: "label",
        primary: {
          strategy: "label", value: "Tenant ID", role: "",
          matchCount: 1, isUniqueAtCaptureTime: true,
        },
        ariaRole: "textbox", tagName: "input",
        visibleText: "", accessibleName: "Tenant ID",
      }),
    }),
    makeEvent(4, "url-change", {
      videoOffsetMs: 11600,
      wallClockMs: 1000 + 3 * 1000 + 500,
      pageUrl: "https://staging.example.sa/services?tenant=TN-40192",
    }),
    makeEvent(5, "click", {
      videoOffsetMs: 15400,
      pageUrl: "https://staging.example.sa/services?tenant=TN-40192",
      locator: makeLocator({
        strategy: "css-path",
        primary: {
          strategy: "css-path",
          value: 'div[role="rowgroup"] > div:nth-of-type(3) > button',
          role: "", matchCount: 1, isUniqueAtCaptureTime: true,
        },
        fallbacks: [{
          strategy: "exact-text", value: "View", role: "",
          matchCount: 3, isUniqueAtCaptureTime: false,
        }],
        ariaRole: "", accessibleName: "View", visibleText: "View",
      }),
    }),
  ];
}

const FAILING_REQUEST = [{
  id: "n1",
  sessionId: "s1",
  source: "page-world-patch",
  method: "GET",
  url: "https://staging.example.sa/api/contracts/TN-40192",
  statusCode: 500,
  statusText: "Internal Server Error",
  startedAtMs: 1000 + 5 * 1000 + 300,
  durationMs: 220,
  videoOffsetMs: 15700,
  requestBodyExcerpt: "",
  responseBodyExcerpt: '{"error":"tenant_not_found"}',
  requestHeaders: {},
  responseContentType: "application/json",
  isFailure: true,
  initiatorPageUrl: "https://staging.example.sa/services",
}];

test("the generated spec NEVER contains an arbitrary sleep", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(!spec.includes("waitForTimeout"),
    "a sleep leaked into the generated spec; Playwright auto-waits instead");
  assert.ok(!spec.includes("setTimeout"));
});

test("a click that caused a navigation gets a real waitForURL", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  // A regular expression, not a quoted string: waitForURL treats a string as a
  // GLOB, and a recorded URL routinely contains ? and *, which are wildcards
  // there.
  assert.ok(spec.includes("await page.waitForURL(/^"),
    "expected a derived wait after the key press that changed the URL");
  assert.ok(spec.includes("tenant=TN-40192"),
    `the waited-for URL is wrong:\n${spec}`);
  assert.ok(!spec.includes("waitForURL('http"),
    "a raw string would be interpreted as a glob pattern");
});

test("the spec points at the request that failed right after a step", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(spec.includes("A request failed here during recording:"));
  assert.ok(spec.includes("/api/contracts/TN-40192 -> 500"));
});

test("a fragile locator is flagged with its alternatives", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(spec.includes("// FRAGILE:"));
  assert.ok(spec.includes("Alternative (exact-text, matched 3 element(s)"));
});

test("the spec starts with an explicit goto so it runs from a clean browser", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(spec.includes("await page.goto('https://staging.example.sa/services');"));
  assert.ok(spec.includes("import { test, expect } from '@playwright/test';"));
});

test("a redacted value is never written into the generated spec", () => {
  const events = [makeEvent(1, "input", {
    value: "[REDACTED:password]",
    valueWasRedacted: true,
    locator: makeLocator({
      strategy: "label",
      primary: {
        strategy: "label", value: "Password", role: "",
        matchCount: 1, isUniqueAtCaptureTime: true,
      },
      accessibleName: "Password", visibleText: "", tagName: "input",
    }),
  })];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);

  assert.ok(spec.includes("process.env.TEST_SECRET_VALUE"),
    "a redacted field should read its value from the environment");
  assert.ok(!spec.includes("[REDACTED:password]'"),
    "the redaction marker should not become a literal fill() argument");
});

test("closing assertions are derived, never invented", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(spec.includes("Assertions derived from the final recorded state"));
  assert.ok(spec.includes(
    "await expect(page).toHaveURL('https://staging.example.sa/services?tenant=TN-40192');"));
});

test("an apostrophe in a label does not break the generated TypeScript", () => {
  const events = [makeEvent(1, "click", {
    locator: makeLocator({
      primary: {
        strategy: "role-and-name", value: "Owner's details", role: "button",
        matchCount: 1, isUniqueAtCaptureTime: true,
      },
      accessibleName: "Owner's details",
    }),
  })];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(spec.includes("Owner\\'s details"), "the apostrophe was not escaped");
});

test("an Arabic label survives into the spec unchanged", () => {
  const events = [makeEvent(1, "click", {
    locator: makeLocator({
      primary: {
        strategy: "role-and-name", value: "تجديد العقد", role: "tab",
        matchCount: 1, isUniqueAtCaptureTime: true,
      },
      accessibleName: "تجديد العقد",
    }),
  })];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(spec.includes("تجديد العقد"));
});

test("an element inside an iframe produces a frameLocator chain", () => {
  const events = [makeEvent(1, "click", {
    locator: makeLocator({
      framePath: [{
        frameId: 7,
        frameSelector: 'iframe[name="payments"]',
        frameUrl: "https://payments.example.sa/widget",
      }],
    }),
  })];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(spec.includes("page.frameLocator('iframe[name=\"payments\"]')"));
  assert.ok(spec.includes("nested frame"));
});

test("a closed shadow root produces an honest warning, not a false locator", () => {
  const locator = makeLocator({ isClosedShadowHost: true });
  const comments = api.buildLocatorComments(locator);

  assert.ok(comments.some((line) => line.includes("CLOSED shadow root")));
  assert.ok(comments.some((line) => line.includes("cannot reach inside")));
});

test("scroll events become an explanatory comment, not a mouse.wheel call", () => {
  const events = [
    makeEvent(1, "scroll", { value: "0,1400" }),
    makeEvent(2, "click", { locator: makeLocator() }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(!spec.includes("mouse.wheel"));
  assert.ok(spec.includes("Playwright scrolls elements into view automatically"));
});

test("duplicate navigations to the same URL are coalesced", () => {
  const events = [
    makeEvent(1, "url-change", { pageUrl: "https://x.test/a", wallClockMs: 1000 }),
    makeEvent(2, "navigate", { pageUrl: "https://x.test/a", wallClockMs: 1500 }),
    makeEvent(3, "click", { locator: makeLocator() }),
  ];

  const kept = api.coalesceEventsForCodegen(events);
  assert.equal(kept.length, 2, "the duplicate navigation should have been dropped");
});

test("the spec file name is safe for a file system", () => {
  const name = api.buildSpecFileName({
    ...SESSION,
    name: "Service Catalog / contract renewal <staging>",
  });

  assert.ok(name.endsWith(".spec.ts"));
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("<"));
  assert.ok(!name.includes(" "));
});

// --- Double-click handling ---------------------------------------------------

test("a double-click does not leave a stray single click in the spec", () => {
  // The content script already drops the click with detail>1. What reaches
  // codegen is click, then dblclick, on the same element.
  const locator = makeLocator({
    primary: {
      strategy: "role-and-name", value: "Open contract", role: "button",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    accessibleName: "Open contract",
  });

  const events = [
    makeEvent(1, "click", { wallClockMs: 5000, locator }),
    makeEvent(2, "dblclick", { wallClockMs: 5180, locator }),
  ];

  const kept = api.coalesceEventsForCodegen(events);

  assert.equal(kept.length, 1, "the leading click should have been removed");
  assert.equal(kept[0].type, "dblclick");

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  const clickCalls = (spec.match(/\.click\(\)/g) ?? []).length;
  assert.equal(clickCalls, 0, "a stray .click() survived alongside .dblclick()");
  assert.ok(spec.includes(".dblclick()"));
});

test("an unrelated click before a double-click on ANOTHER element is kept", () => {
  const first = makeLocator({
    primary: {
      strategy: "role-and-name", value: "Search", role: "button",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    accessibleName: "Search",
  });
  const second = makeLocator({
    primary: {
      strategy: "role-and-name", value: "Open contract", role: "button",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    accessibleName: "Open contract",
  });

  const events = [
    makeEvent(1, "click", { wallClockMs: 5000, locator: first }),
    makeEvent(2, "dblclick", { wallClockMs: 5180, locator: second }),
  ];

  const kept = api.coalesceEventsForCodegen(events);
  assert.equal(kept.length, 2, "a click on a different element must survive");
});

test("a slow click then double-click on the same element is NOT merged", () => {
  const locator = makeLocator();
  const events = [
    makeEvent(1, "click", { wallClockMs: 5000, locator }),
    makeEvent(2, "dblclick", { wallClockMs: 9000, locator }),
  ];

  const kept = api.coalesceEventsForCodegen(events);
  assert.equal(kept.length, 2,
    "four seconds apart is two deliberate interactions, not one double-click");
});

// --- Navigation caused by a click -------------------------------------------

test("a click-caused navigation does not also emit a redundant goto", () => {
  // Seen in a real OrangeHRM login spec: waitForURL followed immediately by
  // goto for the SAME url. Replaying that reloads the page and throws away the
  // session the login just established, so the second statement is not merely
  // redundant - it changes what the test does.
  const locator = makeLocator({
    primary: {
      strategy: "role-and-name", value: "Login", role: "button",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    accessibleName: "Login",
  });

  const dashboard = "https://example.test/web/index.php/dashboard/index";
  const events = [
    makeEvent(1, "click", { wallClockMs: 2000, locator }),
    makeEvent(2, "navigate", { wallClockMs: 2600, pageUrl: dashboard }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);

  const waits = (spec.match(/waitForURL\(/g) ?? []).length;
  const gotosToDashboard = (spec.match(/goto\('https:\/\/example\.test\/web/g) ?? []).length;

  assert.equal(waits, 1, "expected exactly one waitForURL");
  assert.equal(gotosToDashboard, 0,
    "a goto to the URL we just waited for would reload the page and discard "
      + "the state the click established");
});

test("an unrelated later navigation still emits a goto", () => {
  const events = [
    makeEvent(1, "click", { wallClockMs: 1000, locator: makeLocator() }),
    makeEvent(2, "navigate", { wallClockMs: 9000, pageUrl: "https://example.test/other" }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(spec.includes("await page.goto('https://example.test/other');"),
    "a navigation the click did not cause must still be replayed");
});

// --- Regressions from the adversarial review --------------------------------

test("getByTestId is only used for data-testid, never data-qa or data-cy", () => {
  // Playwright's getByTestId resolves against ONE attribute. Emitting it for a
  // data-qa element produces a locator that matches nothing, in a spec that
  // looks perfectly correct.
  for (const [attribute, expectTestId] of [
    ["data-testid", true], ["data-qa", false],
    ["data-cy", false], ["data-test", false],
  ]) {
    const locator = makeLocator({
      strategy: "test-id",
      primary: {
        strategy: "test-id", value: `[${attribute}="save"]`, role: "",
        matchCount: 1, isUniqueAtCaptureTime: true,
      },
    });
    const expression = api.locatorToPlaywrightExpression(locator);

    if (expectTestId) {
      assert.ok(expression.includes("getByTestId('save')"),
        `data-testid should use getByTestId, got: ${expression}`);
    } else {
      assert.ok(!expression.includes("getByTestId"),
        `${attribute} must NOT use getByTestId - it would match nothing. `
          + `Got: ${expression}`);
      assert.ok(expression.includes(`[${attribute}="save"]`),
        `${attribute} should fall back to an attribute selector: ${expression}`);
    }
  }
});

test("a url-change step does not delete the navigation that follows it", () => {
  // The pre-await flag used to be inferred by looking for "waitForURL(" in the
  // emitted text. A url-change emits one for ITSELF, which set the flag to the
  // NEXT step's URL and silently dropped it.
  const events = [
    makeEvent(1, "url-change", { wallClockMs: 1000, pageUrl: "https://x.test/a" }),
    makeEvent(2, "navigate", { wallClockMs: 8000, pageUrl: "https://x.test/b" }),
    makeEvent(3, "click", { wallClockMs: 9000, locator: makeLocator() }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);

  assert.ok(spec.includes("waitForURL(/^https:") && spec.includes("x\\.test\\/a$/"),
    `the SPA route change should still be waited for:\n${spec}`);
  assert.ok(spec.includes("goto('https://x.test/b')"),
    "the later navigation was silently deleted");
});

test("a newline in a fallback value cannot break out of its comment", () => {
  // A multi-line button label put a real newline into a // comment, so
  // everything after it became code and the spec failed to parse.
  const locator = makeLocator({
    strategy: "css-path",
    primary: {
      strategy: "css-path", value: "div > b", role: "",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    fallbacks: [{
      strategy: "exact-text", value: "Save\nand continue", role: "",
      matchCount: 2, isUniqueAtCaptureTime: false,
    }],
  });

  for (const line of api.buildLocatorComments(locator)) {
    assert.ok(!line.includes("\n"),
      `a comment line contains a newline and would break the spec: ${line}`);
    assert.ok(line.trimStart().startsWith("//"),
      `a line escaped its comment: ${line}`);
  }
});

test("a non-ARIA role is not emitted to getByRole, which would not typecheck", () => {
  const locator = makeLocator({
    primary: {
      strategy: "role-and-name", value: "Save", role: "custom-widget",
      matchCount: 1, isUniqueAtCaptureTime: true,
    },
    ariaRole: "custom-widget",
    accessibleName: "Save",
  });

  const expression = api.locatorToPlaywrightExpression(locator);
  assert.ok(!expression.includes("getByRole('custom-widget'"),
    `getByRole takes a union of ARIA role names, so this would not compile: `
      + expression);
  assert.ok(expression.includes("getByText('Save'"),
    `expected a fallback that names the element: ${expression}`);
});

test("a standard ARIA role still uses getByRole", () => {
  const locator = makeLocator();   // role=tab
  assert.ok(api.locatorToPlaywrightExpression(locator).includes("getByRole('tab'"));
});

test("no visibility assertion on an element the page navigated away from", () => {
  // Asserting the clicked element is visible AFTER a navigation fails on a
  // recording that worked perfectly, which teaches the tester the tool lies.
  const events = [
    makeEvent(1, "click", { wallClockMs: 1000, locator: makeLocator() }),
    makeEvent(2, "navigate", { wallClockMs: 9000, pageUrl: "https://x.test/next" }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);

  assert.ok(!spec.includes("toBeVisible()"),
    "the element belongs to the previous page and must not be asserted on");
  assert.ok(spec.includes("belongs to the previous page"),
    "the spec should say why there is no element assertion");
  assert.ok(spec.includes("toHaveURL('https://x.test/next')"),
    "the final URL is still a legitimate assertion");
});

test("a visibility assertion IS emitted when nothing navigated afterwards", () => {
  const events = [
    makeEvent(1, "navigate", { wallClockMs: 500, pageUrl: "https://x.test/a" }),
    makeEvent(2, "click", { wallClockMs: 1000, locator: makeLocator() }),
  ];
  const spec = api.generatePlaywrightSpec(SESSION, events, []);
  assert.ok(spec.includes("toBeVisible()"),
    "with no navigation after the click, the element is still on screen");
});

test("waitForURL gets a regex, because a string would be a glob pattern", () => {
  // Playwright treats a waitForURL string as a GLOB. A recorded URL routinely
  // contains ? and *, both wildcards there, so '/x?tenant=TN-1' would also
  // match '/xAtenant=TN-1'.
  const events = [
    makeEvent(1, "click", { wallClockMs: 1000, locator: makeLocator() }),
    makeEvent(2, "navigate", {
      wallClockMs: 1400,
      pageUrl: "https://x.test/search?q=a*b&page=1",
    }),
  ];

  const spec = api.generatePlaywrightSpec(SESSION, events, []);

  assert.ok(!/waitForURL\('/.test(spec),
    "a raw string argument would be treated as a glob pattern");
  assert.ok(spec.includes("waitForURL(/^"), `expected a regex literal:\n${spec}`);
  assert.ok(spec.includes("\\?q=a\\*b"),
    `the ? and * must be escaped so they match literally:\n${spec}`);
});
