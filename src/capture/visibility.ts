// =============================================================================
// src/capture/visibility.ts
// "Is this element actually on screen right now?" — used by the pruner and by
// the hover heuristic. Pure DOM, no chrome APIs, testable in jsdom.
// =============================================================================

/**
 * True when the element is visually hidden right now.
 *
 * WHY it matters, and why hidden elements are NOT simply dropped: an element
 * that is hidden AND has no text is noise, but an element that is hidden AND
 * has text is very often the defect itself — an error message that should be
 * showing and is not. The pruner keeps the second kind and tags it.
 */
export function isElementHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) {
    return true;
  }
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  const view: Window | null = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }

  let styles: CSSStyleDeclaration;
  try {
    styles = view.getComputedStyle(element);
  } catch (styleError: unknown) {
    // getComputedStyle throws for detached nodes in some engines. Not hidden.
    return false;
  }

  if (styles.display === "none") {
    return true;
  }
  if (styles.visibility === "hidden" || styles.visibility === "collapse") {
    return true;
  }
  if (styles.opacity === "0") {
    return true;
  }
  return false;
}

/**
 * True when the element has any non-whitespace text anywhere inside it.
 */
export function hasAnyTextContent(element: Element): boolean {
  const text: string = element.textContent ?? "";
  return text.trim().length > 0;
}


/**
 * True when the element is one a user can meaningfully interact with.
 * Used to decide whether a click is worth recording at all.
 */
export function isElementInteractive(element: Element): boolean {
  const interactiveTags: string[] = [
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION", "LABEL",
  ];
  if (interactiveTags.includes(element.tagName)) {
    return true;
  }

  const role: string = element.getAttribute("role") ?? "";
  const interactiveRoles: string[] = [
    "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "checkbox", "radio", "switch", "option", "combobox", "textbox",
    "searchbox", "slider", "spinbutton", "treeitem", "gridcell",
  ];
  if (interactiveRoles.includes(role)) {
    return true;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  if (element.hasAttribute("onclick")) {
    return true;
  }
  const tabIndex: string | null = element.getAttribute("tabindex");
  if (tabIndex !== null && tabIndex !== "-1") {
    return true;
  }
  return false;
}

/** How far up to look for the control a decorative child belongs to. */
const MAX_INTERACTIVE_ANCESTOR_DEPTH: number = 4;

/**
 * Resolves the element the tester meant to click.
 *
 * A click on the <path> of an icon button, or the <span> inside a link, has an
 * event target that is decorative: it has no role, no accessible name and no
 * test id, so the locator chain falls all the way through to a bare CSS path
 * like `path` or `span`. The control one level up usually has all three.
 *
 * Only non-interactive elements are retargeted, and only up to a few levels, so
 * a real click on a nested control - a button inside a table cell - is left
 * exactly where it landed.
 */
export function resolveInteractiveTarget(element: Element): Element {
  if (isElementInteractive(element)) {
    return element;
  }

  let candidate: Element | null = element.parentElement;
  let depth: number = 0;

  while (candidate !== null && depth < MAX_INTERACTIVE_ANCESTOR_DEPTH) {
    if (isElementInteractive(candidate)) {
      return candidate;
    }
    candidate = candidate.parentElement;
    depth = depth + 1;
  }

  return element;
}
