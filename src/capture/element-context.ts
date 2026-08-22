// =============================================================================
// src/capture/element-context.ts
// The bounded structural neighbourhood of one interacted element.
// This is the highest-value-per-byte evidence in the whole bundle: it is small,
// and it is what turns "the tab looks wrong" into a quotable defect report.
// =============================================================================

import type { ElementContext, AriaState, BoundingBox } from "../shared/types";
import { pruneElementSubtree } from "./prune-dom";
import { collapseWhitespace, findByIdInScope } from "./accessible-name";
import {
  MAX_ELEMENT_HTML_CHARACTERS,
  MAX_ANCESTOR_HTML_CHARACTERS,
  MAX_SIBLING_HTML_CHARACTERS,
  SIBLINGS_EACH_SIDE,
  MAX_ANCESTOR_LEVELS,
} from "../shared/constants";

import { createId } from "../shared/ids";
/** Computed styles that can actually explain a defect. Nothing else is sent. */
const INTERESTING_COMPUTED_STYLES: readonly string[] = [
  "display", "visibility", "opacity", "direction", "text-align",
  "color", "background-color", "font-family", "font-size", "font-weight",
  "pointer-events", "cursor", "overflow", "position", "z-index",
  "white-space", "text-overflow", "unicode-bidi",
];

/** Tags and roles that mean "this is a meaningful container". */
const LANDMARK_SELECTOR: string =
  "form, table, ul, ol, dialog, nav, main, header, footer, section, article, " +
  "fieldset, tr, [role], [data-testid], [data-test], [data-qa]";

/**
 * Walks up to find the nearest container that means something structurally.
 *
 * WHY: showing the AI a bare <button> tells it nothing; showing it the
 * <div role="tablist"> that button sits in tells it the button is one tab of
 * several, which is exactly what the reference defect is about.
 */
function findMeaningfulAncestor(
  element: Element,
): { ancestor: Element | null; depth: number } {
  let currentElement: Element | null = element.parentElement;
  let depth: number = 1;

  while (currentElement !== null && depth <= MAX_ANCESTOR_LEVELS) {
    let matches: boolean = false;
    try {
      matches = currentElement.matches(LANDMARK_SELECTOR);
    } catch (selectorError: unknown) {
      matches = false;
    }
    if (matches) {
      return { ancestor: currentElement, depth: depth };
    }
    currentElement = currentElement.parentElement;
    depth = depth + 1;
  }

  return { ancestor: element.parentElement, depth: 1 };
}

/**
 * Collects up to three previous and three next siblings, in document order.
 *
 * WHY: for the tab-labels defect the siblings ARE the evidence. The model needs
 * to see the other tabs to notice that the whole set is worded wrongly.
 */
function collectSiblingHtml(element: Element): string[] {
  const siblingHtml: string[] = [];
  const parent: Element | null = element.parentElement;
  if (parent === null) {
    return siblingHtml;
  }

  const allSiblings: Element[] = [];
  for (let index = 0; index < parent.children.length; index = index + 1) {
    allSiblings.push(parent.children[index]);
  }

  let elementPosition: number = -1;
  for (let index = 0; index < allSiblings.length; index = index + 1) {
    if (allSiblings[index] === element) {
      elementPosition = index;
      break;
    }
  }
  if (elementPosition === -1) {
    return siblingHtml;
  }

  const startIndex: number = Math.max(0, elementPosition - SIBLINGS_EACH_SIDE);
  const endIndex: number =
    Math.min(allSiblings.length - 1, elementPosition + SIBLINGS_EACH_SIDE);

  for (let index = startIndex; index <= endIndex; index = index + 1) {
    if (index === elementPosition) {
      continue;
    }
    const html: string =
      pruneElementSubtree(allSiblings[index], MAX_SIBLING_HTML_CHARACTERS);
    if (html !== "") {
      siblingHtml.push(html);
    }
  }
  return siblingHtml;
}

/**
 * Reads the allow-listed computed styles for the element.
 */
function collectComputedStyles(element: Element): Record<string, string> {
  const styles: Record<string, string> = {};
  const view: Window | null = element.ownerDocument.defaultView;
  if (view === null) {
    return styles;
  }

  let computed: CSSStyleDeclaration;
  try {
    computed = view.getComputedStyle(element);
  } catch (styleError: unknown) {
    return styles;
  }

  for (let index = 0; index < INTERESTING_COMPUTED_STYLES.length; index = index + 1) {
    const propertyName: string = INTERESTING_COMPUTED_STYLES[index];
    styles[propertyName] = computed.getPropertyValue(propertyName);
  }
  return styles;
}

/**
 * Reads every ARIA and native state flag that can explain a functional defect.
 *
 * WHY aria-describedby is RESOLVED to text: an id is meaningless to the model,
 * but "Tenant ID must be 8 digits" is the error message the report needs.
 */
export function collectAriaState(element: Element): AriaState {
  let validationMessage: string = "";
  let isNativelyDisabled: boolean = false;
  let isReadOnly: boolean = false;
  let isRequired: boolean = false;

  if (element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement) {
    validationMessage = element.validationMessage;
    isNativelyDisabled = element.disabled;
    isRequired = element.required;
    if (element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement) {
      isReadOnly = element.readOnly;
    }
  } else if (element instanceof HTMLButtonElement) {
    isNativelyDisabled = element.disabled;
  }

  let describedByText: string = "";
  const describedByIds: string | null = element.getAttribute("aria-describedby");
  if (describedByIds !== null && describedByIds.trim() !== "") {
    const idList: string[] = describedByIds.trim().split(/\s+/);
    const texts: string[] = [];
    for (let index = 0; index < idList.length; index = index + 1) {
      // Same scoping rule as the label lookup: an id inside a shadow root must
      // not resolve against a light-DOM element that happens to share it.
      const referenced: Element | null = findByIdInScope(element, idList[index]);
      if (referenced !== null) {
        texts.push((referenced.textContent ?? "").trim());
      }
    }
    describedByText = collapseWhitespace(texts.join(" "));
  }

  return {
    role: element.getAttribute("role") ?? "",
    ariaLabel: element.getAttribute("aria-label") ?? "",
    ariaDescribedByText: describedByText,
    ariaExpanded: element.getAttribute("aria-expanded") ?? "",
    ariaInvalid: element.getAttribute("aria-invalid") ?? "",
    ariaDisabled: element.getAttribute("aria-disabled") ?? "",
    ariaChecked: element.getAttribute("aria-checked") ?? "",
    ariaSelected: element.getAttribute("aria-selected") ?? "",
    ariaHidden: element.getAttribute("aria-hidden") ?? "",
    isNativelyDisabled: isNativelyDisabled,
    isReadOnly: isReadOnly,
    isRequired: isRequired,
    validationMessage: validationMessage,
  };
}

/**
 * Walks up the tree to find the nearest lang / dir that actually applies.
 *
 * WHY this is not optional for this product: an English label inside an
 * Arabic-direction container is one of the most common defects in a bilingual
 * app, and it is invisible unless both values are captured.
 */
export function resolveInheritedAttribute(
  element: Element,
  attributeName: string,
): string {
  let currentElement: Element | null = element;
  while (currentElement !== null) {
    const value: string | null = currentElement.getAttribute(attributeName);
    if (value !== null && value.trim() !== "") {
      return value.trim();
    }
    currentElement = currentElement.parentElement;
  }
  return "";
}

/**
 * Reads the element's on-screen rectangle.
 */
function readBoundingBox(element: Element): BoundingBox {
  const rectangle: DOMRect = element.getBoundingClientRect();
  return {
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
    width: Math.round(rectangle.width),
    height: Math.round(rectangle.height),
  };
}

/**
 * Serialises the interacted element itself, even when it is visually hidden.
 *
 * The normal pruning policy drops a hidden element that has no text, which is
 * right for a page snapshot and wrong here: a custom checkbox is almost always
 * a visually-hidden <input> with a styled <span> next to it, and elementHtml is
 * the one field that answers "what did the tester actually touch". Returning
 * empty there left the most important evidence blank for exactly the controls
 * that need explaining.
 */
function captureElementHtml(element: Element): string {
  const pruned: string = pruneElementSubtree(element, MAX_ELEMENT_HTML_CHARACTERS);
  if (pruned !== "") {
    return pruned;
  }

  // Fall back to the element's own tag with its attributes, built by hand so a
  // hidden control is still described.
  const attributes: string[] = [];
  for (let index = 0; index < element.attributes.length; index = index + 1) {
    const attribute: Attr = element.attributes[index];
    if (attribute.name === "style" || attribute.name === "class") {
      continue;
    }
    const value: string = attribute.value.length > 200
      ? attribute.value.slice(0, 200) + "…"
      : attribute.value;
    attributes.push(attribute.name + '="' + value.split('"').join("&quot;") + '"');
  }

  const tagName: string = element.tagName.toLowerCase();
  const attributeText: string =
    attributes.length === 0 ? "" : " " + attributes.join(" ");
  return "<" + tagName + attributeText + ' data-qa-hidden="true"></' + tagName + ">";
}

/**
 * Captures the complete bounded context for one interacted element.
 */
export function captureElementContext(element: Element): ElementContext {
  const ancestorResult = findMeaningfulAncestor(element);

  let ancestorHtml: string = "";
  if (ancestorResult.ancestor !== null) {
    ancestorHtml =
      pruneElementSubtree(ancestorResult.ancestor, MAX_ANCESTOR_HTML_CHARACTERS);
  }

  return {
    id: createId(),
    sessionId: "",  // Filled in by the service worker, which owns session state.
    eventIndex: -1, // Filled in by the service worker.
    elementHtml: captureElementHtml(element),
    ancestorHtml: ancestorHtml,
    ancestorDepth: ancestorResult.depth,
    siblingHtml: collectSiblingHtml(element),
    computedStyles: collectComputedStyles(element),
    ariaState: collectAriaState(element),
    inheritedLang: resolveInheritedAttribute(element, "lang"),
    inheritedDir: resolveInheritedAttribute(element, "dir"),
    boundingBox: readBoundingBox(element),
  };
}
