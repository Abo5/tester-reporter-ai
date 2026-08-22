// =============================================================================
// src/background/message-router.ts
// Typed dispatch for every message the service worker receives.
//
// The service worker is a ROUTER and a COORDINATOR only. It holds no durable
// state of its own: the session state lives in chrome.storage.session and
// everything else lives in IndexedDB, because the worker can be terminated
// between any two messages.
// =============================================================================

import type {
  ExtensionMessage,
  ContentHandshakeReply,
  StatusUpdateMessage,
} from "../shared/messages";
import { asExtensionMessage, sendMessageIgnoringNoReceiver } from "../shared/messages";
import type {
  RecordedEvent,
  DomSnapshot,
  ElementContext,
  NetworkEntry,
  ConsoleEntry,
  SessionStatus,
  MediaRecordInfo,
} from "../shared/types";
import {
  readActiveState,
  writeActiveState,
  clearActiveState,
  videoOffsetForState,
  recordedDurationForState,
  type ActiveRecordingState,
} from "./session-state";
import {
  ensureOffscreenDocument,
  closeOffscreenDocument,
} from "./offscreen-manager";
import {
  rememberFrameInventory,
  clearFrameInventory,
  buildFramePath,
} from "./navigation-listener";
import {
  createSession,
  updateSession,
  getSession,
  listSessions,
  recordEventProgress,
} from "../storage/sessions";
import { appendEvent } from "../storage/events";
import {
  putDomSnapshot,
  putElementContext,
  putNetworkEntry,
  putConsoleEntry,
} from "../storage/artifacts";
import { readSettings } from "../storage/settings";
import { readQuotaStatus } from "../storage/media";
import { logInfo, logWarning, logError } from "../shared/logger";
import { formatBytes } from "../shared/time";

import { createId } from "../shared/ids";
/** Error text shown in the side panel until the next status update clears it. */
let lastErrorText: string = "";

// -----------------------------------------------------------------------------
// Status broadcasting
// -----------------------------------------------------------------------------

/**
 * Tells the side panel (and anyone else listening) where we are.
 * Broadcast rather than targeted, because the side panel may not be open.
 */
export async function broadcastStatus(): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();

  let status: SessionStatus | "idle" = "idle";
  let sessionId: string = "";
  let eventCount: number = 0;
  let recordedDurationMs: number = 0;
  let networkFailureCount: number = 0;
  let consoleErrorCount: number = 0;

  if (state !== null) {
    status = state.status;
    sessionId = state.sessionId;
    eventCount = state.eventCount;
    recordedDurationMs = recordedDurationForState(state);

    const session = await getSession(state.sessionId);
    if (session !== null) {
      networkFailureCount = session.networkFailureCount;
      consoleErrorCount = session.consoleErrorCount;
    }
  }

  const message: StatusUpdateMessage = {
    kind: "sw/status",
    status: status,
    sessionId: sessionId,
    eventCount: eventCount,
    recordedDurationMs: recordedDurationMs,
    networkFailureCount: networkFailureCount,
    consoleErrorCount: consoleErrorCount,
    errorText: lastErrorText,
  };

  await sendMessageIgnoringNoReceiver(message);
}

/**
 * Tells every frame in one TAB whether it should be capturing.
 *
 * WHY this is not chrome.runtime.sendMessage: runtime.sendMessage reaches
 * extension contexts (the side panel, the offscreen document, extension pages)
 * but NOT content scripts. Content scripts are only reachable with
 * chrome.tabs.sendMessage. Without this call, a page that was already open when
 * the tester pressed Record would never learn that recording started, because
 * its handshake already happened and answered "no".
 *
 * Failures are swallowed on purpose: a tab with no content script (a PDF
 * viewer, a chrome:// page, a frame that has not finished loading) is a normal
 * state, not an error.
 */
async function notifyTabOfRecordingState(
  tabId: number,
  status: SessionStatus | "idle",
  sessionId: string,
): Promise<void> {
  const message: StatusUpdateMessage = {
    kind: "sw/status",
    status: status,
    sessionId: sessionId,
    eventCount: 0,
    recordedDurationMs: 0,
    networkFailureCount: 0,
    consoleErrorCount: 0,
    errorText: "",
  };

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (sendError: unknown) {
    // No content script in that tab. Normal, not a failure.
  }
}

/**
 * Broadcasts at most a few times a second.
 *
 * WHY: every recorded click would otherwise trigger a status broadcast, and
 * each broadcast reads the session row back out of IndexedDB. A fast typist
 * would generate more storage traffic keeping a counter live than recording the
 * evidence itself.
 */
let lastBroadcastAtMs: number = 0;
const BROADCAST_THROTTLE_MS: number = 400;

async function broadcastStatusThrottled(): Promise<void> {
  const nowMs: number = Date.now();
  if (nowMs - lastBroadcastAtMs < BROADCAST_THROTTLE_MS) {
    return;
  }
  lastBroadcastAtMs = nowMs;
  await broadcastStatus();
}

/** Records an error to surface in the side panel, then broadcasts it. */
async function reportError(context: string, error: unknown): Promise<void> {
  lastErrorText = String(error);
  logError(context, "Reporting to the UI.", error);
  await broadcastStatus();
}

// -----------------------------------------------------------------------------
// Recording lifecycle
// -----------------------------------------------------------------------------

/**
 * Wraps chrome.tabCapture.getMediaStreamId in a promise.
 *
 * WHY it is written out by hand instead of awaiting the API directly: the
 * promise-returning form of this method is not available in every Chrome
 * version, and the callback form always is. Wrapping it once here means the
 * rest of the code can await it regardless.
 *
 * VERIFY: the exact signature, and whether this call must happen in direct
 * response to a user gesture, against the current tabCapture documentation.
 */
function requestTabStreamId(tabId: number): Promise<string> {
  return new Promise<string>(function executor(resolve, reject): void {
    try {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        function onStreamId(streamId: string): void {
          const lastError: chrome.runtime.LastError | undefined =
            chrome.runtime.lastError;
          if (lastError !== undefined) {
            reject(new Error(lastError.message ?? "Tab capture was refused."));
            return;
          }
          if (typeof streamId !== "string" || streamId === "") {
            reject(new Error("Tab capture returned no stream id."));
            return;
          }
          resolve(streamId);
        },
      );
    } catch (captureError: unknown) {
      reject(captureError);
    }
  });
}

/**
 * Starts a recording session on the given tab.
 *
 * WHY the tabCapture stream id is obtained HERE: chrome.tabCapture is available
 * to the service worker and extension pages, not to an offscreen document, so
 * the worker mints the id and hands it over.
 *
 * VERIFY: whether getMediaStreamId must be called in direct response to a user
 * gesture. Our understanding is that the extension must have been invoked on
 * the tab, which the side-panel button click satisfies.
 */
async function handleStartRecording(
  tabId: number,
  captureMicrophone: boolean,
): Promise<void> {
  const existing: ActiveRecordingState | null = await readActiveState();
  if (existing !== null) {
    throw new Error("A recording is already in progress.");
  }

  const quota = await readQuotaStatus();
  if (!quota.canStartRecording) {
    throw new Error(
      "Not enough free storage to record safely (only "
      + formatBytes(quota.freeBytes)
      + " available). Delete an old session or free up disk space.",
    );
  }

  const tab: chrome.tabs.Tab = await chrome.tabs.get(tabId);
  const settings = await readSettings();
  const sessionId: string = createId();
  const startedAtMs: number = Date.now();

  await createSession({
    id: sessionId,
    name: tab.title ?? "Untitled session",
    originTabId: tabId,
    originUrl: tab.url ?? "",
    originTitle: tab.title ?? "",
    startedAtMs: startedAtMs,
    reportLanguage: settings.reportLanguage,
  });

  const state: ActiveRecordingState = {
    sessionId: sessionId,
    status: "recording",
    tabId: tabId,
    startedAtMs: startedAtMs,
    accumulatedPausedMs: 0,
    pauseStartedAtMs: 0,
    eventCount: 0,
    captureMicrophone: captureMicrophone,
  };
  await writeActiveState(state);
  clearFrameInventory();

  await ensureOffscreenDocument();

  const tabStreamId: string = await requestTabStreamId(tabId);

  await sendMessageIgnoringNoReceiver({
    kind: "offscreen/start",
    tabStreamId: tabStreamId,
    captureMicrophone: captureMicrophone,
    sessionId: sessionId,
  });

  // Tell the already-injected content scripts in THIS TAB to begin listening.
  // Content scripts cannot hear runtime.sendMessage, so this is required.
  await notifyTabOfRecordingState(tabId, "recording", sessionId);

  lastErrorText = "";
  await broadcastStatus();
  logInfo("router", "Recording started for session " + sessionId + ".");
}

/**
 * Pauses capture. Both the media recorder and the event recorder stop.
 * WHY pauseStartedAtMs is tracked: so video offsets stay correct afterwards.
 */
async function handlePauseRecording(): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  state.status = "paused";
  state.pauseStartedAtMs = Date.now();
  await writeActiveState(state);
  await notifyTabOfRecordingState(state.tabId, "paused", state.sessionId);
  await sendMessageIgnoringNoReceiver({ kind: "offscreen/pause" });
  await broadcastStatus();
}

/**
 * Resumes capture and folds the pause duration into the accumulated total.
 */
async function handleResumeRecording(): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "paused") {
    return;
  }
  const pausedForMs: number = Date.now() - state.pauseStartedAtMs;
  state.accumulatedPausedMs = state.accumulatedPausedMs + pausedForMs;
  state.pauseStartedAtMs = 0;
  state.status = "recording";
  await writeActiveState(state);
  await notifyTabOfRecordingState(state.tabId, "recording", state.sessionId);
  await sendMessageIgnoringNoReceiver({ kind: "offscreen/resume" });
  await broadcastStatus();
}

/**
 * Stops capture and hands over to the offscreen document to finalise the file.
 *
 * The session is NOT completed here: it completes when offscreen/finished
 * arrives, because only the offscreen document knows when the Blob is safely
 * written.
 */
async function handleStopRecording(): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null) {
    return;
  }

  // Fold in a trailing pause so the recorded duration is right either way.
  if (state.status === "paused" && state.pauseStartedAtMs > 0) {
    state.accumulatedPausedMs =
      state.accumulatedPausedMs + (Date.now() - state.pauseStartedAtMs);
    state.pauseStartedAtMs = 0;
  }
  state.status = "processing";
  await writeActiveState(state);

  const stoppedAtMs: number = Date.now();
  await updateSession(state.sessionId, {
    status: "processing",
    stoppedAtMs: stoppedAtMs,
    wallClockDurationMs: stoppedAtMs - state.startedAtMs,
    recordedDurationMs: recordedDurationForState(state),
    eventCount: state.eventCount,
  });

  await notifyTabOfRecordingState(state.tabId, "idle", "");
  await sendMessageIgnoringNoReceiver({ kind: "offscreen/stop" });
  await broadcastStatus();

  // Safety net: if the offscreen document never answers (it crashed, or the
  // stream was revoked), finish the session anyway after a short grace period
  // so the tester still gets their events and their generated script.
  setTimeout(function finishWithoutMediaIfStillProcessing(): void {
    void finaliseSessionWithoutMediaIfNeeded(state.sessionId);
  }, 15000);
}

/**
 * Completes a session that is still stuck in "processing" because the offscreen
 * document never reported back.
 *
 * DESIGN INVARIANT: the tester never loses their recording because a later step
 * failed. Losing the video is bad; losing the events and the script as well
 * would be unacceptable.
 */
async function finaliseSessionWithoutMediaIfNeeded(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (session === null || session.status !== "processing") {
    return;
  }

  logWarning("router", "Offscreen never reported; finishing without media.");
  const failedMedia: MediaRecordInfo = {
    ...session.media,
    state: "failed",
    failureReason:
      "The recorder did not report back, so no video was stored for this "
      + "session. Every other artifact was kept.",
  };

  await updateSession(sessionId, { status: "ready", media: failedMedia });
  await clearActiveState();
  await closeOffscreenDocument();
  await broadcastStatus();
  await openReviewPage(sessionId);
}

/**
 * Finishes any session left stuck in "processing" from a previous browser run.
 *
 * WHY it exists: handleStopRecording() sets a 15-second safety timer, but the
 * service worker can be terminated (or the browser closed) before that timer
 * fires, leaving a session that the UI would show as permanently "finishing".
 * Reconciling at startup means the tester still gets their events and their
 * generated script even if the browser died mid-save.
 */
export async function reconcileStuckSessions(): Promise<void> {
  const activeState: ActiveRecordingState | null = await readActiveState();
  if (activeState !== null) {
    return;   // A recording really is in progress; leave it alone.
  }

  const sessions = await listSessions();
  for (let index = 0; index < sessions.length; index = index + 1) {
    const session = sessions[index];
    if (session.status !== "processing" && session.status !== "recording"
        && session.status !== "paused") {
      continue;
    }

    logWarning("router", "Recovering session " + session.id
      + " left in state '" + session.status + "'.");

    await updateSession(session.id, {
      status: "ready",
      media: {
        ...session.media,
        state: session.media.mediaId === "" ? "failed" : session.media.state,
        failureReason:
          session.media.mediaId === ""
            ? "The browser closed before the recording was saved, so no video "
              + "was stored. Every other artifact was kept."
            : session.media.failureReason,
      },
    });
  }
}

/**
 * Handles the offscreen document reporting a finished recording.
 */
async function handleOffscreenFinished(
  sessionId: string,
  info: MediaRecordInfo,
): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  const recordedDurationMs: number =
    state === null ? info.durationMs : recordedDurationForState(state);

  await updateSession(sessionId, {
    status: "ready",
    media: info,
    recordedDurationMs: info.durationMs > 0 ? info.durationMs : recordedDurationMs,
  });

  await clearActiveState();
  await closeOffscreenDocument();
  lastErrorText = "";
  await broadcastStatus();
  await openReviewPage(sessionId);
  logInfo("router", "Session " + sessionId + " is ready.");
}

/**
 * Handles the offscreen document reporting a failure.
 * The session still completes: only the video is lost.
 */
async function handleOffscreenError(sessionId: string, reason: string): Promise<void> {
  logWarning("router", "Offscreen error: " + reason);

  const session = await getSession(sessionId);
  if (session !== null) {
    await updateSession(sessionId, {
      status: "ready",
      media: { ...session.media, state: "failed", failureReason: reason },
    });
  }

  await clearActiveState();
  await closeOffscreenDocument();
  lastErrorText = "Recording problem: " + reason;
  await broadcastStatus();
  await openReviewPage(sessionId);
}

/**
 * Opens the review page for a session in a new tab.
 *
 * WHY the post-stop pipeline runs THERE and not here: a normal document is not
 * terminated for being idle, so codegen, evidence bundling and the AI call are
 * safe from the service-worker lifecycle. It is also where the tester is
 * looking.
 */
async function openReviewPage(sessionId: string): Promise<void> {
  const url: string = chrome.runtime.getURL(
    "review/review.html?session=" + encodeURIComponent(sessionId),
  );
  try {
    await chrome.tabs.create({ url: url });
  } catch (createError: unknown) {
    logWarning("router", "Could not open the review page.", createError);
  }
}

// -----------------------------------------------------------------------------
// Captured-data handlers
// -----------------------------------------------------------------------------

/**
 * Persists one recorded event and stamps it with the corrected video offset.
 *
 * WHY the offset is computed here and not in the content script: the content
 * script does not know how long the session has been paused for.
 */
async function handleRecordedEvent(
  event: RecordedEvent,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;   // Dropped on purpose: we are paused or not recording.
  }

  const stamped: RecordedEvent = { ...event };
  stamped.sessionId = state.sessionId;
  stamped.index = state.eventCount;
  stamped.videoOffsetMs = videoOffsetForState(state, stamped.wallClockMs);
  stamped.tabId = sender.tab?.id ?? state.tabId;
  stamped.frameId = sender.frameId ?? 0;

  if (stamped.locator !== null && stamped.frameId !== 0) {
    stamped.locator = {
      ...stamped.locator,
      framePath: await buildFramePath(stamped.tabId, stamped.frameId),
    };
  }

  await appendEvent(stamped);

  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);

  // ONE read-modify-write for both the counter and the visited-URL list.
  await recordEventProgress(state.sessionId, state.eventCount, stamped.pageUrl);
  await broadcastStatusThrottled();
}

/** Persists one pruned page snapshot. */
async function handleDomSnapshot(snapshot: DomSnapshot): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  const stamped: DomSnapshot = { ...snapshot };
  stamped.sessionId = state.sessionId;
  stamped.videoOffsetMs = videoOffsetForState(state, stamped.wallClockMs);
  // The snapshot was taken alongside the event that is about to be stored, so
  // the current counter value is that event's index.
  if (stamped.eventIndex === -1) {
    stamped.eventIndex = state.eventCount;
  }
  await putDomSnapshot(stamped);

  const session = await getSession(state.sessionId);
  if (session !== null) {
    await updateSession(state.sessionId, {
      domSnapshotCount: session.domSnapshotCount + 1,
    });
  }
}

/** Persists one element context. */
async function handleElementContext(context: ElementContext): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  const stamped: ElementContext = { ...context };
  stamped.sessionId = state.sessionId;
  if (stamped.eventIndex === -1) {
    stamped.eventIndex = state.eventCount;
  }
  await putElementContext(stamped);
}

/** Persists one network entry reported by the page-world patch. */
async function handleNetworkEntry(entry: NetworkEntry): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  const stamped: NetworkEntry = { ...entry };
  stamped.sessionId = state.sessionId;
  stamped.videoOffsetMs = videoOffsetForState(state, stamped.startedAtMs);
  await putNetworkEntry(stamped);

  const session = await getSession(state.sessionId);
  if (session !== null) {
    await updateSession(state.sessionId, {
      networkEntryCount: session.networkEntryCount + 1,
      networkFailureCount:
        session.networkFailureCount + (stamped.isFailure ? 1 : 0),
    });
  }
  if (stamped.isFailure) {
    await broadcastStatus();
  }
}

/** Persists one console entry. */
async function handleConsoleEntry(entry: ConsoleEntry): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  const stamped: ConsoleEntry = { ...entry };
  stamped.sessionId = state.sessionId;
  stamped.videoOffsetMs = videoOffsetForState(state, stamped.wallClockMs);
  await putConsoleEntry(stamped);

  if (stamped.level === "error" || stamped.level === "unhandled-rejection") {
    const session = await getSession(state.sessionId);
    if (session !== null) {
      await updateSession(state.sessionId, {
        consoleErrorCount: session.consoleErrorCount + 1,
      });
    }
    await broadcastStatus();
  }
}

/** Records a free-text marker the tester dropped mid-session. */
async function handleTesterNote(text: string): Promise<void> {
  const state: ActiveRecordingState | null = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  const wallClockMs: number = Date.now();
  await appendEvent({
    index: state.eventCount,
    sessionId: state.sessionId,
    type: "tester-note",
    wallClockMs: wallClockMs,
    videoOffsetMs: videoOffsetForState(state, wallClockMs),
    pageUrl: "",
    pageTitle: "",
    tabId: state.tabId,
    frameId: 0,
    locator: null,
    value: text,
    valueWasRedacted: false,
    clientX: -1,
    clientY: -1,
    domSnapshotId: "",
    elementContextId: "",
  });
  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);
  await broadcastStatus();
}

// -----------------------------------------------------------------------------
// The router itself
// -----------------------------------------------------------------------------

/**
 * Handles one message. Returns a reply value for the messages that need one.
 *
 * The switch is exhaustive over ExtensionMessage, so adding a message kind
 * makes the compiler point here.
 */
async function routeMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.kind) {
    case "ui/start-recording":
      await handleStartRecording(message.tabId, message.captureMicrophone);
      return { ok: true };

    case "ui/pause-recording":
      await handlePauseRecording();
      return { ok: true };

    case "ui/resume-recording":
      await handleResumeRecording();
      return { ok: true };

    case "ui/stop-recording":
      await handleStopRecording();
      return { ok: true };

    case "ui/get-status":
      await broadcastStatus();
      return { ok: true };

    case "ui/add-tester-note":
      await handleTesterNote(message.text);
      return { ok: true };

    case "ui/open-review-page":
      await openReviewPage(message.sessionId);
      return { ok: true };

    case "content/handshake": {
      const state: ActiveRecordingState | null = await readActiveState();
      const reply: ContentHandshakeReply = {
        isRecording: state !== null && state.status === "recording",
        sessionId: state === null ? "" : state.sessionId,
      };
      return reply;
    }

    case "content/recorded-event":
      await handleRecordedEvent(message.event, sender);
      return { ok: true };

    case "content/dom-snapshot":
      await handleDomSnapshot(message.snapshot);
      return { ok: true };

    case "content/element-context":
      await handleElementContext(message.context);
      return { ok: true };

    case "content/network-entry":
      await handleNetworkEntry(message.entry);
      return { ok: true };

    case "content/console-entry":
      await handleConsoleEntry(message.entry);
      return { ok: true };

    case "content/frame-inventory":
      rememberFrameInventory(sender.frameId ?? 0, message.frames);
      return { ok: true };

    case "offscreen/finished":
      await handleOffscreenFinished(message.sessionId, message.info);
      return { ok: true };

    case "offscreen/error":
      await handleOffscreenError(message.sessionId, message.reason);
      return { ok: true };

    case "offscreen/ready":
      logInfo("router", "Offscreen recorder is ready.");
      return { ok: true };

    // Messages the service worker SENDS but never handles.
    case "offscreen/start":
    case "offscreen/pause":
    case "offscreen/resume":
    case "offscreen/stop":
    case "sw/status":
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Installs the single onMessage listener.
 *
 * WHY the listener returns true and resolves later: chrome.runtime.onMessage
 * closes the message channel as soon as the listener returns unless it returns
 * true, and every handler here is asynchronous.
 */
export function installMessageRouter(): void {
  chrome.runtime.onMessage.addListener(function onMessage(
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean {
    const message = asExtensionMessage(rawMessage);
    if (message === null) {
      return false;
    }

    routeMessage(message, sender)
      .then(function onRouted(reply: unknown): void {
        sendResponse(reply);
      })
      .catch(function onRouteError(routeError: unknown): void {
        void reportError("router", routeError);
        sendResponse({ ok: false, error: String(routeError) });
      });

    return true;
  });
}
