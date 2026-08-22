// =============================================================================
// src/codegen/locator-to-playwright.ts
// Turns an ElementLocator into a Playwright locator EXPRESSION (a string), plus
// the comment lines that must accompany it.
//
// WHY comments and not silence: a junior tester reading a failing spec needs to
// know why it is failing and what alternatives they can try. A locator with no
// explanation is a dead end for exactly the person this tool is aimed at.
// =============================================================================

import type { ElementLocator, LocatorCandidate, FrameStep } from "../shared/types";

/**
 * The role names Playwright's getByRole() accepts.
 *
 * Its parameter is a union type, not a string, so emitting a role the page
 * invented produces a spec that does not typecheck - red squiggles in the
 * tester's editor before they have changed a thing.
 */
const ARIA_ROLES: readonly string[] = [
  "alert", "alertdialog", "application", "article", "banner", "blockquote",
  "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "deletion", "dialog",
  "directory", "document", "emphasis", "feed", "figure", "form", "generic",
  "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation",
  "none", "note", "option", "paragraph", "presentation", "progressbar",
  "radio", "radiogroup", "region", "row", "rowgroup", "rowheader",
  "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton",
  "status", "strong", "subscript", "superscript", "switch", "tab", "table",
  "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar",
  "tooltip", "tree", "treegrid", "treeitem",
];

/**
 * Escapes a string for embedding in a single-quoted TypeScript literal.
 *
 * WHY it is not optional: Arabic labels and tenant names contain apostrophes
 * often enough that skipping this produces a spec that does not compile.
 */
export function escapeForSingleQuotedString(value: string): string {
  let escaped: string = "";
  for (let index = 0; index < value.length; index = index + 1) {
    const character: string = value.charAt(index);
    if (character === "'") {
      escaped = escaped + "\\'";
    } else if (character === "\\") {
      escaped = escaped + "\\\\";
    } else if (character === "\n") {
      escaped = escaped + "\\n";
    } else if (character === "\r") {
      escaped = escaped + "\\r";
    } else {
      escaped = escaped + character;
    }
  }
  return escaped;
}

/** Wraps a value in single quotes, escaping as needed. */
export function quote(value: string): string {
  return "'" + escapeForSingleQuotedString(value) + "'";
}

/**
 * Pulls the ATTRIBUTE NAME out of a [data-testid="x"] style selector.
 * Returns "" when the selector is not in that shape.
 */
function extractTestIdAttributeName(attributeSelector: string): string {
  if (!attributeSelector.startsWith("[")) {
    return "";
  }
  const equalsIndex: number = attributeSelector.indexOf("=");
  if (equalsIndex === -1) {
    return "";
  }
  return attributeSelector.slice(1, equalsIndex).trim();
}

/**
 * Pulls the raw id out of a [data-testid="x"] style selector.
 * Returns "" when the selector is not in that shape.
 */
function extractTestIdValue(attributeSelector: string): string {
  const openingQuote: number = attributeSelector.indexOf('="');
  const closingQuote: number = attributeSelector.lastIndexOf('"]');
  if (openingQuote === -1 || closingQuote === -1 || closingQuote <= openingQuote + 1) {
    return "";
  }
  return attributeSelector.slice(openingQuote + 2, closingQuote);
}

/**
 * Builds the chain of frameLocator() calls that reaches the element's frame.
 * Returns "page" when the element is in the top-level document.
 */
function buildFrameChainExpression(framePath: FrameStep[]): string {
  let expression: string = "page";
  for (let index = 0; index < framePath.length; index = index + 1) {
    expression = expression + ".frameLocator(" + quote(framePath[index].frameSelector) + ")";
  }
  return expression;
}

/**
 * Turns one candidate into the Playwright call that finds it.
 */
function candidateToExpression(candidate: LocatorCandidate): string {
  if (candidate.strategy === "test-id") {
    // getByTestId resolves against ONE attribute - data-testid unless the
    // project configures otherwise - so it is only correct when that is the
    // attribute we actually matched. For data-qa, data-cy and the rest, an
    // attribute selector is the honest choice: getByTestId would produce a
    // locator that matches nothing, in a spec that looks perfectly correct.
    const attributeName: string = extractTestIdAttributeName(candidate.value);
    const rawId: string = extractTestIdValue(candidate.value);

    if (attributeName === "data-testid" && rawId !== "") {
      return ".getByTestId(" + quote(rawId) + ")";
    }
    return ".locator(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "role-and-name") {
    // getByRole's parameter is a UNION of the ARIA role names, so a page using
    // a non-standard role attribute produced a spec that did not typecheck.
    // Fall back to naming the element instead of emitting something red in the
    // tester's editor.
    if (!ARIA_ROLES.includes(candidate.role)) {
      return ".getByText(" + quote(candidate.value) + ", { exact: true })";
    }
    return ".getByRole(" + quote(candidate.role)
      + ", { name: " + quote(candidate.value) + " })";
  }

  if (candidate.strategy === "label") {
    return ".getByLabel(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "placeholder") {
    return ".getByPlaceholder(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "alt-text") {
    return ".getByAltText(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "title") {
    return ".getByTitle(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "exact-text") {
    return ".getByText(" + quote(candidate.value) + ", { exact: true })";
  }

  if (candidate.strategy === "xpath") {
    return ".locator(" + quote("xpath=" + candidate.value) + ")";
  }

  return ".locator(" + quote(candidate.value) + ")";
}

/**
 * Builds the complete locator expression, including frames and list scoping.
 *
 * The list-scoping branch is what turns a meaningless positional locator into
 * the thing a human tester actually means: "the View button in the row for
 * tenant TN-40192".
 */
export function locatorToPlaywrightExpression(locator: ElementLocator): string {
  let frameChain: string = buildFrameChainExpression(locator.framePath);

  // Scope a structural locator to the shadow host that owns it.
  //
  // shadowHostSelectors was being recorded and then ignored, so a path measured
  // inside a shadow root was emitted as if it applied to the whole page.
  // Playwright's CSS engine pierces open shadow roots, so `button` matched
  // every button on the page rather than the one in the component.
  //
  // Role- and name-based locators do not need this: they identify the element
  // by what it is, wherever it lives.
  const needsShadowScope: boolean =
    locator.isInShadowDom
    && locator.shadowHostSelectors.length > 0
    && (locator.strategy === "css-path" || locator.strategy === "exact-text");

  if (needsShadowScope) {
    for (let index = 0; index < locator.shadowHostSelectors.length;
         index = index + 1) {
      frameChain = frameChain
        + ".locator(" + quote(locator.shadowHostSelectors[index]) + ")";
    }
  }

  if (locator.isInsideRepeatedList
      && locator.listRowAnchorText !== ""
      && locator.listRowRole !== "") {
    const rowExpression: string =
      frameChain
      + ".getByRole(" + quote(locator.listRowRole) + ")"
      + ".filter({ hasText: " + quote(locator.listRowAnchorText) + " })";

    // Inside a scoped row, a role+name or text locator is unambiguous even when
    // it was not unique across the whole page.
    if (locator.ariaRole !== "" && locator.accessibleName !== "") {
      return rowExpression + ".getByRole(" + quote(locator.ariaRole)
        + ", { name: " + quote(locator.accessibleName) + " })";
    }
    if (locator.visibleText !== "") {
      return rowExpression + ".getByText(" + quote(locator.visibleText) + ", { exact: true })";
    }
    return rowExpression + candidateToExpression(locator.primary);
  }

  return frameChain + candidateToExpression(locator.primary);
}

/**
 * Collapses a value onto one line so it cannot break out of a // comment.
 *
 * A locator built from an element whose visible text contains a newline - a
 * multi-line button label, a table cell with a <br> - put that newline straight
 * into a comment, so everything after it became code. The spec then failed to
 * parse, which is a confusing way to discover a formatting bug.
 */
function toSingleLine(value: string): string {
  let collapsed: string = "";
  for (let index = 0; index < value.length; index = index + 1) {
    const character: string = value.charAt(index);
    if (character === "\n" || character === "\r") {
      collapsed = collapsed + " ";
    } else {
      collapsed = collapsed + character;
    }
  }
  return collapsed;
}

/**
 * Produces the comment lines that must accompany a locator, if any.
 */
export function buildLocatorComments(locator: ElementLocator): string[] {
  const comments: string[] = [];

  if (locator.isClosedShadowHost) {
    comments.push(
      "// NOTE: this component uses a CLOSED shadow root. Playwright cannot "
      + "reach inside it; this locator targets the host element only.");
  }

  if (locator.strategy === "css-path" || locator.strategy === "xpath") {
    comments.push(
      "// FRAGILE: no test id, accessible name or unique text was available "
      + "for this element.");
    const shown: number = Math.min(2, locator.fallbacks.length);
    for (let index = 0; index < shown; index = index + 1) {
      const fallback: LocatorCandidate = locator.fallbacks[index];
      comments.push(
        "//   Alternative (" + fallback.strategy + ", matched "
        + String(fallback.matchCount) + " element(s) when recorded): "
        + toSingleLine(fallback.value));
    }
  }

  // Text-based locators embed the rendered string, so they will not match the
  // other language build. A test id will, which is exactly why it ranks first.
  const isTextBased: boolean =
    locator.strategy === "role-and-name" || locator.strategy === "exact-text"
    || locator.strategy === "label" || locator.strategy === "placeholder"
    || locator.strategy === "alt-text" || locator.strategy === "title";

  if (isTextBased) {
    comments.push(
      "// This locator matches the text as it was rendered during recording. "
      + "Re-record or edit it for the other language build.");
  }

  if (locator.isInShadowDom) {
    comments.push(
      "// This element is inside an open shadow root. Playwright's selectors "
      + "pierce open shadow roots automatically.");
  }

  // Only warn when the locator really IS positional. An element that sits among
  // siblings but carries a unique test id, accessible name or unique text is
  // not positional at all, and a false warning on the most reliable locator we
  // have teaches testers to ignore warnings.
  const isPositional: boolean =
    locator.isInsideRepeatedList
    && locator.listRowAnchorText === ""
    && (locator.strategy === "css-path" || locator.strategy === "xpath");

  if (isPositional) {
    comments.push(
      "// WARNING: positional locator inside a list. This targets whatever is "
      + "in that position, which may not be the same row after the data changes.");
  }

  if (locator.framePath.length > 0) {
    comments.push(
      "// This element is inside " + String(locator.framePath.length)
      + " nested frame(s). If the frame selector is wrong, check the page for "
      + "several iframes sharing one src.");
  }

  if (!locator.primary.isUniqueAtCaptureTime && !locator.isInsideRepeatedList) {
    comments.push(
      "// WARNING: this locator matched " + String(locator.primary.matchCount)
      + " elements when it was recorded. Add .first() or make it more specific "
      + "if the test turns out to be ambiguous.");
  }

  return comments;
}
