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
 * True when the element is inside the viewport right now.
 * Used to decide whether a scroll actually revealed something.
 */
export function isElementInViewport(element: Element): boolean {
  const view: Window | null = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }
  const rectangle: DOMRect = element.getBoundingClientRect();
  if (rectangle.width === 0 && rectangle.height === 0) {
    return false;
  }
  if (rectangle.bottom < 0 || rectangle.top > view.innerHeight) {
    return false;
  }
  if (rectangle.right < 0 || rectangle.left > view.innerWidth) {
    return false;
  }
  return true;
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
