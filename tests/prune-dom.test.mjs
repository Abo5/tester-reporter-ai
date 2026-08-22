// =============================================================================
// tests/prune-dom.test.mjs
//
// THE ACCEPTANCE TEST for the whole page-code-capture design lives here.
//
// The product exists to produce a report like this one:
//
//   Current Behavior: The tabs read "Initiating the Rental Relationship",
//   "Contract Renewal & Continuation", ...
//
// The model can only write that sentence if the pruned DOM still contains every
// tab label, verbatim. If a change to the pruning policy breaks this test, the
// change is wrong, however much smaller it makes the output.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./dom-setup.mjs";

const CATALOG_PAGE = `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <title>Service Catalog</title>
    <script>window.analytics = {};</script>
    <style>.x { color: red }</style>
  </head>
  <body>
    <div><div><div>
      <div role="tablist" class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none">
        <button role="tab" class="css-1x2y3z4" aria-selected="true">Initiating the Rental Relationship</button>
        <button role="tab" class="css-1x2y3z4">Contract Renewal &amp; Continuation</button>
        <button role="tab" class="css-1x2y3z4">Managing Contract Parties &amp; Authorizations</button>
        <button role="tab" class="css-1x2y3z4">Ending the Rental Relationship</button>
      </div>
    </div></div></div>

    <svg viewBox="0 0 24 24" aria-label="Search icon">
      <path d="M10 2a8 8 0 105.293 14.707l4 4a1 1 0 001.414-1.414l-4-4A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z"></path>
    </svg>

    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="Logo" />

    <div id="gtm-container" data-widget="googletagmanager">tracking noise</div>

    <div id="hidden-error" style="display:none">Tenant ID must be 8 digits</div>

    <input type="password" name="userPassword" value="hunter2secret" />

    <iframe src="https://payments.example.sa/widget" name="payments"></iframe>
  </body>
</html>`;

test("the pruned DOM keeps every category tab label verbatim", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");

  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  const expectedLabels = [
    "Initiating the Rental Relationship",
    "Contract Renewal &amp; Continuation",
    "Managing Contract Parties &amp; Authorizations",
    "Ending the Rental Relationship",
  ];

  for (const label of expectedLabels) {
    assert.ok(
      result.prunedHtml.includes(label),
      `The pruned DOM lost the tab label: ${label}`,
    );
  }

  // Order matters: the report lists them in the order they appear on screen.
  let cursor = -1;
  for (const label of expectedLabels) {
    const position = result.prunedHtml.indexOf(label);
    assert.ok(position > cursor, `Tab labels are out of order at: ${label}`);
    cursor = position;
  }
});

test("the pruned DOM keeps role and ARIA state on the tabs", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(result.prunedHtml.includes('role="tablist"'));
  assert.ok(result.prunedHtml.includes('role="tab"'));
  assert.ok(result.prunedHtml.includes('aria-selected="true"'));
});

test("the pruned DOM records the document language and direction", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(result.prunedHtml.startsWith('<document lang="en" dir="ltr"'));
  assert.ok(result.prunedHtml.includes('title="Service Catalog"'));
});

test("the pruner drops scripts, styles, SVG path data and tracking widgets", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(!result.prunedHtml.includes("window.analytics"));
  assert.ok(!result.prunedHtml.includes("color: red"));
  assert.ok(!result.prunedHtml.includes("M10 2a8 8 0"), "SVG path data survived");
  assert.ok(!result.prunedHtml.includes("tracking noise"), "tracking widget survived");
  assert.ok(result.droppedElementCount > 0);
});

test("the pruner strips base64 data URIs but keeps the image element", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(!result.prunedHtml.includes("iVBORw0KGgo"), "base64 image survived");
  assert.ok(result.prunedHtml.includes('src="data:[stripped]"'));
  assert.ok(result.prunedHtml.includes('alt="Logo"'));
});

test("a hidden element WITH text is kept and tagged, because it is often the bug", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(
    result.prunedHtml.includes("Tenant ID must be 8 digits"),
    "the hidden error message was dropped; it is exactly the kind of thing the "
      + "AI needs to see",
  );
  assert.ok(result.prunedHtml.includes('data-qa-hidden="true"'));
});

test("the pruner keeps the iframe tag but does not recurse into it", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(result.prunedHtml.includes("<iframe"));
  assert.ok(result.prunedHtml.includes("payments.example.sa/widget"));
});

test("the pruner truncates Tailwind class soup instead of dropping the element", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  assert.ok(result.prunedHtml.includes("flex items-center"), "class hint lost");
  assert.ok(
    !result.prunedHtml.includes("focus-visible:outline-none"),
    "the full class attribute survived; it should have been truncated",
  );
});

test("the pruner honours its total character budget", async () => {
  installDom(CATALOG_PAGE);
  const api = await import("../dist-test/test-api.mjs");

  const tightOptions = { ...api.DEFAULT_PRUNE_OPTIONS, maxTotalCharacters: 200 };
  const result = api.pruneDomForAI(document, tightOptions);

  assert.equal(result.wasTruncated, true);
  assert.ok(result.prunedHtml.includes("BUDGET EXHAUSTED"));
});

test("collapsible wrapper divs are removed", async () => {
  installDom(`<html><body><div><div><div><p>Real content</p></div></div></div></body></html>`);
  const api = await import("../dist-test/test-api.mjs");
  const result = api.pruneDomForAI(document, api.DEFAULT_PRUNE_OPTIONS);

  const divCount = (result.prunedHtml.match(/<div/g) ?? []).length;
  assert.ok(divCount <= 1, `expected wrappers to collapse, saw ${divCount} divs`);
  assert.ok(result.prunedHtml.includes("Real content"));
});

test("the pruned snapshot NEVER exceeds its budget, marker included", async () => {
  // The overflow marker used to be appended without being counted, so a
  // snapshot could exceed the documented budget by the marker's own length.
  // Found on the real OrangeHRM login page: 40,021 characters against 40,000.
  // The budget is a promise the token estimate and the request size depend on.
  const rows = Array.from({ length: 400 }, (_, i) =>
    `<tr><td>Tenant ${i}</td><td>Contract number ${i}</td>
     <td>Some status text for row ${i}</td></tr>`).join("");
  installDom(`<html><body><table><tbody>${rows}</tbody></table></body></html>`);
  const api = await import("../dist-test/test-api.mjs");

  for (const budget of [500, 2000, 40000, api.MAX_SNAPSHOT_CHARACTERS]) {
    const result = api.pruneDomForAI(document, {
      ...api.DEFAULT_PRUNE_OPTIONS,
      maxTotalCharacters: budget,
    });
    assert.ok(result.prunedHtml.length <= budget,
      `budget ${budget} overrun by ${result.prunedHtml.length - budget} chars`);
    assert.equal(result.characterCount, result.prunedHtml.length,
      "characterCount must match the string it describes");
    if (result.wasTruncated) {
      assert.ok(result.prunedHtml.includes("BUDGET EXHAUSTED"),
        "a truncated snapshot must say so");
    }
  }
});
