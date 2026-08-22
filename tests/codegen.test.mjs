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
    keystrokes: [],
    dropTargetLocator: null,
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

test("no step SYNCHRONISES on a sleep", () => {
  // The original rule here was "no waitForTimeout anywhere", and it was the
  // right rule for the wrong reason. What makes a sleep an anti-pattern is
  // using it to wait for the application: it is slower than the app on a fast
  // machine and shorter than it on a slow one, which is the definition of a
  // flaky test. Every step still derives its own wait - waitForURL, or
  // Playwright's own auto-waiting.
  //
  // The script now also carries ONE deliberate pause between steps, so the
  // tester who recorded the session can watch the replay rather than see it
  // flash past. That is a viewing aid, not synchronisation, and it is gated
  // behind an environment variable so CI runs at full speed.
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(!spec.includes("setTimeout"));

  // Every waitForTimeout lives in a NAMED HELPER, never inline in a step.
  // There are two, and each is a deliberate viewing or timing aid rather than
  // a way of waiting for the application:
  //   pause()                - so a person can watch the replay
  //   waitLikeTheTesterDid() - so the tester's own pacing is reproduced
  assert.ok(spec.includes("await page.waitForTimeout(stepPauseMs)"),
    "the viewing pause must be driven by stepPauseMs");
  assert.ok(spec.includes("Math.round(ms / replaySpeed)"),
    "the recorded gap must be scaled by REPLAY_SPEED, not hard-coded");

  const stepBody = spec.slice(spec.indexOf("// [00:00] step 1"));
  assert.ok(!stepBody.includes("waitForTimeout"),
    `a raw sleep leaked into a step; steps call the named helpers:\n${stepBody}`);
});

test("the pause between steps is three seconds, and CI can switch it off", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  assert.ok(spec.includes("process.env.STEP_PAUSE_MS ?? 3000"),
    "the replay must default to a watchable pace and stay overridable");
  assert.ok(spec.includes("if (stepPauseMs > 0)"),
    "STEP_PAUSE_MS=0 has to mean no sleep at all, not a zero-length one");
});

test("every step is followed by the pause", () => {
  const spec = api.generatePlaywrightSpec(
    SESSION, buildWorkedExampleTrace(), FAILING_REQUEST);

  const stepComments = spec.split(/\/\/ \[\d\d:\d\d\] step /).length - 1;
  const pauses = spec.split("await pause();").length - 1;
  assert.equal(pauses, stepComments,
    `${stepComments} steps but ${pauses} pauses; a step without a pause is a `
    + "step the watcher misses");
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

// -----------------------------------------------------------------------------
// Keyboard commands
//
// A tester pressed Ctrl+F to find a record they had just created, and nothing
// was recorded at all: the capture layer listened for Enter, Tab and Escape and
// dropped everything else. The whole search was invisible to the report, and a
// reviewer could not tell how the tester found the row.
// -----------------------------------------------------------------------------

test("a browser-level shortcut is flagged as unreproducible", () => {
  const note = api.describeBrowserLevelShortcut("Control+f");
  assert.match(note, /find bar/);
  assert.match(note, /will pass without reproducing/,
    "the comment has to say the line passes without doing anything, or the "
    + "next reader believes the search is covered");
});

test("an application shortcut gets no warning", () => {
  // Ctrl+S in a web application is the application's own save. Playwright
  // reproduces it exactly, so a warning would be noise.
  assert.equal(api.describeBrowserLevelShortcut("Control+s"), "");
  assert.equal(api.describeBrowserLevelShortcut("Enter"), "");
  assert.equal(api.describeBrowserLevelShortcut("Alt+ArrowLeft"), "");
});

test("a recorded key combination replays through page.keyboard.press", () => {
  const events = buildWorkedExampleTrace();
  const ctrlF = { ...events[events.length - 1] };
  ctrlF.index = events.length;
  ctrlF.type = "press-key";
  ctrlF.value = "Control+f";
  ctrlF.locator = null;

  const spec = api.generatePlaywrightSpec(SESSION, [...events, ctrlF], []);

  assert.ok(spec.includes("await page.keyboard.press('Control+f');"),
    `the key combination did not reach the spec:\n${spec}`);
  assert.ok(spec.includes("browser chrome, not part of the page"),
    "the honest warning did not reach the spec");
});

// -----------------------------------------------------------------------------
// A scoped row locator must never carry an absolute path
//
// A real session on OrangeHRM generated this for a delete button in a table:
//
//   page.getByRole('row').filter({hasText:'X'}).locator('xpath=/html/body/...')
//
// It matches ZERO elements. Playwright evaluates the XPath from the scope
// element, and a path starting at /html finds nothing inside a row. Measured in
// a real browser, not reasoned about. Two steps of that script would have timed
// out on replay while reading as perfectly plausible code.
// -----------------------------------------------------------------------------

test("a css-path is cut at the row boundary so the scope still works", () => {
  const relative = api.makePathRelativeToRow({
    strategy: "css-path",
    value: 'div[role="rowgroup"] > div:nth-of-type(27) > div[role="row"] > div[role="cell"] > div > button[type="button"]',
    matchCount: 2,
  }, "row");

  assert.equal(relative, 'div[role="cell"] > div > button[type="button"]',
    "the part after the row is what can be scoped to the row");
});

test("an xpath is never cut, because half-parsing one is worse than not trying", () => {
  const relative = api.makePathRelativeToRow({
    strategy: "xpath",
    value: "/html/body/div/div[1]/div[2]/div[27]/div/div[4]/div/button[1]",
    matchCount: 1,
  }, "row");

  assert.equal(relative, "",
    "an empty result is the signal to fall back to the unscoped path");
});

test("no generated locator ever chains an absolute path under a scope", () => {
  const events = buildWorkedExampleTrace();
  const inRow = { ...events[events.length - 1] };
  inRow.index = events.length;
  inRow.type = "click";
  inRow.locator = {
    strategy: "xpath",
    primary: { strategy: "xpath", value: "/html/body/div/div[27]/button[1]", matchCount: 1 },
    fallbacks: [{
      strategy: "css-path",
      value: 'div[role="rowgroup"] > div:nth-of-type(27) > div[role="row"] > div[role="cell"] > button',
      matchCount: 2,
    }],
    framePath: [],
    isInShadowDom: false,
    isClosedShadowHost: false,
    shadowHostSelectors: [],
    isInsideRepeatedList: true,
    listRowRole: "row",
    listRowAnchorText: "TRA-e2e-1",
    ariaRole: "",
    accessibleName: "",
    visibleText: "",
    warnings: [],
  };

  const spec = api.generatePlaywrightSpec(SESSION, [...events, inRow], []);

  // The row scope survives...
  assert.ok(spec.includes(".filter({ hasText: 'TRA-e2e-1' })"),
    `the row scope was lost:\n${spec}`);
  // ...and what follows it is relative, never document-rooted.
  assert.ok(!/filter\(\{ hasText: [^)]*\}\)\.locator\('xpath=\//.test(spec),
    `an absolute xpath was chained under a scope, which matches nothing:\n${spec}`);
  assert.ok(!/filter\(\{ hasText: [^)]*\}\)\.locator\('\/html/.test(spec),
    `an absolute path was chained under a scope:\n${spec}`);
});

// -----------------------------------------------------------------------------
// Everything the tester does directly
//
// "Any press the user makes directly gets recorded in the script and the
// report." Clicks and typing were there from the start; right-click,
// middle-click, paste, drag and pointer movement were not, and none of them
// appeared anywhere - not as a step, not as a comment, not as evidence.
// -----------------------------------------------------------------------------

/** A locator that renders to a plain page.locator(...) expression. */
function cssLocator(selector) {
  return {
    strategy: "css-path",
    primary: { strategy: "css-path", value: selector, matchCount: 1 },
    fallbacks: [],
    framePath: [],
    isInShadowDom: false,
    isClosedShadowHost: false,
    shadowHostSelectors: [],
    isInsideRepeatedList: false,
    listRowRole: "",
    listRowAnchorText: "",
    ariaRole: "",
    accessibleName: "",
    visibleText: "",
    warnings: [],
  };
}

function specWith(...extraEvents) {
  const base = buildWorkedExampleTrace();
  const events = [...base];
  for (let i = 0; i < extraEvents.length; i += 1) {
    events.push({ ...extraEvents[i], index: base.length + i });
  }
  return api.generatePlaywrightSpec(SESSION, events, []);
}

test("typing replays as real key events, not as fill", () => {
  const spec = specWith(makeEvent(0, "input", {
    locator: cssLocator("#tenant"),
    value: "TN-40192",
  }));

  // fill() sets the value and fires ONE input event. An autocomplete that fires
  // on the third character, a validator that runs on keyup, a mask that rejects
  // the tenth - none of them happen under fill(), so a spec built from fill()
  // can pass on the very defect it was recorded to demonstrate.
  assert.ok(spec.includes(".pressSequentially('TN-40192', { delay: 60 })"),
    `typing must replay key by key:\n${spec}`);
});

test("a right-click replays, and says the menu is out of reach", () => {
  const spec = specWith(makeEvent(0, "right-click", {
    locator: cssLocator(".row"),
  }));
  assert.ok(spec.includes(".click({ button: 'right' })"));
  assert.ok(spec.includes("browser chrome, not part of the page"),
    "the context menu cannot be interacted with, and the script must say so");
});

test("a middle-click replays and warns about the new tab", () => {
  const spec = specWith(makeEvent(0, "middle-click", {
    locator: cssLocator("a.link"),
  }));
  assert.ok(spec.includes(".click({ button: 'middle' })"));
  assert.ok(spec.includes("waitForEvent('page')"));
});

test("a paste replays as fill, deliberately, and says why", () => {
  const spec = specWith(makeEvent(0, "paste", {
    locator: cssLocator("#tenant"),
    value: "TN-40192",
  }));
  // The opposite choice from typing, for the same reason: reproduce what the
  // tester actually did. A paste sets the value in one step.
  assert.ok(spec.includes(".fill('TN-40192')"));
  assert.ok(spec.includes("PASTED this rather than typing it"));
});

test("a pasted secret never reaches the script", () => {
  const spec = specWith(makeEvent(0, "paste", {
    locator: cssLocator("#password"),
    value: "[REDACTED:password]",
    valueWasRedacted: true,
  }));
  assert.ok(!spec.includes("[REDACTED:password]"),
    "the redaction marker itself should not be pasted into the script");
  assert.ok(spec.includes("process.env.TEST_SECRET_VALUE"));
});

test("a drag replays as one dragTo", () => {
  const spec = specWith(makeEvent(0, "drag-drop", {
    locator: cssLocator(".card-3"),
    dropTargetLocator: cssLocator(".column-done"),
    value: "100,200 -> 400,220",
  }));
  assert.ok(spec.includes(".dragTo("), `no dragTo:\n${spec}`);
  assert.ok(spec.includes(".column-done"));
});

test("a drag with no identifiable target says so instead of guessing", () => {
  const spec = specWith(makeEvent(0, "drag-drop", {
    locator: cssLocator(".card-3"),
    dropTargetLocator: null,
    value: "100,200 -> 400,220",
  }));
  assert.ok(spec.includes("could not be identified"));
  assert.ok(!spec.includes(".dragTo("),
    "a dragTo with an invented target is worse than an honest comment");
});

test("pointer movement is evidence, not a step", () => {
  const spec = specWith(makeEvent(0, "mouse-path", {
    value: "10,10 60,40 120,90 300,200",
  }));
  assert.ok(spec.includes("4 points"), `no path summary:\n${spec}`);
  assert.ok(spec.includes("changes nothing on the page"),
    "movement must not be emitted as a replayable statement");
  assert.ok(!spec.includes("page.mouse.move"),
    "replaying every sampled point would make the script unreadable");
});

test("the path summary reports distance, which is the part that means something", () => {
  // A long path before a click says the tester could not find the control.
  assert.equal(api.describeMousePath("0,0 300,400"), "2 points, 500px travelled");
  assert.equal(api.describeMousePath("5,5"), "no movement");
});

test("corrections while typing are surfaced", () => {
  const note = api.describeKeystrokeCorrections(
    ["A", "d", "m", "n", "Backspace", "i", "n"]);
  assert.match(note, /corrected themselves 1 time/);
  assert.match(note, /Backspace/,
    "the actual keys have to be there, or the note cannot be acted on");

  assert.equal(api.describeKeystrokeCorrections(["A", "d"]), "",
    "clean typing needs no note");
  assert.equal(api.describeKeystrokeCorrections([]), "");
});

// -----------------------------------------------------------------------------
// The tester's own pace
//
// "I want the script to replay as if going back in time." A replay at machine
// speed is a different test from the one that was recorded: a token that
// expires after ten seconds, a debounce that settles after two, a toast that
// vanishes after five - none of them happen when every step runs 40ms after
// the last.
// -----------------------------------------------------------------------------

test("the real gap between actions is reproduced", () => {
  const a = makeEvent(0, "click", { locator: cssLocator("#one"), wallClockMs: 10000 });
  const b = makeEvent(1, "click", { locator: cssLocator("#two"), wallClockMs: 14500 });
  const spec = api.generatePlaywrightSpec(SESSION, [a, b], []);

  assert.ok(spec.includes("await waitLikeTheTesterDid(4500)"),
    `the 4.5s the tester waited was not reproduced:\n${spec}`);
});

test("a gap too short to matter is left to the viewing pause", () => {
  const a = makeEvent(0, "click", { locator: cssLocator("#one"), wallClockMs: 10000 });
  const b = makeEvent(1, "click", { locator: cssLocator("#two"), wallClockMs: 10150 });
  const spec = api.generatePlaywrightSpec(SESSION, [a, b], []);

  assert.ok(!spec.includes("waitLikeTheTesterDid(150)"),
    "a 150ms gap is noise, not pacing");
});

test("an interruption is capped, and the real figure kept in a comment", () => {
  // Someone answered the phone. Their spec must not become a four-minute pause,
  // and the reader must still be able to put the real wait back.
  const a = makeEvent(0, "click", { locator: cssLocator("#one"), wallClockMs: 10000 });
  const b = makeEvent(1, "click", { locator: cssLocator("#two"), wallClockMs: 250000 });
  const spec = api.generatePlaywrightSpec(SESSION, [a, b], []);

  assert.ok(spec.includes("await waitLikeTheTesterDid(15000)"),
    "the gap was not capped");
  assert.ok(spec.includes("actually waited 240s here"),
    "the real figure has to survive the cap, or it is lost");
});

test("CI can switch the pacing off without editing the file", () => {
  const spec = api.generatePlaywrightSpec(SESSION, buildWorkedExampleTrace(), []);
  assert.ok(spec.includes("process.env.REPLAY_SPEED ?? 1"));
  assert.ok(spec.includes("if (replaySpeed <= 0)"),
    "REPLAY_SPEED=0 must skip the wait entirely, not divide by zero");
});
