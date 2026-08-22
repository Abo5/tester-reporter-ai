// =============================================================================
// src/content/recorder.ts
// ISOLATED-world entry point. Installs the listeners, relays the MAIN-world
// bridge traffic, and answers the handshake.
//
// It is injected into EVERY frame on EVERY navigation, including navigations
// that happen while nothing is being recorded. So the first thing it does is
// ask the service worker whether it should be listening at all.
// =============================================================================

import type { NetworkEntry, ConsoleEntry, ConsoleLevel } from "../shared/types";
import type {
  ContentHandshakeReply,
  FrameInventoryEntry,
  FinalSnapshotReply,
} from "../shared/messages";
import {
  asExtensionMessage,
  sendMessageIgnoringNoReceiver,
} from "../shared/messages";
import {
  readBridgeEnvelope,
  readStringField,
  readNumberField,
  type BridgeEnvelope,
} from "./bridge";
import {
  setRecordingActive,
  getRecordingActive,
  getActiveSessionId,
  handleClick,
  handleDoubleClick,
  handleInput,
  handleChange,
  handleKeyDown,
  handleMouseOver,
  handleScroll,
  handleUrlChange,
  flushPendingInput,
  takeSnapshotIfSignificant,
  buildFinalSnapshot,
} from "./event-handlers";
import { resetSnapshotScheduler } from "./snapshot-scheduler";
import { logWarning } from "../shared/logger";

import { createId } from "../shared/ids";
/** Guards against double injection into the same document. */
const INSTALL_MARKER: string = "__testerReporterAiRecorderInstalled";

/** True once the DOM listeners are attached, so we never attach twice. */
let listenersInstalled: boolean = false;

// -----------------------------------------------------------------------------
// Bridge relay: MAIN world -> service worker
// -----------------------------------------------------------------------------

/**
 * Converts a bridge network payload into a NetworkEntry and forwards it.
 *
 * WHY the isFailure flag is computed here rather than in the page world: it is
 * the definition the tester sees in the UI and the model sees in the prompt, so
 * it must have exactly one implementation. The page world is untrusted input.
 */
function relayNetworkPayload(payload: Record<string, unknown>): void {
  const statusCode: number = readNumberField(payload, "statusCode", 0);

  const entry: NetworkEntry = {
    id: createId(),
    sessionId: getActiveSessionId(),
    source: "page-world-patch",
    method: readStringField(payload, "method"),
    url: readStringField(payload, "url"),
    statusCode: statusCode,
    statusText: readStringField(payload, "statusText"),
    startedAtMs: readNumberField(payload, "startedAtMs", Date.now()),
    durationMs: readNumberField(payload, "durationMs", -1),
    videoOffsetMs: -1,   // Stamped by the service worker.
    requestBodyExcerpt: readStringField(payload, "requestBodyExcerpt"),
    responseBodyExcerpt: readStringField(payload, "responseBodyExcerpt"),
    requestHeaders: {},  // The patch does not read request headers; see 10.4.
    responseContentType: readStringField(payload, "responseContentType"),
    isFailure: statusCode === 0 || statusCode >= 400,
    initiatorPageUrl: readStringField(payload, "pageUrl"),
  };

  void sendMessageIgnoringNoReceiver({ kind: "content/network-entry", entry: entry });

  // A failed request is exactly the moment we want the page code.
  if (entry.isFailure) {
    takeSnapshotIfSignificant("network-failure", -1);
  }
}

/**
 * Narrows an untrusted level string to our ConsoleLevel union.
 */
function asConsoleLevel(candidate: string): ConsoleLevel {
  if (candidate === "warning") {
    return "warning";
  }
  if (candidate === "unhandled-rejection") {
    return "unhandled-rejection";
  }
  return "error";
}

/**
 * Converts a bridge console payload into a ConsoleEntry and forwards it.
 */
function relayConsolePayload(payload: Record<string, unknown>): void {
  const level: ConsoleLevel = asConsoleLevel(readStringField(payload, "level"));

  const entry: ConsoleEntry = {
    id: createId(),
    sessionId: getActiveSessionId(),
    level: level,
    message: readStringField(payload, "message"),
    stackExcerpt: readStringField(payload, "stackExcerpt"),
    wallClockMs: readNumberField(payload, "wallClockMs", Date.now()),
    videoOffsetMs: -1,   // Stamped by the service worker.
    pageUrl: readStringField(payload, "pageUrl"),
  };

  void sendMessageIgnoringNoReceiver({ kind: "content/console-entry", entry: entry });

  if (level === "error" || level === "unhandled-rejection") {
    takeSnapshotIfSignificant("console-error", -1);
  }
}

/**
 * Receives everything the MAIN-world script posts.
 */
function handleBridgeMessage(event: MessageEvent): void {
  const envelope: BridgeEnvelope | null = readBridgeEnvelope(event);
  if (envelope === null) {
    return;
  }
  if (!getRecordingActive()) {
    return;
  }

  if (envelope.payloadKind === "network") {
    relayNetworkPayload(envelope.payload);
    return;
  }
  if (envelope.payloadKind === "console") {
    relayConsolePayload(envelope.payload);
    return;
  }
  if (envelope.payloadKind === "url-change") {
    handleUrlChange(
      readStringField(envelope.payload, "pageUrl"),
      readStringField(envelope.payload, "pageTitle"),
    );
  }
}

// -----------------------------------------------------------------------------
// Frame inventory
// -----------------------------------------------------------------------------

/**
 * Reports the iframes in this document, so the service worker can build the
 * frameLocator() chain a nested element needs.
 *
 * KNOWN IMPERFECTION: the service worker matches a child frame to one of these
 * entries by URL. A page that embeds the SAME url twice cannot be disambiguated
 * this way, so we also report the positional index and the generated spec gets
 * a comment saying which one was assumed.
 */
function reportFrameInventory(): void {
  const iframes: NodeListOf<HTMLIFrameElement> =
    document.querySelectorAll("iframe");
  if (iframes.length === 0) {
    return;
  }

  const frames: FrameInventoryEntry[] = [];
  for (let index = 0; index < iframes.length; index = index + 1) {
    const iframe: HTMLIFrameElement = iframes[index];
    let selector: string = "iframe:nth-of-type(" + String(index + 1) + ")";

    const nameAttribute: string = iframe.getAttribute("name") ?? "";
    const idAttribute: string = iframe.getAttribute("id") ?? "";
    if (nameAttribute !== "") {
      selector = 'iframe[name="' + nameAttribute.split('"').join('\\"') + '"]';
    } else if (idAttribute !== "") {
      selector = 'iframe[id="' + idAttribute.split('"').join('\\"') + '"]';
    }

    frames.push({
      selector: selector,
      src: iframe.getAttribute("src") ?? "",
      name: nameAttribute,
      positionIndex: index,
    });
  }

  void sendMessageIgnoringNoReceiver({ kind: "content/frame-inventory", frames: frames });
}

// -----------------------------------------------------------------------------
// Listener installation
// -----------------------------------------------------------------------------

/**
 * Installs every listener in the CAPTURE phase.
 *
 * WHY capture phase: an application that calls stopPropagation() in a bubbling
 * handler — which component libraries do constantly — would otherwise hide the
 * event from us entirely.
 *
 * WHY passive on scroll: a non-passive scroll listener makes the page under
 * test feel sluggish, and a QA tool that changes the behaviour it is measuring
 * is worse than useless.
 */
function installEventListeners(): void {
  if (listenersInstalled) {
    return;
  }
  listenersInstalled = true;

  document.addEventListener("click", handleClick, true);
  document.addEventListener("dblclick", handleDoubleClick, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("mouseover", handleMouseOver, true);
  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });

  // Leaving a field finishes its value. Without this, clicking straight from
  // one input to a button recorded the click first and the typed value after.
  document.addEventListener("blur", flushPendingInput, true);

  // A pending keystroke buffer must be flushed before the document goes away.
  window.addEventListener("beforeunload", flushPendingInput, true);
  window.addEventListener("pagehide", flushPendingInput, true);

  window.addEventListener("message", handleBridgeMessage, false);
}

// -----------------------------------------------------------------------------
// Handshake and lifecycle
// -----------------------------------------------------------------------------

/**
 * Asks the service worker whether a session is active, then starts listening.
 */
async function performHandshake(): Promise<void> {
  let reply: unknown;
  try {
    reply = await chrome.runtime.sendMessage({ kind: "content/handshake" });
  } catch (handshakeError: unknown) {
    // The service worker may be starting up. A later navigation will retry.
    return;
  }

  if (typeof reply !== "object" || reply === null) {
    return;
  }
  const typedReply = reply as ContentHandshakeReply;
  if (typedReply.isRecording !== true) {
    return;
  }

  setRecordingActive(true, typedReply.sessionId);
  installEventListeners();
  resetSnapshotScheduler();
  takeSnapshotIfSignificant("first-load", -1);
  reportFrameInventory();
}

/**
 * Handles messages addressed to this content script.
 *
 * Returns true only for the final-snapshot request, because that is the one
 * message that needs a reply and Chrome closes the channel otherwise.
 */
function handleRuntimeMessage(
  rawMessage: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const message = asExtensionMessage(rawMessage);
  if (message === null) {
    return false;
  }

  if (message.kind === "sw/request-final-snapshot") {
    // Flush any half-typed value first: it is part of the final state too.
    flushPendingInput();
    const reply: FinalSnapshotReply = { snapshot: buildFinalSnapshot() };
    sendResponse(reply);
    return true;
  }

  if (message.kind === "sw/status") {
    const shouldRecord: boolean =
      message.status === "recording" || message.status === "paused";

    if (shouldRecord && !getRecordingActive()) {
      setRecordingActive(true, message.sessionId);
      installEventListeners();
      resetSnapshotScheduler();
      takeSnapshotIfSignificant("first-load", -1);
      reportFrameInventory();
      return false;
    }

    // Pausing keeps the listeners installed but stops emitting, which the
    // service worker enforces anyway; here we only handle the full stop.
    if (!shouldRecord && getRecordingActive()) {
      flushPendingInput();
      setRecordingActive(false, "");
    }
  }

  return false;
}

/**
 * Entry point. Runs once per document.
 */
function initialiseRecorder(): void {
  const globalWindow = window as unknown as Record<string, unknown>;
  if (globalWindow[INSTALL_MARKER] === true) {
    return;
  }
  globalWindow[INSTALL_MARKER] = true;

  try {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  } catch (listenerError: unknown) {
    logWarning("recorder", "Could not attach the runtime listener.", listenerError);
  }

  void performHandshake();
}

initialiseRecorder();
