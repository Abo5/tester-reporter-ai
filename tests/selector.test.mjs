// =============================================================================
// tests/selector.test.mjs
// The selector chain is the hardest part of the extension, so it gets the most
// specific tests: the ordering of the fallback chain, the refusal to use class
// names, and the list-row anchoring that turns a meaningless .nth(2) into
// "the row for tenant TN-40192".
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./dom-setup.mjs";

test("a test id beats everything else", async () => {
  installDom(`<html><body>
    <button data-testid="save-button" class="css-1a2b3c">Save</button>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("button");
  const locator = api.getElementSelector(element);

  assert.equal(locator.strategy, "test-id");
  assert.equal(locator.primary.value, '[data-testid="save-button"]');
  assert.equal(locator.primary.isUniqueAtCaptureTime, true);
});

test("role and accessible name are used when there is no test id", async () => {
  installDom(`<html><body>
    <div role="tablist">
      <button role="tab">Contract Renewal &amp; Continuation</button>
      <button role="tab">Ending the Rental Relationship</button>
    </div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelectorAll("button")[0];
  const locator = api.getElementSelector(element);

  assert.equal(locator.strategy, "role-and-name");
  assert.equal(locator.primary.role, "tab");
  assert.equal(locator.primary.value, "Contract Renewal & Continuation");
});

test("a form control uses its label", async () => {
  installDom(`<html><body>
    <label for="tenant">Tenant ID</label>
    <input id="tenant" type="text" />
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("input");
  const locator = api.getElementSelector(element);

  // getByRole('textbox', { name: 'Tenant ID' }) and getByLabel('Tenant ID') are
  // both correct here; either is acceptable as long as it is name-based and not
  // a CSS path.
  assert.ok(
    locator.strategy === "label" || locator.strategy === "role-and-name",
    `expected a name-based locator, got ${locator.strategy}`,
  );
  assert.equal(locator.primary.value, "Tenant ID");
});

test("class names never appear in any locator candidate", async () => {
  installDom(`<html><body>
    <div class="css-1x2y3z4 flex items-center gap-2 rounded-md px-3">
      <span class="emotion-9f8e7d">Untitled</span>
    </div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("span");
  const locator = api.getElementSelector(element);

  const allCandidates = [locator.primary, ...locator.fallbacks];
  for (const candidate of allCandidates) {
    assert.ok(!candidate.value.includes("css-1x2y3z4"),
      `a generated class name leaked into a ${candidate.strategy} locator`);
    assert.ok(!candidate.value.includes("emotion-"),
      `a generated class name leaked into a ${candidate.strategy} locator`);
    assert.ok(!candidate.value.includes("items-center"),
      `a Tailwind utility class leaked into a ${candidate.strategy} locator`);
  }
});

test("framework-generated ids are rejected", async () => {
  const api = await import("../dist-test/test-api.mjs");

  assert.equal(api.looksLikeGeneratedIdentifier(":r3:"), true);
  assert.equal(api.looksLikeGeneratedIdentifier("mui-1842"), true);
  assert.equal(api.looksLikeGeneratedIdentifier("radix-:r7:"), true);
  assert.equal(api.looksLikeGeneratedIdentifier("field-a3f9c2b81e4d"), true);
  assert.equal(api.looksLikeGeneratedIdentifier("tenant-search"), false);
  assert.equal(api.looksLikeGeneratedIdentifier("submit"), false);
});

test("a non-unique locator is not promoted to primary", async () => {
  installDom(`<html><body>
    <button>View</button>
    <button>View</button>
    <button>View</button>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelectorAll("button")[1];
  const locator = api.getElementSelector(element);

  assert.equal(locator.primary.isUniqueAtCaptureTime, true,
    "the chosen locator should be one that actually resolved to one element");
});

test("an element inside a repeated list is anchored on unique row text", async () => {
  installDom(`<html><body>
    <div role="rowgroup">
      <div role="row"><span>TN-40190</span><button>View</button></div>
      <div role="row"><span>TN-40191</span><button>View</button></div>
      <div role="row"><span>TN-40192</span><button>View</button></div>
    </div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelectorAll("button")[2];
  const locator = api.getElementSelector(element);

  assert.equal(locator.isInsideRepeatedList, true);
  assert.equal(locator.listRowAnchorText, "TN-40192");
  assert.equal(locator.listRowRole, "row");

  const expression = api.locatorToPlaywrightExpression(locator);
  assert.ok(expression.includes("filter({ hasText: 'TN-40192' })"),
    `expected a row-scoped locator, got: ${expression}`);
});

test("an open shadow root is pierced by composedPath-style lookup", async () => {
  installDom(`<html><body><my-widget></my-widget></body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const host = document.querySelector("my-widget");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<button data-testid="inner-save">Save</button>`;

  const inner = root.querySelector("button");
  const locator = api.getElementSelector(inner);

  assert.equal(locator.isInShadowDom, true);
  assert.equal(locator.strategy, "test-id");
  assert.ok(locator.shadowHostSelectors.length >= 1);

  const comments = api.buildLocatorComments(locator);
  assert.ok(comments.some((line) => line.includes("open shadow root")),
    "the generated spec should explain the shadow DOM to the reader");
});

test("a fragile locator carries a FRAGILE comment and its alternatives", async () => {
  installDom(`<html><body>
    <section><div><div><b>x</b></div></div></section>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("b");
  const locator = api.getElementSelector(element);
  const comments = api.buildLocatorComments(locator);

  if (locator.strategy === "css-path" || locator.strategy === "xpath") {
    assert.ok(comments.some((line) => line.includes("FRAGILE")));
  }
});

test("a text-based locator warns that it is language-specific", async () => {
  installDom(`<html><body>
    <div role="tablist"><button role="tab">Contract Renewal</button></div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("button");
  const locator = api.getElementSelector(element);
  const comments = api.buildLocatorComments(locator);

  assert.ok(
    comments.some((line) => line.includes("other language build")),
    "an EN/AR app needs this warning: a spec recorded in English will not run "
      + "against the Arabic build",
  );
});

test("accessible name falls back through label, placeholder and value", async () => {
  installDom(`<html><body>
    <input id="a" aria-label="From aria" />
    <input id="b" placeholder="From placeholder" />
    <input id="c" type="submit" value="From value" />
    <img id="d" alt="From alt" />
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  assert.equal(api.getAccessibleName(document.getElementById("a")), "From aria");
  assert.equal(api.getAccessibleName(document.getElementById("b")), "From placeholder");
  assert.equal(api.getAccessibleName(document.getElementById("c")), "From value");
  assert.equal(api.getAccessibleName(document.getElementById("d")), "From alt");
});

test("visible text ignores hidden descendants", async () => {
  installDom(`<html><body>
    <button>Menu<span style="display:none">Item A Item B Item C</span></button>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelector("button");
  assert.equal(api.getVisibleText(element), "Menu",
    "a closed menu's items must not become part of the button's name");
});

test("element context captures ARIA state, lang, dir and siblings", async () => {
  installDom(`<html lang="ar" dir="rtl"><body>
    <div role="tablist">
      <button role="tab">Alpha</button>
      <button role="tab" aria-invalid="true" aria-describedby="err">Beta</button>
      <button role="tab">Gamma</button>
    </div>
    <p id="err">Tenant ID must be 8 digits</p>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelectorAll("button")[1];
  const context = api.captureElementContext(element);

  assert.equal(context.ariaState.ariaInvalid, "true");
  assert.equal(context.ariaState.ariaDescribedByText, "Tenant ID must be 8 digits");
  assert.equal(context.inheritedLang, "ar");
  assert.equal(context.inheritedDir, "rtl");
  assert.ok(context.ancestorHtml.includes('role="tablist"'));
  assert.equal(context.siblingHtml.length, 2);
  assert.ok(context.siblingHtml.join(" ").includes("Alpha"));
  assert.ok(context.siblingHtml.join(" ").includes("Gamma"));
});

test("an xpath candidate reports the match count it actually has", async () => {
  installDom(`<html><body>
    <div><span>one</span><span>two</span></div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const element = document.querySelectorAll("span")[1];
  const locator = api.getElementSelector(element);

  const xpath = [locator.primary, ...locator.fallbacks]
    .find((c) => c.strategy === "xpath");
  assert.ok(xpath, "no xpath candidate was produced");

  // The old code hardcoded matchCount 1 "by construction" without ever
  // evaluating the expression, which suppressed the ambiguity warning and made
  // an unverified path look checked.
  assert.equal(typeof xpath.matchCount, "number");
  assert.equal(xpath.isUniqueAtCaptureTime, xpath.matchCount === 1,
    "uniqueness must follow from the measured count, not be asserted");
});

test("a click on an icon inside a button resolves to the button", async () => {
  // Icon buttons are in essentially every modern application, and the pixel the
  // tester hits belongs to a decorative child with no role, no accessible name
  // and no test id. Recording that child produced .locator('path'), which is
  // useless, while the button beside it had all three.
  installDom(`<html><body>
    <button aria-label="Delete row" data-testid="delete-btn">
      <svg viewBox="0 0 24 24"><path d="M3 6h18"></path></svg>
    </button>
    <a href="/next"><span class="label">Continue</span></a>
    <div><p>just text</p></div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const iconPath = document.querySelector("path");
  const resolvedButton = api.resolveInteractiveTarget(iconPath);
  assert.equal(resolvedButton.tagName, "BUTTON",
    "the icon click should resolve to the button that owns it");

  const locator = api.getElementSelector(resolvedButton);
  assert.equal(locator.strategy, "test-id");
  assert.equal(locator.primary.value, '[data-testid="delete-btn"]');

  const linkSpan = document.querySelector("span.label");
  assert.equal(api.resolveInteractiveTarget(linkSpan).tagName, "A",
    "text inside a link should resolve to the link");
});

test("a click on genuinely non-interactive content is NOT retargeted", async () => {
  installDom(`<html><body><div><p id="plain">just text</p></div></body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const paragraph = document.getElementById("plain");
  assert.equal(api.resolveInteractiveTarget(paragraph).id, "plain",
    "there is no control above this, so it must be left where it landed");
});

test("a control nested inside another control is left alone", async () => {
  installDom(`<html><body>
    <div role="row"><button data-testid="inner">Open</button></div>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const button = document.querySelector("button");
  assert.equal(api.resolveInteractiveTarget(button).tagName, "BUTTON",
    "an element that is itself interactive must never be retargeted upward");
});

test("the pruner does not descend into SVG icon subtrees", async () => {
  installDom(`<html><body>
    <button><svg viewBox="0 0 24 24"><path d="M3 6h18"></path><circle cx="1"/></svg></button>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  // SVG elements report a LOWER-CASE tagName, so comparing against the
  // upper-case tag tables silently let whole icon subtrees through.
  assert.ok(!result.prunedHtml.includes("<path"),
    "SVG children leaked into the snapshot");
  assert.ok(!result.prunedHtml.includes("<circle"));
  assert.ok(result.prunedHtml.includes("<svg"),
    "the svg element itself should still be visible to the model");
});

test("a visually-hidden control is still described in the evidence", async () => {
  // A custom checkbox is almost always a visually-hidden <input> with a styled
  // <span> beside it. The pruner drops a hidden element with no text, which is
  // right for a page snapshot and wrong for elementHtml - the one field that
  // answers "what did the tester actually touch".
  installDom(`<html><body>
    <label>
      <input type="checkbox" id="agree" name="agree"
             style="position:absolute;opacity:0;width:1px;height:1px" />
      <span class="box"></span>
      <span class="text">I agree to the terms</span>
    </label>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const hiddenInput = document.getElementById("agree");
  const context = api.captureElementContext(hiddenInput);

  assert.ok(context.elementHtml.length > 0,
    "the hidden control produced NO evidence at all");
  assert.ok(context.elementHtml.includes('type="checkbox"'),
    `the control's type is missing: ${context.elementHtml}`);
  assert.ok(context.elementHtml.includes('name="agree"'),
    `the control's name is missing: ${context.elementHtml}`);
  assert.ok(context.ancestorHtml.includes("I agree to the terms"),
    "the visible label beside it should still be captured");
});

test("a structural locator inside a shadow root is scoped to its host", async () => {
  // Uniqueness was measured INSIDE the shadow root and then emitted as a
  // page-wide locator. Playwright's CSS engine pierces open shadow roots, so a
  // bare `button` that was unique among three siblings in the component matched
  // every button on the page.
  installDom(`<html><body>
    <header><button>Save</button><button>Cancel</button></header>
    <my-toolbar></my-toolbar>
  </body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  const host = document.querySelector("my-toolbar");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<div class="bar"><button></button></div>`;

  const inner = root.querySelector("button");
  const locator = api.getElementSelector(inner);

  assert.equal(locator.isInShadowDom, true);

  // XPath cannot pierce a shadow boundary in Playwright, so it must not be
  // offered as a candidate at all.
  const hasXPath = [locator.primary, ...locator.fallbacks]
    .some((c) => c.strategy === "xpath");
  assert.equal(hasXPath, false,
    "an xpath candidate inside a shadow root cannot resolve and must not be "
      + "offered");

  if (locator.strategy === "css-path") {
    assert.equal(locator.primary.isUniqueAtCaptureTime, false,
      "uniqueness measured inside the shadow root says nothing about the page");
    const expression = api.locatorToPlaywrightExpression(locator);
    assert.ok(expression.includes("my-toolbar"),
      `the expression must be scoped to the host: ${expression}`);
  }
});
