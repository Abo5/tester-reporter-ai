// =============================================================================
// src/capture/accessible-name.ts
// A deliberately MINIMAL accessible-name and role computation.
//
// WHY minimal and not spec-complete: the full ARIA accessible-name algorithm is
// several hundred lines of edge cases. We need the same answer Playwright's
// getByRole() would give for the ~95% of real controls a QA tester clicks, and
// we record the match count so an ambiguous name never becomes the primary
// locator. Being wrong here degrades a locator; it does not corrupt evidence.
// =============================================================================

import { isElementHidden } from "./visibility";

/** Native tag -> implicit ARIA role, for the tags that actually come up. */
const IMPLICIT_ROLE_BY_TAG: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  IMG: "img",
  NAV: "navigation",
  MAIN: "main",
  HEADER: "banner",
  FOOTER: "contentinfo",
  ASIDE: "complementary",
  FORM: "form",
  TABLE: "table",
  THEAD: "rowgroup",
  TBODY: "rowgroup",
  TFOOT: "rowgroup",
  TR: "row",
  TD: "cell",
  TH: "columnheader",
  UL: "list",
  OL: "list",
  LI: "listitem",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  DIALOG: "dialog",
  SUMMARY: "button",
  PROGRESS: "progressbar",
  HR: "separator",
};

/** input[type] -> role, for the types that matter to a tester. */
const ROLE_BY_INPUT_TYPE: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
  password: "textbox",
};

/**
 * Returns the element's ARIA role: the explicit role attribute if present,
 * otherwise the implicit role for its tag. "" when there is no sensible role.
 */
export function getAriaRole(element: Element): string {
  const explicitRole: string | null = element.getAttribute("role");
  if (explicitRole !== null && explicitRole.trim() !== "") {
    // A role list like "button link" resolves to its first valid token.
    return explicitRole.trim().split(/\s+/)[0];
  }

  if (element.tagName === "INPUT") {
    const inputType: string = (element.getAttribute("type") ?? "text").toLowerCase();
    const mappedRole: string | undefined = ROLE_BY_INPUT_TYPE[inputType];
    if (mappedRole !== undefined) {
      return mappedRole;
    }
    return "textbox";
  }

  if (element.tagName === "A") {
    // An anchor without href is not a link.
    if (!element.hasAttribute("href")) {
      return "";
    }
    return "link";
  }

  const implicitRole: string | undefined = IMPLICIT_ROLE_BY_TAG[element.tagName];
  if (implicitRole !== undefined) {
    return implicitRole;
  }
  return "";
}

/**
 * Returns the visible text of an element, collapsed and trimmed.
 *
 * WHY it skips hidden descendants: a menu that is in the DOM but closed would
 * otherwise contribute all of its item labels to the button's "visible text",
 * producing a locator that matches nothing.
 */
export function getVisibleText(element: Element): string {
  const parts: string[] = [];
  const budget: { remaining: number } = { remaining: MAX_TEXT_COLLECTION_NODES };
  collectVisibleTextInto(element, parts, 0, budget);
  return collapseWhitespace(parts.join(" "));
}

/**
 * How many nodes one getVisibleText call may touch.
 *
 * This runs inside the click handler, and every element it visits costs a
 * getComputedStyle. Walking a 600-row table to discover that its visible text
 * is not "View" is thousands of style resolutions for an answer that was
 * obvious. Anything that overruns the budget cannot have a short label as its
 * whole visible text anyway, so the truncated result is still correct for the
 * comparison it is used in.
 */
const MAX_TEXT_COLLECTION_NODES: number = 400;

/** Recursion depth limit, so a pathological tree cannot hang the page. */
const MAX_TEXT_COLLECTION_DEPTH: number = 12;

/**
 * Walks an element collecting text from nodes that are actually on screen.
 */
function collectVisibleTextInto(
  element: Element,
  parts: string[],
  depth: number,
  budget: { remaining: number },
): void {
  if (depth > MAX_TEXT_COLLECTION_DEPTH || budget.remaining <= 0) {
    return;
  }
  for (let index = 0; index < element.childNodes.length; index = index + 1) {
    const child: ChildNode = element.childNodes[index];

    if (child.nodeType === Node.TEXT_NODE) {
      const text: string = (child.textContent ?? "").trim();
      if (text !== "") {
        parts.push(text);
      }
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const childElement: Element = child as Element;
    if (childElement.tagName === "SCRIPT" || childElement.tagName === "STYLE") {
      continue;
    }
    budget.remaining = budget.remaining - 1;
    if (budget.remaining <= 0) {
      return;
    }
    if (isElementHidden(childElement)) {
      continue;
    }
    collectVisibleTextInto(childElement, parts, depth + 1, budget);
  }
}

/**
 * Collapses runs of whitespace and trims. Shared by several capture functions.
 */
export function collapseWhitespace(text: string): string {
  let collapsed: string = "";
  let previousWasSpace: boolean = false;
  for (let index = 0; index < text.length; index = index + 1) {
    const character: string = text.charAt(index);
    const isSpace: boolean =
      character === " " || character === "\n" ||
      character === "\t" || character === "\r";
    if (isSpace) {
      if (!previousWasSpace) {
        collapsed = collapsed + " ";
      }
      previousWasSpace = true;
    } else {
      collapsed = collapsed + character;
      previousWasSpace = false;
    }
  }
  return collapsed.trim();
}

/**
 * Finds the visible label text for a form control, checking every mechanism a
 * real application actually uses, in the order the ARIA spec prefers.
 */
export function getAssociatedLabelText(control: Element): string {
  const ariaLabel: string | null = control.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim() !== "") {
    return ariaLabel.trim();
  }

  const labelledBy: string | null = control.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    const idList: string[] = labelledBy.trim().split(/\s+/);
    const referencedTexts: string[] = [];
    for (let index = 0; index < idList.length; index = index + 1) {
      const referenced: Element | null =
        control.ownerDocument.getElementById(idList[index]);
      if (referenced !== null) {
        referencedTexts.push((referenced.textContent ?? "").trim());
      }
    }
    const joined: string = collapseWhitespace(referencedTexts.join(" "));
    if (joined !== "") {
      return joined;
    }
  }

  const controlId: string = control.getAttribute("id") ?? "";
  if (controlId !== "") {
    const escapedId: string = cssEscape(controlId);
    const labelElement: Element | null =
      control.ownerDocument.querySelector('label[for="' + escapedId + '"]');
    if (labelElement !== null) {
      const labelText: string = collapseWhitespace(labelElement.textContent ?? "");
      if (labelText !== "") {
        return labelText;
      }
    }
  }

  if (control instanceof HTMLElement) {
    const wrappingLabel: HTMLLabelElement | null = control.closest("label");
    if (wrappingLabel !== null) {
      const labelText: string = collapseWhitespace(wrappingLabel.textContent ?? "");
      if (labelText !== "") {
        return labelText;
      }
    }
  }

  return "";
}

/**
 * Computes the accessible name: what a screen reader would announce, and what
 * Playwright's getByRole({ name }) matches against.
 */
export function getAccessibleName(element: Element): string {
  const ariaLabel: string | null = element.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim() !== "") {
    return collapseWhitespace(ariaLabel);
  }

  const labelledBy: string | null = element.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    const idList: string[] = labelledBy.trim().split(/\s+/);
    const referencedTexts: string[] = [];
    for (let index = 0; index < idList.length; index = index + 1) {
      const referenced: Element | null =
        element.ownerDocument.getElementById(idList[index]);
      if (referenced !== null) {
        referencedTexts.push((referenced.textContent ?? "").trim());
      }
    }
    const joined: string = collapseWhitespace(referencedTexts.join(" "));
    if (joined !== "") {
      return joined;
    }
  }

  // Form controls take their name from their label before their content.
  if (element.tagName === "INPUT" || element.tagName === "SELECT"
      || element.tagName === "TEXTAREA") {
    const labelText: string = getAssociatedLabelText(element);
    if (labelText !== "") {
      return labelText;
    }
    const placeholder: string | null = element.getAttribute("placeholder");
    if (placeholder !== null && placeholder.trim() !== "") {
      return collapseWhitespace(placeholder);
    }
    // Buttons rendered as <input type="button" value="Save">.
    if (element.tagName === "INPUT") {
      const inputType: string = (element.getAttribute("type") ?? "").toLowerCase();
      if (inputType === "button" || inputType === "submit" || inputType === "reset") {
        const value: string | null = element.getAttribute("value");
        if (value !== null && value.trim() !== "") {
          return collapseWhitespace(value);
        }
      }
    }
  }

  if (element.tagName === "IMG" || element.tagName === "AREA") {
    const altText: string | null = element.getAttribute("alt");
    if (altText !== null && altText.trim() !== "") {
      return collapseWhitespace(altText);
    }
  }

  const visibleText: string = getVisibleText(element);
  if (visibleText !== "") {
    return visibleText;
  }

  const titleText: string | null = element.getAttribute("title");
  if (titleText !== null && titleText.trim() !== "") {
    return collapseWhitespace(titleText);
  }

  return "";
}

/**
 * Escapes a string for use inside a CSS selector.
 *
 * WHY we do not just call CSS.escape: this module is also unit-tested outside a
 * browser, where CSS.escape may not exist. We use it when available and fall
 * back to a conservative manual escape otherwise.
 */
export function cssEscape(value: string): string {
  const globalCss = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (globalCss !== undefined && typeof globalCss.escape === "function") {
    try {
      // Called as a METHOD, not detached: some implementations check `this`,
      // so `const f = CSS.escape; f(x)` throws where `CSS.escape(x)` works.
      return globalCss.escape(value);
    } catch (escapeError: unknown) {
      // Fall through to the manual escape below.
    }
  }

  let escaped: string = "";
  for (let index = 0; index < value.length; index = index + 1) {
    const character: string = value.charAt(index);
    const isSafe: boolean =
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9") ||
      character === "-" || character === "_";
    if (isSafe) {
      escaped = escaped + character;
    } else {
      escaped = escaped + "\\" + character;
    }
  }
  return escaped;
}

/**
 * Reverse of IMPLICIT_ROLE_BY_TAG: which tags can carry a given role natively.
 * Used to narrow a role search to a candidate set instead of the whole page.
 */
export function tagsForImplicitRole(role: string): string[] {
  const tags: string[] = [];
  const tagNames: string[] = Object.keys(IMPLICIT_ROLE_BY_TAG);
  for (let index = 0; index < tagNames.length; index = index + 1) {
    if (IMPLICIT_ROLE_BY_TAG[tagNames[index]] === role) {
      tags.push(tagNames[index].toLowerCase());
    }
  }

  // input types map to roles too, and <input> is the single most common
  // control, so it must be included or a textbox search would miss every one.
  const inputTypes: string[] = Object.keys(ROLE_BY_INPUT_TYPE);
  for (let index = 0; index < inputTypes.length; index = index + 1) {
    if (ROLE_BY_INPUT_TYPE[inputTypes[index]] === role) {
      tags.push('input[type="' + inputTypes[index] + '"]');
      if (inputTypes[index] === "text") {
        tags.push("input:not([type])");
      }
    }
  }
  return tags;
}
