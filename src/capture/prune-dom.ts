// =============================================================================
// src/capture/prune-dom.ts
// Turns a live document into a compact HTML string an LLM can actually read.
//
// It serialises the LIVE tree and never a clone. That is deliberate: cloning
// would lose getComputedStyle(), which several pruning rules depend on, and
// serialising in place guarantees we never mutate the page under test.
//
// THE ACCEPTANCE TEST for this file: given a page whose category tabs read
// "Contract Renewal & Continuation" and friends, the pruned output must still
// contain every one of those labels, verbatim, in order. If a change to the
// policy breaks that, the change is wrong.
// =============================================================================

import {
  MAX_SNAPSHOT_CHARACTERS,
  MAX_TEXT_NODE_CHARACTERS,
  MAX_CLASS_ATTRIBUTE_CHARACTERS,
  MAX_ATTRIBUTE_VALUE_CHARACTERS,
} from "../shared/constants";
import { isElementHidden, hasAnyTextContent } from "./visibility";
import { collapseWhitespace } from "./accessible-name";

export interface PruneOptions {
  /** Hard ceiling on the returned HTML string. */
  maxTotalCharacters: number;
  /** Longest single text node we keep before truncating it. */
  maxTextNodeCharacters: number;
  /** Longest class attribute we keep. */
  maxClassAttributeCharacters: number;
  /** Longest value for any other kept attribute. */
  maxAttributeValueCharacters: number;
  /** When false, open shadow roots are not serialised. Used for tiny budgets. */
  includeShadowRoots: boolean;
}

export const DEFAULT_PRUNE_OPTIONS: PruneOptions = {
  maxTotalCharacters: MAX_SNAPSHOT_CHARACTERS,
  maxTextNodeCharacters: MAX_TEXT_NODE_CHARACTERS,
  maxClassAttributeCharacters: MAX_CLASS_ATTRIBUTE_CHARACTERS,
  maxAttributeValueCharacters: MAX_ATTRIBUTE_VALUE_CHARACTERS,
  includeShadowRoots: true,
};

export interface PruneResult {
  prunedHtml: string;
  characterCount: number;
  wasTruncated: boolean;
  droppedElementCount: number;
}

/** Tags whose entire subtree carries no rendered meaning. */
const DROPPED_TAGS: readonly string[] = [
  "SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE", "BASE", "HEAD", "TITLE",
];

/** Tags we keep but never recurse into. */
const NON_RECURSED_TAGS: readonly string[] = [
  "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "OBJECT", "EMBED", "MAP",
];

/** Void elements, which must not get a closing tag. */
const VOID_TAGS: readonly string[] = [
  "AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT",
  "LINK", "META", "SOURCE", "TRACK", "WBR",
];

/** Attributes we always keep, subject to the length cap. */
const KEPT_ATTRIBUTES: readonly string[] = [
  "id", "name", "type", "role", "href", "src", "alt", "title", "placeholder",
  "value", "lang", "dir", "for", "colspan", "rowspan", "tabindex",
  "data-testid", "data-test-id", "data-test", "data-qa", "data-cy",
  "data-automation-id", "contenteditable",
];

/** Boolean attributes: their presence alone is the signal. */
const KEPT_BOOLEAN_ATTRIBUTES: readonly string[] = [
  "disabled", "checked", "selected", "readonly", "required", "open", "hidden",
  "multiple", "autofocus",
];

/** Substrings that identify third-party widgets we never care about. */
const THIRD_PARTY_MARKERS: readonly string[] = [
  "googletagmanager", "google-analytics", "gtm-", "hotjar", "_hj",
  "intercom", "zendesk", "drift-", "livechat", "facebook-pixel", "clarity",
  "doubleclick", "segment-io", "mixpanel",
];

/**
 * Escapes text so the pruned output is valid, parseable HTML.
 * WHY: the model is told the payload is HTML; an unescaped angle bracket in a
 * tenant name would silently corrupt the structure it reads.
 */
export function escapeHtmlText(text: string): string {
  let result: string = "";
  for (let index = 0; index < text.length; index = index + 1) {
    const character: string = text.charAt(index);
    if (character === "&") {
      result = result + "&amp;";
    } else if (character === "<") {
      result = result + "&lt;";
    } else if (character === ">") {
      result = result + "&gt;";
    } else {
      result = result + character;
    }
  }
  return result;
}

/**
 * Escapes a value so it can sit inside a double-quoted HTML attribute.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).split('"').join("&quot;");
}

/**
 * Truncates a string to a cap, appending a marker so the model knows content
 * was removed rather than absent.
 */
function capString(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(0, maxCharacters) + "…";
}

/**
 * True when the element belongs to a third-party widget we always drop.
 */
function isThirdPartyWidget(element: Element): boolean {
  let classText: string = "";
  const classAttribute: string | null = element.getAttribute("class");
  if (classAttribute !== null) {
    classText = classAttribute;
  }

  const signature: string = [
    element.getAttribute("id") ?? "",
    element.getAttribute("src") ?? "",
    element.getAttribute("data-widget") ?? "",
    classText,
  ].join(" ").toLowerCase();

  for (let index = 0; index < THIRD_PARTY_MARKERS.length; index = index + 1) {
    if (signature.includes(THIRD_PARTY_MARKERS[index])) {
      return true;
    }
  }
  return false;
}

/**
 * Decides whether a plain wrapper element can be skipped entirely.
 * WHY: React apps routinely nest six attribute-free divs between two nodes that
 * mean something. Collapsing them saves 15-20% of the budget for free.
 */
function isCollapsibleWrapper(element: Element): boolean {
  if (element.tagName !== "DIV" && element.tagName !== "SPAN") {
    return false;
  }
  if (element.children.length !== 1) {
    return false;
  }

  for (let index = 0; index < KEPT_ATTRIBUTES.length; index = index + 1) {
    if (element.hasAttribute(KEPT_ATTRIBUTES[index])) {
      return false;
    }
  }
  for (let index = 0; index < KEPT_BOOLEAN_ATTRIBUTES.length; index = index + 1) {
    if (element.hasAttribute(KEPT_BOOLEAN_ATTRIBUTES[index])) {
      return false;
    }
  }

  // Any aria-* attribute makes the wrapper meaningful.
  for (let index = 0; index < element.attributes.length; index = index + 1) {
    if (element.attributes[index].name.startsWith("aria-")) {
      return false;
    }
  }

  // Direct text of its own means it is not a pure wrapper.
  for (let index = 0; index < element.childNodes.length; index = index + 1) {
    const child: ChildNode = element.childNodes[index];
    if (child.nodeType === Node.TEXT_NODE) {
      if (collapseWhitespace(child.textContent ?? "") !== "") {
        return false;
      }
    }
  }

  // A shadow host is never a pure wrapper.
  if (element.shadowRoot !== null) {
    return false;
  }

  return true;
}

/**
 * Builds the attribute string for one element according to the policy table.
 */
function buildAttributeString(element: Element, options: PruneOptions): string {
  let attributeString: string = "";

  for (let index = 0; index < KEPT_ATTRIBUTES.length; index = index + 1) {
    const attributeName: string = KEPT_ATTRIBUTES[index];
    const rawValue: string | null = element.getAttribute(attributeName);
    if (rawValue === null) {
      continue;
    }

    let value: string = rawValue;

    if (attributeName === "src") {
      if (value.startsWith("data:")) {
        value = "data:[stripped]";
      }
      if (element.tagName === "CANVAS" || element.tagName === "VIDEO"
          || element.tagName === "AUDIO") {
        continue;
      }
    }

    value = capString(value, options.maxAttributeValueCharacters);
    attributeString = attributeString + " " + attributeName
      + '="' + escapeHtmlAttribute(value) + '"';
  }

  // Every aria-* attribute is kept, whatever its name.
  for (let index = 0; index < element.attributes.length; index = index + 1) {
    const attribute: Attr = element.attributes[index];
    if (attribute.name.startsWith("aria-")) {
      const value: string =
        capString(attribute.value, options.maxAttributeValueCharacters);
      attributeString = attributeString + " " + attribute.name
        + '="' + escapeHtmlAttribute(value) + '"';
    }
  }

  for (let index = 0; index < KEPT_BOOLEAN_ATTRIBUTES.length; index = index + 1) {
    const attributeName: string = KEPT_BOOLEAN_ATTRIBUTES[index];
    if (element.hasAttribute(attributeName)) {
      attributeString = attributeString + " " + attributeName;
    }
  }

  const classValue: string | null = element.getAttribute("class");
  if (classValue !== null && classValue.trim() !== "") {
    const cappedClass: string =
      capString(classValue.trim(), options.maxClassAttributeCharacters);
    attributeString = attributeString + ' class="'
      + escapeHtmlAttribute(cappedClass) + '"';
  }

  return attributeString;
}

/** Mutable accounting shared by the recursive serialiser. */
export interface PruneState {
  outputParts: string[];
  charactersUsed: number;
  droppedElementCount: number;
  budgetExhausted: boolean;
}

/**
 * Creates a fresh accounting state.
 */
export function createPruneState(): PruneState {
  return {
    outputParts: [],
    charactersUsed: 0,
    droppedElementCount: 0,
    budgetExhausted: false,
  };
}

/**
 * Appends a chunk of output if there is budget left; otherwise flips the
 * exhausted flag so the whole walk unwinds cleanly.
 */
/** Emitted in place of the content that did not fit. */
const BUDGET_MARKER: string = "<!-- BUDGET EXHAUSTED: remaining content omitted -->";

function appendOutput(state: PruneState, chunk: string, options: PruneOptions): void {
  if (state.budgetExhausted) {
    return;
  }

  // Room for the marker is reserved UP FRONT.
  //
  // The marker used to be pushed straight into outputParts when the cap was
  // hit, bypassing the accounting and the cap it had just enforced - so the
  // finished snapshot overran the documented budget by the marker's own length.
  // The real OrangeHRM login page produced 40,021 characters against a 40,000
  // budget; no fixture had ever landed close enough to the boundary to show it.
  const effectiveBudget: number =
    options.maxTotalCharacters - BUDGET_MARKER.length;

  if (state.charactersUsed + chunk.length > effectiveBudget) {
    state.outputParts.push(BUDGET_MARKER);
    state.charactersUsed = state.charactersUsed + BUDGET_MARKER.length;
    state.budgetExhausted = true;
    return;
  }

  state.outputParts.push(chunk);
  state.charactersUsed = state.charactersUsed + chunk.length;
}

/** Guards against a pathological or cyclic tree hanging the page. */
const MAX_SERIALISATION_DEPTH: number = 60;

/**
 * Serialises one node and, unless the policy says otherwise, its children.
 * This is the heart of the pruner: every policy rule lands here.
 *
 * Exported so element-context.ts can serialise a SUBTREE with the same policy
 * and a smaller budget, instead of duplicating the rules.
 */
export function serialiseNode(
  node: Node,
  state: PruneState,
  options: PruneOptions,
  depth: number,
): void {
  if (state.budgetExhausted || depth > MAX_SERIALISATION_DEPTH) {
    return;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    const text: string = collapseWhitespace(node.textContent ?? "");
    if (text !== "") {
      appendOutput(
        state,
        escapeHtmlText(capString(text, options.maxTextNodeCharacters)),
        options,
      );
    }
    return;
  }

  // Comment nodes are framework hydration markers only.
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  const element: Element = node as Element;

  // SVG and MathML elements report a LOWER-CASE tagName, unlike HTML elements,
  // so comparing against the upper-case tables below silently let entire icon
  // subtrees through. A page with fifty icons emitted several hundred empty
  // tags for no benefit.
  const upperTagName: string = element.tagName.toUpperCase();

  if (DROPPED_TAGS.includes(upperTagName)) {
    state.droppedElementCount = state.droppedElementCount + 1;
    return;
  }

  if (isThirdPartyWidget(element)) {
    state.droppedElementCount = state.droppedElementCount + 1;
    return;
  }

  const hidden: boolean = isElementHidden(element);
  if (hidden && !hasAnyTextContent(element)) {
    state.droppedElementCount = state.droppedElementCount + 1;
    return;
  }

  if (isCollapsibleWrapper(element)) {
    state.droppedElementCount = state.droppedElementCount + 1;
    serialiseNode(element.children[0], state, options, depth + 1);
    return;
  }

  const tagName: string = element.tagName.toLowerCase();
  let attributeString: string = buildAttributeString(element, options);
  if (hidden) {
    // Kept on purpose: a hidden element WITH text is very often the defect.
    attributeString = attributeString + ' data-qa-hidden="true"';
  }

  appendOutput(state, "<" + tagName + attributeString + ">", options);

  if (VOID_TAGS.includes(upperTagName)) {
    return;
  }

  if (NON_RECURSED_TAGS.includes(upperTagName)) {
    appendOutput(state, "</" + tagName + ">", options);
    return;
  }

  // Open shadow roots are serialised inline and marked, so the model
  // understands this content is not reachable by ordinary CSS from the light
  // DOM. Closed shadow roots are invisible to us and cannot be included.
  if (options.includeShadowRoots && element.shadowRoot !== null) {
    appendOutput(state, "<!-- open shadow root -->", options);
    const shadowChildren: NodeListOf<ChildNode> = element.shadowRoot.childNodes;
    for (let index = 0; index < shadowChildren.length; index = index + 1) {
      serialiseNode(shadowChildren[index], state, options, depth + 1);
    }
  }

  for (let index = 0; index < element.childNodes.length; index = index + 1) {
    serialiseNode(element.childNodes[index], state, options, depth + 1);
  }

  appendOutput(state, "</" + tagName + ">", options);
}

/**
 * Serialises a single element subtree with the standard policy and a custom
 * budget. Used by element-context.ts.
 */
export function pruneElementSubtree(
  element: Element,
  maxCharacters: number,
): string {
  const options: PruneOptions = {
    ...DEFAULT_PRUNE_OPTIONS,
    maxTotalCharacters: maxCharacters,
  };
  const state: PruneState = createPruneState();
  serialiseNode(element, state, options, 0);
  return state.outputParts.join("");
}

/**
 * Prunes a whole document down to an LLM-readable HTML string.
 *
 * WHY it exists: a raw outerHTML of a modern enterprise page is 500 KB to 3 MB,
 * 90% of which is class soup, inline SVG and framework data attributes. This
 * reduces it to roughly 20-40 KB while guaranteeing that every rendered string
 * and every ARIA state survives.
 */
export function pruneDomForAI(
  documentToPrune: Document,
  options: PruneOptions,
): PruneResult {
  const state: PruneState = createPruneState();

  const bodyElement: HTMLElement | null = documentToPrune.body;
  if (bodyElement === null) {
    return {
      prunedHtml: "",
      characterCount: 0,
      wasTruncated: false,
      droppedElementCount: 0,
    };
  }

  // Emit the document-level language direction first: the model needs it before
  // it reads a single Arabic string.
  const rootElement: HTMLElement = documentToPrune.documentElement;
  const documentLang: string = rootElement.getAttribute("lang") ?? "";
  const documentDir: string = rootElement.getAttribute("dir") ?? "";

  appendOutput(
    state,
    '<document lang="' + escapeHtmlAttribute(documentLang)
      + '" dir="' + escapeHtmlAttribute(documentDir)
      + '" title="' + escapeHtmlAttribute(documentToPrune.title) + '">',
    options,
  );

  serialiseNode(bodyElement, state, options, 0);
  appendOutput(state, "</document>", options);

  const prunedHtml: string = state.outputParts.join("");
  return {
    prunedHtml: prunedHtml,
    characterCount: prunedHtml.length,
    wasTruncated: state.budgetExhausted,
    droppedElementCount: state.droppedElementCount,
  };
}
