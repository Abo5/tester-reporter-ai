// =============================================================================
// src/content/event-handlers.ts
// One small handler per DOM event type, plus the module-level state they share
// (the typing buffer, the hover throttle, the last scroll).
//
// Everything here runs INSIDE THE PAGE UNDER TEST, so the rule is absolute:
// never mutate the page. No added attributes, no scroll changes, no focus
// changes, no synthetic events.
// =============================================================================

import type {
  RecordedEvent,
  RecordedEventType,
  DomSnapshot,
  ElementContext,
  SnapshotTrigger,
} from "../shared/types";
import { getElementSelector } from "../capture/selector";
import { captureElementContext } from "../capture/element-context";
import { maybeTakeSnapshot } from "./snapshot-scheduler";
import { sendMessageIgnoringNoReceiver } from "../shared/messages";
import {
  INPUT_COALESCE_DELAY_MS,
  HOVER_MUTATION_WINDOW_MS,
  HOVER_THROTTLE_MS,
  SCROLL_RELEVANCE_WINDOW_MS,
} from "../shared/constants";

// -----------------------------------------------------------------------------
// Shared recorder state
// -----------------------------------------------------------------------------

/** Set by the handshake reply. We do nothing at all when this is false. */
let isRecordingActive: boolean = false;

/** The session events belong to. "" when not recording. */
let activeSessionId: string = "";

/** Buffers typing so N keystrokes become ONE "input" event. */
interface PendingInput {
  element: Element;
  latestValue: string;
  flushTimerId: number;
}
let pendingInput: PendingInput | null = null;

/** Wall-clock time of the last recorded hover, for throttling. */
let lastHoverRecordedAtMs: number = 0;

/** The element the tester most recently clicked, and when. */
let lastClickedElement: Element | null = null;
let lastClickWallClockMs: number = 0;

/** Wall-clock time of the last Enter press, for implicit-submit detection. */
let lastEnterPressWallClockMs: number = 0;

/** How long after an Enter press a submit-button click is treated as synthetic. */
const IMPLICIT_SUBMIT_WINDOW_MS: number = 400;

/** How long after a click a hover on the SAME element is ignored. */
const POST_CLICK_HOVER_SUPPRESSION_MS: number = 1500;

/** The most recent scroll, held until we know whether it led to an action. */
interface PendingScroll {
  scrollX: number;
  scrollY: number;
  wallClockMs: number;
  pageUrl: string;
  pageTitle: string;
}
let pendingScroll: PendingScroll | null = null;

/**
 * Turns recording on or off for this frame.
 */
export function setRecordingActive(isActive: boolean, sessionId: string): void {
  isRecordingActive = isActive;
  activeSessionId = sessionId;
  if (!isActive) {
    clearPendingInput();
    pendingScroll = null;
  }
}

/** True when this frame is currently recording. */
export function getRecordingActive(): boolean {
  return isRecordingActive;
}

/** The session id this frame is recording into. */
export function getActiveSessionId(): string {
  return activeSessionId;
}

// -----------------------------------------------------------------------------
// Event construction and sending
// -----------------------------------------------------------------------------

/**
 * Builds the common part of a RecordedEvent, so the shared fields are filled in
 * exactly one way.
 *
 * Fields left for the service worker to fill: index, videoOffsetMs, tabId and
 * frameId. The content script cannot know any of them.
 */
function createBaseEvent(type: RecordedEventType): RecordedEvent {
  return {
    index: -1,
    sessionId: activeSessionId,
    type: type,
    wallClockMs: Date.now(),
    videoOffsetMs: -1,
    pageUrl: window.location.href,
    pageTitle: document.title,
    tabId: -1,
    frameId: -1,
    locator: null,
    value: "",
    valueWasRedacted: false,
    clientX: -1,
    clientY: -1,
    domSnapshotId: "",
    elementContextId: "",
  };
}

/** Sends one event to the service worker. Fire and forget. */
function sendEvent(event: RecordedEvent): void {
  void sendMessageIgnoringNoReceiver({ kind: "content/recorded-event", event: event });
}

/** Sends one element context to the service worker. */
function sendElementContext(context: ElementContext): void {
  void sendMessageIgnoringNoReceiver({
    kind: "content/element-context",
    context: context,
  });
}

/** Sends one DOM snapshot to the service worker. */
function sendDomSnapshot(snapshot: DomSnapshot): void {
  void sendMessageIgnoringNoReceiver({ kind: "content/dom-snapshot", snapshot: snapshot });
}

/**
 * Takes a snapshot if the scheduler agrees, and returns its id (or "").
 */
export function takeSnapshotIfSignificant(
  trigger: SnapshotTrigger,
  eventIndex: number,
): string {
  const snapshot: DomSnapshot | null =
    maybeTakeSnapshot(trigger, activeSessionId, eventIndex);
  if (snapshot === null) {
    return "";
  }
  sendDomSnapshot(snapshot);
  return snapshot.id;
}

/**
 * Builds the final page snapshot, bypassing the throttle.
 *
 * WHY it bypasses the throttle and does NOT send the snapshot itself: the final
 * state of the page is where the defect is usually visible, so it is never
 * "not significant enough"; and it is returned to the service worker as a reply
 * so it can be stored while the session is still accepting data.
 */
export function buildFinalSnapshot(): DomSnapshot | null {
  if (!isRecordingActive) {
    return null;
  }
  return maybeTakeSnapshot("session-stop", activeSessionId, -1);
}

/**
 * Captures the element's context and returns its id.
 */
function captureAndSendElementContext(element: Element): string {
  try {
    const context: ElementContext = captureElementContext(element);
    context.sessionId = activeSessionId;
    sendElementContext(context);
    return context.id;
  } catch (captureError: unknown) {
    // Context capture must never break the recording. Losing one context is a
    // small evidence gap; throwing here would lose the whole interaction.
    return "";
  }
}

// -----------------------------------------------------------------------------
// Target resolution
// -----------------------------------------------------------------------------

/**
 * Resolves the true event target, piercing OPEN shadow roots.
 *
 * WHY: event.target reports the shadow HOST, not the button the user actually
 * clicked. composedPath()[0] is the real element. Closed shadow roots cannot be
 * pierced at all — composedPath stops at the host — which is exactly why the
 * locator carries an isClosedShadowHost flag.
 */
export function getRealEventTarget(event: Event): Element | null {
  if (typeof event.composedPath === "function") {
    const path: EventTarget[] = event.composedPath();
    for (let index = 0; index < path.length; index = index + 1) {
      const candidate: EventTarget = path[index];
      if (candidate instanceof Element) {
        return candidate;
      }
    }
  }
  if (event.target instanceof Element) {
    return event.target;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Sensitive-field detection (first line of defence)
// -----------------------------------------------------------------------------

const SENSITIVE_FIELD_WORDS: readonly string[] = [
  "password", "passwd", "pwd", "otp", "one-time", "onetime", "cvv", "cvc",
  "card", "cardnumber", "iban", "national-id", "nationalid", "nid", "ssn",
  "secret", "token", "pin", "securitycode", "security-code",
];

/**
 * True when a field should never have its typed value stored.
 *
 * WHY it is duplicated here as well as in ai/redact.ts: defence in depth. This
 * one stops the value reaching disk at all; redact.ts stops anything that
 * slipped through reaching the network.
 */
export function isSensitiveField(element: Element): boolean {
  if (element instanceof HTMLInputElement && element.type === "password") {
    return true;
  }

  const identifyingText: string = [
    element.getAttribute("name") ?? "",
    element.getAttribute("id") ?? "",
    element.getAttribute("autocomplete") ?? "",
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("placeholder") ?? "",
    element.getAttribute("data-testid") ?? "",
  ].join(" ").toLowerCase();

  for (let index = 0; index < SENSITIVE_FIELD_WORDS.length; index = index + 1) {
    if (identifyingText.includes(SENSITIVE_FIELD_WORDS[index])) {
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Typing
// -----------------------------------------------------------------------------

/** Cancels any buffered typing without emitting it. */
function clearPendingInput(): void {
  if (pendingInput !== null) {
    window.clearTimeout(pendingInput.flushTimerId);
    pendingInput = null;
  }
}

/**
 * Input types that fire `input` events but are NOT text entry.
 *
 * Each of these needs a different Playwright call than fill(), and treating
 * them as typing produces a spec that does not run: Playwright rejects
 * fill() on a checkbox outright.
 */
const NON_TEXT_INPUT_TYPES: readonly string[] = [
  "checkbox", "radio", "file", "button", "submit", "reset", "image",
  "range", "color",
];

/**
 * Reads the current value of anything a user can TYPE into.
 * Returns null when the element is not a text-entry control.
 */
function readEditableValue(element: Element): string | null {
  if (element instanceof HTMLInputElement) {
    const inputType: string = (element.type ?? "text").toLowerCase();
    if (NON_TEXT_INPUT_TYPES.includes(inputType)) {
      return null;   // handleChange deals with these.
    }
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return element.innerText;
  }
  return null;
}

/**
 * Emits the buffered typing as a single "input" event.
 * Redaction of the VALUE happens here, at the earliest possible moment, so a
 * password never even reaches IndexedDB.
 */
export function flushPendingInput(): void {
  if (pendingInput === null) {
    return;
  }
  window.clearTimeout(pendingInput.flushTimerId);

  const element: Element = pendingInput.element;
  const rawValue: string = pendingInput.latestValue;
  pendingInput = null;

  const event: RecordedEvent = createBaseEvent("input");
  event.locator = getElementSelector(element);

  if (isSensitiveField(element)) {
    event.value = "[REDACTED:password]";
    event.valueWasRedacted = true;
  } else {
    event.value = rawValue;
    event.valueWasRedacted = false;
  }

  event.elementContextId = captureAndSendElementContext(element);
  sendEvent(event);
}

/**
 * Buffers typing.
 *
 * WHY: recording every keystroke would produce a forty-line Playwright script
 * for one search box and would bury the AI in noise. We keep only the final
 * value of the field, which is what a human step ("enter the tenant ID") means.
 */
export function handleInput(nativeEvent: Event): void {
  if (!isRecordingActive) {
    return;
  }
  const target: Element | null = getRealEventTarget(nativeEvent);
  if (target === null) {
    return;
  }

  const currentValue: string | null = readEditableValue(target);
  if (currentValue === null) {
    return;
  }

  if (pendingInput !== null && pendingInput.element !== target) {
    flushPendingInput();
  }

  if (pendingInput === null) {
    pendingInput = { element: target, latestValue: currentValue, flushTimerId: 0 };
  } else {
    pendingInput.latestValue = currentValue;
    window.clearTimeout(pendingInput.flushTimerId);
  }

  pendingInput.flushTimerId =
    window.setTimeout(flushPendingInput, INPUT_COALESCE_DELAY_MS);
}

// -----------------------------------------------------------------------------
// Scrolling
// -----------------------------------------------------------------------------

/**
 * Remembers the most recent scroll without recording it yet.
 *
 * WHY it is deferred: an unconditional scroll event fires dozens of times per
 * second and means nothing on its own. A scroll only matters when the tester
 * then interacted with something, which is why emitPendingScrollIfRecent() is
 * called from the click and input handlers rather than from here.
 */
export function handleScroll(): void {
  if (!isRecordingActive) {
    return;
  }
  pendingScroll = {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    wallClockMs: Date.now(),
    pageUrl: window.location.href,
    pageTitle: document.title,
  };
}

/**
 * Emits the buffered scroll, but only if it happened just before this action.
 */
function emitPendingScrollIfRecent(): void {
  if (pendingScroll === null) {
    return;
  }
  const ageMs: number = Date.now() - pendingScroll.wallClockMs;
  const scroll: PendingScroll = pendingScroll;
  pendingScroll = null;

  if (ageMs > SCROLL_RELEVANCE_WINDOW_MS) {
    return;   // Idle scrolling that led nowhere. Not evidence.
  }

  const event: RecordedEvent = createBaseEvent("scroll");
  event.wallClockMs = scroll.wallClockMs;
  event.pageUrl = scroll.pageUrl;
  event.pageTitle = scroll.pageTitle;
  event.value = String(scroll.scrollX) + "," + String(scroll.scrollY);
  sendEvent(event);
}

// -----------------------------------------------------------------------------
// Clicks
// -----------------------------------------------------------------------------

/**
 * True when a click is Chrome's synthetic implicit-form-submission click.
 *
 * Three signals together, because none is conclusive alone:
 *  - it landed on a submit control;
 *  - an Enter key press happened a moment ago;
 *  - it carries no pointer coordinates, because no pointer was involved.
 *
 * A tester who really did press Enter and then click Submit within 400 ms
 * would lose that second click. That is the right trade: a duplicated
 * submission in a generated spec is a bug the tester has to debug, whereas a
 * missing redundant click changes nothing about what the test proves.
 */
function isImplicitSubmitClick(nativeEvent: MouseEvent, target: Element): boolean {
  const sinceEnterMs: number = Date.now() - lastEnterPressWallClockMs;
  if (lastEnterPressWallClockMs === 0 || sinceEnterMs > IMPLICIT_SUBMIT_WINDOW_MS) {
    return false;
  }

  const hasPointerCoordinates: boolean =
    nativeEvent.clientX !== 0 || nativeEvent.clientY !== 0;
  if (hasPointerCoordinates) {
    return false;
  }

  const isSubmitControl: boolean =
    // A <button> with no type attribute defaults to type="submit", and the
    // DOM property already reflects that default, so checking it is enough.
    (target instanceof HTMLButtonElement && target.type === "submit")
    || (target instanceof HTMLInputElement && target.type === "submit");

  return isSubmitControl;
}

/**
 * Handles a click: locator, element context, and possibly a full snapshot.
 */
export function handleClick(nativeEvent: MouseEvent): void {
  if (!isRecordingActive) {
    return;
  }

  // A double-click fires click(detail=1), click(detail=2), then dblclick.
  // Recording the second click would put a duplicate step in the spec, so we
  // drop any click that the browser has already told us is part of a multi-click
  // sequence. The FIRST click is genuinely indistinguishable at this moment, so
  // codegen removes it afterwards when it sees the dblclick that followed.
  if (nativeEvent.detail > 1) {
    return;
  }

  const target: Element | null = getRealEventTarget(nativeEvent);
  if (target === null) {
    return;
  }

  // Chrome dispatches a synthetic click on the submit button when Enter is
  // pressed inside a form. Recording it as well as the key press makes the
  // generated spec submit twice on replay.
  if (isImplicitSubmitClick(nativeEvent, target)) {
    return;
  }

  // Typing before a click must be recorded first, or the script replays the
  // click before the value that made it meaningful.
  flushPendingInput();
  emitPendingScrollIfRecent();

  lastClickedElement = target;
  lastClickWallClockMs = Date.now();

  const event: RecordedEvent = createBaseEvent("click");
  event.locator = getElementSelector(target);
  event.clientX = Math.round(nativeEvent.clientX);
  event.clientY = Math.round(nativeEvent.clientY);
  event.elementContextId = captureAndSendElementContext(target);
  event.domSnapshotId = takeSnapshotIfSignificant("interaction", -1);

  sendEvent(event);
}

/**
 * Handles a double click. Recorded separately because replaying it as two
 * single clicks is not equivalent in most applications.
 */
export function handleDoubleClick(nativeEvent: MouseEvent): void {
  if (!isRecordingActive) {
    return;
  }
  const target: Element | null = getRealEventTarget(nativeEvent);
  if (target === null) {
    return;
  }

  const event: RecordedEvent = createBaseEvent("dblclick");
  event.locator = getElementSelector(target);
  event.clientX = Math.round(nativeEvent.clientX);
  event.clientY = Math.round(nativeEvent.clientY);
  event.elementContextId = captureAndSendElementContext(target);
  sendEvent(event);
}

// -----------------------------------------------------------------------------
// Selects, checkboxes and radios
// -----------------------------------------------------------------------------

/**
 * Records select / checkbox / radio changes.
 */
export function handleChange(nativeEvent: Event): void {
  if (!isRecordingActive) {
    return;
  }
  const target: Element | null = getRealEventTarget(nativeEvent);
  if (target === null) {
    return;
  }

  if (target instanceof HTMLSelectElement) {
    const event: RecordedEvent = createBaseEvent("select-option");
    event.locator = getElementSelector(target);
    event.value = target.value;
    event.elementContextId = captureAndSendElementContext(target);
    sendEvent(event);
    return;
  }

  if (target instanceof HTMLInputElement) {
    const inputType: string = (target.type ?? "text").toLowerCase();

    if (inputType === "checkbox" || inputType === "radio") {
      const eventType: RecordedEventType = target.checked ? "check" : "uncheck";
      const event: RecordedEvent = createBaseEvent(eventType);
      event.locator = getElementSelector(target);
      event.value = target.value;
      event.elementContextId = captureAndSendElementContext(target);
      sendEvent(event);
      return;
    }

    // range and color fire `input` but cannot be typed into. Playwright can
    // still set them with fill(), so they are recorded as an input event here
    // where the FINAL value is known, rather than through the typing buffer.
    if (inputType === "range" || inputType === "color") {
      const event: RecordedEvent = createBaseEvent("input");
      event.locator = getElementSelector(target);
      event.value = target.value;
      event.elementContextId = captureAndSendElementContext(target);
      sendEvent(event);
      return;
    }

    // A file picker cannot be replayed from a recording: the path is on the
    // tester's machine. Record it so the AI knows a file was chosen, and let
    // codegen emit a comment rather than an uncallable statement.
    if (inputType === "file") {
      const event: RecordedEvent = createBaseEvent("input");
      event.locator = getElementSelector(target);
      event.value = "[FILE_UPLOAD]";
      event.valueWasRedacted = true;
      event.elementContextId = captureAndSendElementContext(target);
      sendEvent(event);
    }
  }
}

// -----------------------------------------------------------------------------
// Keyboard
// -----------------------------------------------------------------------------

/** The only keys that change application state on their own. */
const RECORDED_KEYS: readonly string[] = ["Enter", "Tab", "Escape"];

/**
 * Records Enter / Tab / Escape only.
 *
 * WHY only these three: every other keystroke is already represented by the
 * coalesced "input" event, and recording them individually would double the
 * length of the generated spec for no added information.
 */
export function handleKeyDown(nativeEvent: KeyboardEvent): void {
  if (!isRecordingActive) {
    return;
  }
  if (!RECORDED_KEYS.includes(nativeEvent.key)) {
    return;
  }

  if (nativeEvent.key === "Enter") {
    flushPendingInput();
    lastEnterPressWallClockMs = Date.now();
  }

  const target: Element | null = getRealEventTarget(nativeEvent);
  const event: RecordedEvent = createBaseEvent("press-key");
  event.value = nativeEvent.key;

  if (target !== null && target !== document.body
      && target !== document.documentElement) {
    event.locator = getElementSelector(target);
  }

  sendEvent(event);
}

// -----------------------------------------------------------------------------
// Hover
// -----------------------------------------------------------------------------

/**
 * True when a mutation plausibly belongs to the element being hovered.
 *
 * WHY this exists: the first version of the hover heuristic watched the whole
 * document and treated ANY mutation inside a 250 ms window as proof that the
 * hover changed something. On a real page - where a status line updates, a
 * spinner ticks, or a framework re-renders asynchronously - that fires
 * constantly. A single short session produced six spurious hover events, which
 * is precisely the noise the heuristic was supposed to prevent.
 *
 * A mutation counts only when it is inside the hovered element, inside its
 * containing block, or is a node newly attached anywhere while that element is
 * hovered AND positioned near it (tooltips and popovers are usually portalled
 * to the end of <body>, so they are not descendants).
 */
function isMutationRelatedToElement(
  record: MutationRecord,
  hovered: Element,
): boolean {
  const mutationTarget: Node = record.target;

  // Inside the hovered element, or inside its immediate container.
  if (hovered.contains(mutationTarget)) {
    return isInterestingMutation(record);
  }
  const container: Element | null = hovered.parentElement;
  if (container !== null && container.contains(mutationTarget)
      && isInterestingMutation(record)) {
    return true;
  }

  // A portalled tooltip or popover: newly attached, and visually near us.
  if (record.addedNodes.length > 0) {
    const hoveredBox: DOMRect = hovered.getBoundingClientRect();
    for (let index = 0; index < record.addedNodes.length; index = index + 1) {
      const added: Node = record.addedNodes[index];
      if (!(added instanceof Element)) {
        continue;
      }
      const addedBox: DOMRect = added.getBoundingClientRect();
      if (addedBox.width === 0 && addedBox.height === 0) {
        continue;
      }
      const horizontalGap: number = Math.max(
        hoveredBox.left - addedBox.right, addedBox.left - hoveredBox.right, 0);
      const verticalGap: number = Math.max(
        hoveredBox.top - addedBox.bottom, addedBox.top - hoveredBox.bottom, 0);
      if (horizontalGap < 120 && verticalGap < 120) {
        return true;
      }
    }
  }

  return false;
}

/** True for the mutation kinds that represent a visible state change. */
function isInterestingMutation(record: MutationRecord): boolean {
  if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
    return true;
  }
  if (record.type !== "attributes") {
    return false;
  }
  return record.attributeName === "class"
    || record.attributeName === "style"
    || record.attributeName === "aria-expanded"
    || record.attributeName === "aria-hidden"
    || record.attributeName === "hidden";
}

/**
 * Records a hover ONLY when it caused a visible DOM change.
 *
 * The decision, stated plainly: unconditional hover recording produces dozens
 * of events per minute of pointer movement, which floods both the generated
 * spec and the AI's token budget with noise. But tooltip, menu and
 * dropdown-on-hover defects are a real and common bug class that would be
 * invisible without it. So we watch for a mutation for 250 ms and record the
 * hover only if one arrives.
 *
 * KNOWN LIMITATION: a CSS-only :hover effect — a colour change with no DOM
 * mutation — produces nothing for the observer to see and will not be recorded.
 */
export function handleMouseOver(nativeEvent: MouseEvent): void {
  if (!isRecordingActive) {
    return;
  }
  const nowMs: number = Date.now();
  if (nowMs - lastHoverRecordedAtMs < HOVER_THROTTLE_MS) {
    return;
  }

  const target: Element | null = getRealEventTarget(nativeEvent);
  if (target === null || document.body === null) {
    return;
  }

  // The pointer resting on something the tester just clicked is not a
  // discovery, it is where the mouse happens to be.
  if (target === lastClickedElement
      && nowMs - lastClickWallClockMs < POST_CLICK_HOVER_SUPPRESSION_MS) {
    return;
  }

  let sawMutation: boolean = false;
  const observer: MutationObserver = new MutationObserver(
    function onMutation(records: MutationRecord[]): void {
      for (let index = 0; index < records.length; index = index + 1) {
        if (isMutationRelatedToElement(records[index], target)) {
          sawMutation = true;
          return;
        }
      }
    },
  );

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-expanded", "hidden"],
  });

  window.setTimeout(function decideAboutHover(): void {
    observer.disconnect();
    if (!sawMutation || !isRecordingActive) {
      return;
    }
    lastHoverRecordedAtMs = Date.now();

    const event: RecordedEvent = createBaseEvent("hover");
    event.locator = getElementSelector(target);
    event.elementContextId = captureAndSendElementContext(target);
    sendEvent(event);
  }, HOVER_MUTATION_WINDOW_MS);
}

// -----------------------------------------------------------------------------
// SPA route changes, reported from the MAIN world across the bridge
// -----------------------------------------------------------------------------

/**
 * Records an in-app route change reported by the page-world history patch.
 */
export function handleUrlChange(pageUrl: string, pageTitle: string): void {
  if (!isRecordingActive) {
    return;
  }
  const event: RecordedEvent = createBaseEvent("url-change");
  event.pageUrl = pageUrl;
  event.pageTitle = pageTitle;
  event.domSnapshotId = takeSnapshotIfSignificant("url-change", -1);
  sendEvent(event);
}
