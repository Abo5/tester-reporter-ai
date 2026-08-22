// =============================================================================
// src/capture/selector.ts
// Builds an ElementLocator: every candidate we can produce, scored, best first.
//
// Pure functions only, no chrome.* APIs, so this file is unit-testable without
// loading the extension.
//
// THE RULE THAT MATTERS: class attributes are NEVER used to build a selector,
// at any level of the chain. Emotion produces "css-1x2y3z4", regenerated on
// every build; Tailwind produces forty utility classes that describe appearance
// rather than identity. Both are worthless as identifiers.
// =============================================================================

import type {
  ElementLocator,
  LocatorCandidate,
  LocatorStrategy,
} from "../shared/types";
import {
  getAriaRole,
  getAccessibleName,
  getVisibleText,
  getAssociatedLabelText,
  cssEscape,
  tagsForImplicitRole,
} from "./accessible-name";
import {
  MAX_VISIBLE_TEXT_CHARACTERS,
  MAX_CSS_PATH_DEPTH,
} from "../shared/constants";

/**
 * Ceilings that keep one interaction's locator work bounded.
 *
 * Capture runs synchronously inside the click handler, ahead of the
 * application's own listener, so an unbounded scan is felt as a freeze by the
 * tester. Giving up on an exact count is a slightly weaker locator; freezing the
 * page for seconds makes the tool unusable on exactly the large enterprise
 * pages it was built for.
 */
const MAX_TEXT_NODES_SCANNED: number = 4000;
const MAX_SIBLING_ROWS_SCANNED: number = 300;

/** Attributes a team may have used for test ids, in the order we trust them. */
const TEST_ID_ATTRIBUTES: readonly string[] = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "data-automation-id",
];

/** Attributes that are safe to build a CSS path from: stable and semantic. */
const STABLE_PATH_ATTRIBUTES: readonly string[] = [
  "name", "type", "role", "href", "for", "aria-label",
];

/** Roles that identify one row of a repeated collection. */
const REPEATED_ROW_ROLES: readonly string[] = [
  "row", "listitem", "option", "treeitem", "article", "gridcell",
];

/**
 * Escapes a string so it can sit inside a CSS attribute selector's quotes.
 * WHY: tenant names and Arabic labels routinely contain quotes and backslashes
 * that would otherwise produce an invalid selector.
 */
function escapeForCssAttributeValue(value: string): string {
  let escaped: string = "";
  for (let index = 0; index < value.length; index = index + 1) {
    const character: string = value.charAt(index);
    if (character === '"' || character === "\\") {
      escaped = escaped + "\\" + character;
    } else {
      escaped = escaped + character;
    }
  }
  return escaped;
}

/**
 * Returns the Document or ShadowRoot that owns the element.
 * WHY the root and not always `document`: for an element inside a shadow root
 * the correct scope for a uniqueness check is that shadow root.
 */
function getSearchRootFor(element: Element): Document | ShadowRoot {
  const root: Node = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return root;
  }
  return element.ownerDocument;
}

/**
 * Counts how many elements in the element's own root match a CSS selector.
 */
function countMatches(element: Element, cssSelector: string): number {
  if (cssSelector === "") {
    return 0;
  }
  const root: Document | ShadowRoot = getSearchRootFor(element);
  try {
    return root.querySelectorAll(cssSelector).length;
  } catch (invalidSelectorError: unknown) {
    // An unescapable selector counts as "no match", never as unique.
    return 0;
  }
}

/**
 * Builds the test-id candidate, or null when the element has no test id.
 */
function buildTestIdCandidate(element: Element): LocatorCandidate | null {
  for (let index = 0; index < TEST_ID_ATTRIBUTES.length; index = index + 1) {
    const attributeName: string = TEST_ID_ATTRIBUTES[index];
    const attributeValue: string | null = element.getAttribute(attributeName);
    if (attributeValue !== null && attributeValue.trim() !== "") {
      const selector: string =
        "[" + attributeName + '="' + escapeForCssAttributeValue(attributeValue) + '"]';
      const matchCount: number = countMatches(element, selector);
      return {
        strategy: "test-id",
        value: selector,
        role: "",
        matchCount: matchCount,
        isUniqueAtCaptureTime: matchCount === 1,
      };
    }
  }
  return null;
}

/**
 * Counts elements in the same root with the same role AND accessible name.
 * WHY we compute it ourselves: there is no querySelector for "role + name", and
 * we need the count to know whether the locator will be ambiguous at replay.
 */
function countElementsWithRoleAndName(
  element: Element,
  role: string,
  accessibleName: string,
): number {
  const root: Document | ShadowRoot = getSearchRootFor(element);

  // Narrow with a native query before computing anything expensive. Scanning
  // every element and resolving its accessible name meant getComputedStyle ran
  // over most of the document inside the click handler, ahead of the
  // application's own listener.
  const selectors: string[] = ['[role="' + role + '"]'];
  const implicitTags: string[] = tagsForImplicitRole(role);
  for (let index = 0; index < implicitTags.length; index = index + 1) {
    selectors.push(implicitTags[index]);
  }

  let candidates: NodeListOf<Element>;
  try {
    candidates = root.querySelectorAll(selectors.join(","));
  } catch (selectorError: unknown) {
    return 0;
  }

  let count: number = 0;
  for (let index = 0; index < candidates.length; index = index + 1) {
    const candidate: Element = candidates[index];
    if (getAriaRole(candidate) !== role) {
      continue;   // An explicit role attribute can override the implicit one.
    }
    if (getAccessibleName(candidate) === accessibleName) {
      count = count + 1;
    }
  }
  return count;
}

/**
 * Builds the role+accessible-name candidate, or null when either is missing.
 */
function buildRoleAndNameCandidate(element: Element): LocatorCandidate | null {
  const role: string = getAriaRole(element);
  const accessibleName: string = getAccessibleName(element);
  if (role === "" || accessibleName === "") {
    return null;
  }
  if (accessibleName.length > MAX_VISIBLE_TEXT_CHARACTERS) {
    return null;
  }
  const matchCount: number =
    countElementsWithRoleAndName(element, role, accessibleName);
  return {
    strategy: "role-and-name",
    value: accessibleName,
    role: role,
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Counts form controls in the same root that share a label text.
 */
function countFormControlsWithLabel(element: Element, labelText: string): number {
  const root: Document | ShadowRoot = getSearchRootFor(element);
  const controls: NodeListOf<Element> = root.querySelectorAll("input, textarea, select");
  let count: number = 0;
  for (let index = 0; index < controls.length; index = index + 1) {
    if (getAssociatedLabelText(controls[index]) === labelText) {
      count = count + 1;
    }
  }
  return count;
}

/**
 * Builds the label candidate for form controls.
 */
function buildLabelCandidate(element: Element): LocatorCandidate | null {
  const isFormControl: boolean =
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT";
  if (!isFormControl) {
    return null;
  }
  const labelText: string = getAssociatedLabelText(element);
  if (labelText === "" || labelText.length > MAX_VISIBLE_TEXT_CHARACTERS) {
    return null;
  }
  const matchCount: number = countFormControlsWithLabel(element, labelText);
  return {
    strategy: "label",
    value: labelText,
    role: "",
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Builds a simple attribute-based candidate for placeholder / alt / title.
 */
function buildAttributeCandidate(
  element: Element,
  attributeName: string,
  strategy: LocatorStrategy,
): LocatorCandidate | null {
  const attributeValue: string | null = element.getAttribute(attributeName);
  if (attributeValue === null || attributeValue.trim() === "") {
    return null;
  }
  const trimmedValue: string = attributeValue.trim();
  if (trimmedValue.length > MAX_VISIBLE_TEXT_CHARACTERS) {
    return null;
  }
  const selector: string =
    "[" + attributeName + '="' + escapeForCssAttributeValue(trimmedValue) + '"]';
  const matchCount: number = countMatches(element, selector);
  return {
    strategy: strategy,
    value: trimmedValue,
    role: "",
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Counts elements whose own visible text equals the given text.
 */
function countElementsWithExactText(element: Element, text: string): number {
  const root: Document | ShadowRoot = getSearchRootFor(element);

  // Search from the TEXT NODES up, not from every element down.
  //
  // The element-first version called textContent on all of them, and
  // textContent on a <table> or a <tbody> builds a string of the entire
  // subtree. On a 600-row table that is thousands of large string
  // concatenations for one click, and a single locator took several SECONDS -
  // a freeze the tester would feel, in the click handler, before the page's own
  // handler ran.
  // element.ownerDocument works for a light-DOM element and for one inside a
  // shadow root alike, and avoids depending on `Document` being a global - it
  // is not, in every context this file is exercised from.
  const ownerDocument: Document = element.ownerDocument;

  // 4 is NodeFilter.SHOW_TEXT, spelled out for the same reason.
  const walker: TreeWalker =
    ownerDocument.createTreeWalker(root as unknown as Node, 4, null);

  const seen: Set<Element> = new Set<Element>();
  let count: number = 0;
  let visited: number = 0;

  while (walker.nextNode() !== null) {
    visited = visited + 1;
    if (visited > MAX_TEXT_NODES_SCANNED) {
      break;   // Give up counting rather than freeze the page.
    }

    const textNode: Node | null = walker.currentNode;
    if (textNode === null || (textNode.textContent ?? "").trim() === "") {
      continue;
    }
    if (!text.includes((textNode.textContent ?? "").trim())
        && !(textNode.textContent ?? "").includes(text)) {
      continue;
    }

    // Only the text node's own element, and wrappers around it, can have this
    // as their WHOLE visible text. Stop climbing as soon as an ancestor has
    // more than one element child: a <tbody> with 600 rows cannot have "View"
    // as its visible text, and asking costs a walk of the entire table.
    let candidate: Element | null = textNode.parentElement;
    let depth: number = 0;
    while (candidate !== null && depth < 3) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        if (getVisibleText(candidate) === text) {
          count = count + 1;
        }
      }
      if (candidate.childElementCount > 1) {
        break;
      }
      candidate = candidate.parentElement;
      depth = depth + 1;
    }
  }

  return count;
}

/**
 * Builds the exact-visible-text candidate for short text elements.
 * WHY the length cap: getByText with a 400-character paragraph is unreadable in
 * a spec and matches nothing reliably.
 */
function buildExactTextCandidate(element: Element): LocatorCandidate | null {
  const visibleText: string = getVisibleText(element);
  if (visibleText === "" || visibleText.length > MAX_VISIBLE_TEXT_CHARACTERS) {
    return null;
  }
  const matchCount: number = countElementsWithExactText(element, visibleText);
  return {
    strategy: "exact-text",
    value: visibleText,
    role: "",
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Guesses whether an id was generated by a framework rather than written by a
 * developer. WHY: React and MUI produce ids like ":r3:" and "mui-1842" that
 * change on every render and must never go into a locator.
 */
export function looksLikeGeneratedIdentifier(identifier: string): boolean {
  if (identifier === "") {
    return true;
  }
  if (identifier.startsWith(":") && identifier.endsWith(":")) {
    return true;                                    // React useId, e.g. ":r3:"
  }
  if (/^mui-\d+$/.test(identifier)) {
    return true;
  }
  if (/^[a-z]*[-_]?[0-9a-f]{8,}$/i.test(identifier)) {
    return true;      // Long hex blobs, with or without a separator.
  }
  if (/\d{4,}$/.test(identifier)) {
    return true;                                    // Trailing counters.
  }
  if (/^(radix|headlessui|reach|downshift)[-:]/i.test(identifier)) {
    return true;                                    // Known UI-kit id prefixes.
  }
  return false;
}

/**
 * Returns the element's 1-based position among siblings of the same tag, or 0
 * when it is the only one (in which case :nth-of-type is pointless noise).
 */
function getPositionAmongSameTagSiblings(element: Element): number {
  const parent: Element | null = element.parentElement;
  if (parent === null) {
    return 0;
  }
  let position: number = 0;
  let sameTagCount: number = 0;
  for (let index = 0; index < parent.children.length; index = index + 1) {
    const sibling: Element = parent.children[index];
    if (sibling.tagName === element.tagName) {
      sameTagCount = sameTagCount + 1;
      if (sibling === element) {
        position = sameTagCount;
      }
    }
  }
  if (sameTagCount <= 1) {
    return 0;
  }
  return position;
}

/**
 * Builds one segment of the CSS path: tag plus at most one stable attribute,
 * plus :nth-of-type() only when the element has same-tag siblings.
 */
function buildCssPathSegment(element: Element): string {
  const tagName: string = element.tagName.toLowerCase();

  const elementId: string = element.getAttribute("id") ?? "";
  if (elementId !== "" && !looksLikeGeneratedIdentifier(elementId)) {
    return tagName + "#" + cssEscape(elementId);
  }

  for (let index = 0; index < STABLE_PATH_ATTRIBUTES.length; index = index + 1) {
    const attributeName: string = STABLE_PATH_ATTRIBUTES[index];
    const attributeValue: string | null = element.getAttribute(attributeName);
    if (attributeValue !== null
        && attributeValue.trim() !== ""
        && attributeValue.length < 80) {
      return tagName + "[" + attributeName + '="'
        + escapeForCssAttributeValue(attributeValue) + '"]';
    }
  }

  const nthPosition: number = getPositionAmongSameTagSiblings(element);
  if (nthPosition > 0) {
    return tagName + ":nth-of-type(" + String(nthPosition) + ")";
  }
  return tagName;
}

/**
 * Builds a short CSS path from STABLE attributes only.
 */
function buildCssPathCandidate(element: Element): LocatorCandidate {
  const pathSegments: string[] = [];
  let currentElement: Element | null = element;
  let depth: number = 0;

  while (currentElement !== null && depth < MAX_CSS_PATH_DEPTH) {
    pathSegments.unshift(buildCssPathSegment(currentElement));

    const joinedSoFar: string = pathSegments.join(" > ");
    if (countMatches(element, joinedSoFar) === 1) {
      break;   // Short and unique beats long and unique.
    }

    currentElement = currentElement.parentElement;
    depth = depth + 1;
  }

  const finalSelector: string = pathSegments.join(" > ");
  const matchCount: number = countMatches(element, finalSelector);
  return {
    strategy: "css-path",
    value: finalSelector,
    role: "",
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Builds an absolute XPath. Last-resort candidate, always generated so the spec
 * is never left with nothing at all.
 */
function buildXPathCandidate(element: Element): LocatorCandidate {
  const segments: string[] = [];
  let currentElement: Element | null = element;

  while (currentElement !== null && currentElement.nodeType === Node.ELEMENT_NODE) {
    const tagName: string = currentElement.tagName.toLowerCase();
    const position: number = getPositionAmongSameTagSiblings(currentElement);
    if (position > 0) {
      segments.unshift(tagName + "[" + String(position) + "]");
    } else {
      segments.unshift(tagName);
    }
    currentElement = currentElement.parentElement;
  }

  const xpath: string = "/" + segments.join("/");

  // Actually evaluate it rather than asserting uniqueness by construction.
  // The old code hardcoded matchCount 1, which is usually true for an absolute
  // path but is a claim we never checked - and it suppressed the "matched N
  // elements" warning that would have told a tester the locator was wrong.
  const matchCount: number = countXPathMatches(element, xpath);

  return {
    strategy: "xpath",
    value: xpath,
    role: "",
    matchCount: matchCount,
    isUniqueAtCaptureTime: matchCount === 1,
  };
}

/**
 * Counts how many nodes an XPath expression selects.
 * Returns 0 when the document has no XPath support or the expression is
 * invalid, so an unverifiable path is never promoted as "unique".
 */
function countXPathMatches(element: Element, xpath: string): number {
  const ownerDocument: Document = element.ownerDocument;
  const evaluator = (ownerDocument as unknown as {
    evaluate?: (
      expression: string, contextNode: Node, resolver: null,
      type: number, result: null,
    ) => { snapshotLength: number };
  }).evaluate;

  if (typeof evaluator !== "function") {
    return 0;
  }

  try {
    // 7 is XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, spelled out because the
    // XPathResult global is not present in every context this file runs in.
    const result = evaluator.call(
      ownerDocument, xpath, ownerDocument, null, 7, null);
    return result.snapshotLength;
  } catch (evaluationError: unknown) {
    return 0;
  }
}

/**
 * True when the element sits inside what looks like a repeated list or table.
 * WHY it matters: it changes how codegen writes the locator. A positional
 * .nth(2) is meaningless once the underlying data changes.
 */
export function isInsideRepeatedList(element: Element): boolean {
  let currentElement: Element | null = element;
  let depth: number = 0;

  while (currentElement !== null && depth < 5) {
    const parent: Element | null = currentElement.parentElement;
    if (parent === null) {
      return false;
    }

    let sameTagSiblingCount: number = 0;
    for (let index = 0; index < parent.children.length; index = index + 1) {
      if (parent.children[index].tagName === currentElement.tagName) {
        sameTagSiblingCount = sameTagSiblingCount + 1;
      }
    }
    if (sameTagSiblingCount >= 3) {
      return true;
    }

    const parentRole: string = parent.getAttribute("role") ?? "";
    if (parentRole === "list" || parentRole === "rowgroup"
        || parentRole === "table" || parentRole === "grid"
        || parentRole === "listbox" || parentRole === "tree") {
      return true;
    }
    if (parent.tagName === "UL" || parent.tagName === "OL"
        || parent.tagName === "TBODY") {
      return true;
    }

    currentElement = parent;
    depth = depth + 1;
  }
  return false;
}

/**
 * Finds the repeated ROW that contains this element, and the unique text that
 * identifies it, so codegen can write
 *   getByRole('row').filter({ hasText: 'TN-40192' }).getByRole('button')
 * which is what a human tester actually means by "the row for tenant TN-40192".
 *
 * Returns empty strings when no such anchor exists.
 */
function findListRowAnchor(element: Element): { anchorText: string; rowRole: string } {
  let currentElement: Element | null = element.parentElement;
  let depth: number = 0;

  while (currentElement !== null && depth < 6) {
    const role: string = getAriaRole(currentElement);
    const isRow: boolean =
      REPEATED_ROW_ROLES.includes(role) || currentElement.tagName === "TR";

    if (isRow) {
      const anchorText: string = findUniqueTextInsideRow(currentElement);
      if (anchorText !== "") {
        return { anchorText: anchorText, rowRole: role === "" ? "row" : role };
      }
      return { anchorText: "", rowRole: role === "" ? "row" : role };
    }

    currentElement = currentElement.parentElement;
    depth = depth + 1;
  }
  return { anchorText: "", rowRole: "" };
}

/**
 * Looks for a short, data-like string inside a row that does not appear in any
 * sibling row. That string is the stable way to name the row.
 */
function findUniqueTextInsideRow(row: Element): string {
  const parent: Element | null = row.parentElement;
  if (parent === null) {
    return "";
  }

  const candidateTexts: string[] = [];
  const cells: NodeListOf<Element> =
    row.querySelectorAll("td, th, [role='cell'], span, div");
  for (let index = 0; index < cells.length && index < 30; index = index + 1) {
    const text: string = getVisibleText(cells[index]);
    if (text.length >= 3 && text.length <= 60) {
      candidateTexts.push(text);
    }
  }
  if (candidateTexts.length === 0) {
    return "";
  }

  // Read every sibling's text ONCE.
  //
  // The previous version re-read it for each candidate, so a 600-row table with
  // 30 candidate strings meant eighteen thousand textContent reads, each
  // building the whole row's string. That was the other half of the multi-second
  // freeze on a single click.
  const siblingTexts: string[] = [];
  const siblingLimit: number =
    Math.min(parent.children.length, MAX_SIBLING_ROWS_SCANNED);
  for (let index = 0; index < siblingLimit; index = index + 1) {
    const sibling: Element = parent.children[index];
    if (sibling === row) {
      continue;
    }
    siblingTexts.push(sibling.textContent ?? "");
  }

  for (let index = 0; index < candidateTexts.length; index = index + 1) {
    const text: string = candidateTexts[index];
    let occurrencesInOtherRows: number = 0;
    for (let siblingIndex = 0; siblingIndex < siblingTexts.length;
         siblingIndex = siblingIndex + 1) {
      if (siblingTexts[siblingIndex].includes(text)) {
        occurrencesInOtherRows = occurrencesInOtherRows + 1;
        break;   // One collision is enough to reject this candidate.
      }
    }
    if (occurrencesInOtherRows === 0) {
      return text;
    }
  }
  return "";
}

/**
 * Collects the chain of OPEN shadow hosts above an element, outermost first.
 */
function collectShadowHostSelectors(element: Element): string[] {
  const hostSelectors: string[] = [];
  let currentNode: Node = element;
  let guard: number = 0;

  while (guard < 10) {
    guard = guard + 1;
    const root: Node = currentNode.getRootNode();
    if (!(root instanceof ShadowRoot)) {
      break;
    }
    const host: Element = root.host;
    hostSelectors.unshift(buildCssPathSegment(host));
    currentNode = host;
  }
  return hostSelectors;
}

/**
 * True when the element is the host of a CLOSED shadow root.
 *
 * Detection is a heuristic: a custom element (a tag containing a hyphen) that
 * renders visibly but reports no children and no text is almost always hiding a
 * closed shadow root. We cannot prove it, because a closed root is invisible to
 * script by design — which is exactly why the generated spec gets a warning
 * comment rather than a confident locator.
 */
function looksLikeClosedShadowHost(element: Element): boolean {
  if (!element.tagName.includes("-")) {
    return false;
  }
  if (element.shadowRoot !== null) {
    return false;   // Open root: we can see into it.
  }
  if (element.children.length > 0) {
    return false;
  }
  if ((element.textContent ?? "").trim() !== "") {
    return false;
  }
  const rectangle: DOMRect = element.getBoundingClientRect();
  return rectangle.width > 0 && rectangle.height > 0;
}

/**
 * THE entry point. Builds every candidate, orders them by strategy priority,
 * promotes the first UNIQUE one to primary, and keeps the rest as fallbacks.
 *
 * WHY the primary is "first unique" rather than "first available": a getByRole
 * locator that matches seven elements is worse than a css-path that matches
 * one, even though role ranks higher in principle.
 */
export function getElementSelector(element: Element): ElementLocator {
  const candidates: LocatorCandidate[] = [];

  const testIdCandidate: LocatorCandidate | null = buildTestIdCandidate(element);
  if (testIdCandidate !== null) {
    candidates.push(testIdCandidate);
  }

  const roleCandidate: LocatorCandidate | null = buildRoleAndNameCandidate(element);
  if (roleCandidate !== null) {
    candidates.push(roleCandidate);
  }

  const labelCandidate: LocatorCandidate | null = buildLabelCandidate(element);
  if (labelCandidate !== null) {
    candidates.push(labelCandidate);
  }

  const placeholderCandidate: LocatorCandidate | null =
    buildAttributeCandidate(element, "placeholder", "placeholder");
  if (placeholderCandidate !== null) {
    candidates.push(placeholderCandidate);
  }

  const altCandidate: LocatorCandidate | null =
    buildAttributeCandidate(element, "alt", "alt-text");
  if (altCandidate !== null) {
    candidates.push(altCandidate);
  }

  const titleCandidate: LocatorCandidate | null =
    buildAttributeCandidate(element, "title", "title");
  if (titleCandidate !== null) {
    candidates.push(titleCandidate);
  }

  const textCandidate: LocatorCandidate | null = buildExactTextCandidate(element);
  if (textCandidate !== null) {
    candidates.push(textCandidate);
  }

  candidates.push(buildCssPathCandidate(element));
  candidates.push(buildXPathCandidate(element));

  // Choose the first candidate that was unique at capture time.
  let primaryCandidate: LocatorCandidate = candidates[candidates.length - 1];
  for (let index = 0; index < candidates.length; index = index + 1) {
    if (candidates[index].isUniqueAtCaptureTime) {
      primaryCandidate = candidates[index];
      break;
    }
  }

  const fallbackCandidates: LocatorCandidate[] = [];
  for (let index = 0; index < candidates.length; index = index + 1) {
    if (candidates[index] !== primaryCandidate) {
      fallbackCandidates.push(candidates[index]);
    }
  }

  const shadowHostSelectors: string[] = collectShadowHostSelectors(element);
  const insideList: boolean = isInsideRepeatedList(element);

  let listRowAnchorText: string = "";
  let listRowRole: string = "";
  if (insideList) {
    const anchor = findListRowAnchor(element);
    listRowAnchorText = anchor.anchorText;
    listRowRole = anchor.rowRole;
  }

  return {
    strategy: primaryCandidate.strategy,
    primary: primaryCandidate,
    fallbacks: fallbackCandidates,
    framePath: [],   // Filled in by the service worker, which knows the frame tree.
    isInShadowDom: shadowHostSelectors.length > 0,
    isClosedShadowHost: looksLikeClosedShadowHost(element),
    shadowHostSelectors: shadowHostSelectors,
    isInsideRepeatedList: insideList,
    listRowAnchorText: listRowAnchorText,
    listRowRole: listRowRole,
    tagName: element.tagName.toLowerCase(),
    ariaRole: getAriaRole(element),
    visibleText: getVisibleText(element),
    accessibleName: getAccessibleName(element),
  };
}
