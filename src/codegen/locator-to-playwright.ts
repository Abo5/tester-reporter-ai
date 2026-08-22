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
    // getByTestId reads far better in a spec a non-developer has to understand
    // than a raw attribute selector does.
    const rawId: string = extractTestIdValue(candidate.value);
    if (rawId !== "") {
      return ".getByTestId(" + quote(rawId) + ")";
    }
    return ".locator(" + quote(candidate.value) + ")";
  }

  if (candidate.strategy === "role-and-name") {
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
  const frameChain: string = buildFrameChainExpression(locator.framePath);

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
        + fallback.value);
    }
  }

  if (locator.strategy === "role-and-name" || locator.strategy === "exact-text"
      || locator.strategy === "label" || locator.strategy === "placeholder") {
    comments.push(
      "// This locator matches the text as it was rendered during recording. "
      + "Re-record or edit it for the other language build.");
  }

  if (locator.isInShadowDom) {
    comments.push(
      "// This element is inside an open shadow root. Playwright's selectors "
      + "pierce open shadow roots automatically.");
  }

  if (locator.isInsideRepeatedList && locator.listRowAnchorText === "") {
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
