// =============================================================================
// src/shared/messages.ts
// One discriminated union for every cross-context message. Every switch on
// message.kind is exhaustive, so adding a message forces the compiler to point
// at every place that must handle it.
//
// NAMESPACING MATTERS: chrome.runtime.sendMessage broadcasts to every extension
// context at once, so the side panel, the offscreen document and the review
// page all receive everything. Each listener checks the prefix and ignores what
// is not addressed to it.
// =============================================================================

import type {
  RecordedEvent,
  DomSnapshot,
  ElementContext,
  NetworkEntry,
  ConsoleEntry,
  SessionStatus,
  MediaRecordInfo,
} from "./types";

// --- Sent by the side panel / review page / options page -> service worker ---

export interface StartRecordingMessage {
  kind: "ui/start-recording";
  tabId: number;
  captureMicrophone: boolean;
}

export interface PauseRecordingMessage {
  kind: "ui/pause-recording";
}

export interface ResumeRecordingMessage {
  kind: "ui/resume-recording";
}

export interface StopRecordingMessage {
  kind: "ui/stop-recording";
}

export interface GetStatusMessage {
  kind: "ui/get-status";
}

export interface AddTesterNoteMessage {
  kind: "ui/add-tester-note";
  text: string;
}

export interface OpenReviewPageMessage {
  kind: "ui/open-review-page";
  sessionId: string;
}

// --- Sent by the content script -> service worker ----------------------------

export interface RecordedEventMessage {
  kind: "content/recorded-event";
  event: RecordedEvent;
}

export interface DomSnapshotMessage {
  kind: "content/dom-snapshot";
  snapshot: DomSnapshot;
}

export interface ElementContextMessage {
  kind: "content/element-context";
  context: ElementContext;
}

export interface PageNetworkMessage {
  kind: "content/network-entry";
  entry: NetworkEntry;
}

export interface PageConsoleMessage {
  kind: "content/console-entry";
  entry: ConsoleEntry;
}

/** The content script asks "should I be recording right now?" after injection. */
export interface ContentHandshakeMessage {
  kind: "content/handshake";
}

/** Reply to a handshake. */
export interface ContentHandshakeReply {
  isRecording: boolean;
  sessionId: string;
}

/** The parent frame reports the iframes it contains, for frame-path building. */
export interface FrameInventoryMessage {
  kind: "content/frame-inventory";
  frames: FrameInventoryEntry[];
}

export interface FrameInventoryEntry {
  /** A CSS selector that finds this iframe inside the reporting document. */
  selector: string;
  src: string;
  name: string;
  /** 0-based position among the document's iframes. */
  positionIndex: number;
}

// --- Sent by the service worker -> offscreen document ------------------------

export interface OffscreenStartMessage {
  kind: "offscreen/start";
  /**
   * Produced by chrome.tabCapture.getMediaStreamId() in the service worker.
   *
   * SINGLE USE: one getUserMedia call consumes it. A second call with the same
   * id fails with STREAM_NOT_FOUND_IN_REGISTRY, so any retry needs a new one
   * minted by the worker.
   */
  tabStreamId: string;
  captureMicrophone: boolean;
  /**
   * Whether to ask for the tab's own audio.
   *
   * False on a retry: a machine with no audio output device fails the whole
   * request with NO_HARDWARE when audio is included, and refusing to record
   * video because the tab had no sound to capture is the wrong trade.
   */
  captureTabAudio: boolean;
  sessionId: string;
}

/**
 * The offscreen document asking for a fresh stream id, without tab audio.
 *
 * It cannot mint one itself: chrome.tabCapture is not available to an offscreen
 * document, and the id it was given has already been spent.
 */
export interface OffscreenRetryWithoutAudioMessage {
  kind: "offscreen/retry-without-audio";
  sessionId: string;
  reason: string;
}

export interface OffscreenPauseMessage {
  kind: "offscreen/pause";
}

export interface OffscreenResumeMessage {
  kind: "offscreen/resume";
}

export interface OffscreenStopMessage {
  kind: "offscreen/stop";
}

// --- Sent by the offscreen document -> service worker ------------------------

export interface OffscreenReadyMessage {
  kind: "offscreen/ready";
  info: MediaRecordInfo;
}

export interface OffscreenFinishedMessage {
  kind: "offscreen/finished";
  sessionId: string;
  info: MediaRecordInfo;
}

export interface OffscreenErrorMessage {
  kind: "offscreen/error";
  sessionId: string;
  reason: string;
}

/**
 * Asks the content script for one last snapshot before recording stops.
 *
 * WHY it is a request/REPLY and not a broadcast: the final snapshot has to be
 * stored while the session is still accepting data. A fire-and-forget message
 * would race the status change to "processing" and be dropped.
 */
export interface RequestFinalSnapshotMessage {
  kind: "sw/request-final-snapshot";
}

/** The content script's reply. `snapshot` is null when it had nothing to send. */
export interface FinalSnapshotReply {
  snapshot: DomSnapshot | null;
}

// --- Sent by the service worker -> side panel --------------------------------

export interface StatusUpdateMessage {
  kind: "sw/status";
  status: SessionStatus | "idle";
  sessionId: string;
  eventCount: number;
  recordedDurationMs: number;
  networkFailureCount: number;
  consoleErrorCount: number;
  /** Human-readable error to show in the panel, or "". */
  errorText: string;
}

export type ExtensionMessage =
  | StartRecordingMessage
  | PauseRecordingMessage
  | ResumeRecordingMessage
  | StopRecordingMessage
  | GetStatusMessage
  | AddTesterNoteMessage
  | OpenReviewPageMessage
  | RecordedEventMessage
  | DomSnapshotMessage
  | ElementContextMessage
  | PageNetworkMessage
  | PageConsoleMessage
  | ContentHandshakeMessage
  | FrameInventoryMessage
  | OffscreenStartMessage
  | OffscreenPauseMessage
  | OffscreenResumeMessage
  | OffscreenStopMessage
  | OffscreenReadyMessage
  | OffscreenFinishedMessage
  | OffscreenErrorMessage
  | OffscreenRetryWithoutAudioMessage
  | RequestFinalSnapshotMessage
  | StatusUpdateMessage;

/**
 * Narrows an unknown runtime message to our union.
 * WHY it exists: chrome.runtime.onMessage hands us `any`. Every listener calls
 * this first so the rest of the code can rely on the discriminant existing.
 */
export function asExtensionMessage(candidate: unknown): ExtensionMessage | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const maybeMessage = candidate as { kind?: unknown };
  if (typeof maybeMessage.kind !== "string") {
    return null;
  }
  return candidate as ExtensionMessage;
}

/**
 * Sends a message and swallows the "no receiving end" error.
 *
 * WHY: chrome.runtime.sendMessage rejects when nothing is listening, which
 * happens constantly and harmlessly (the side panel is closed, the offscreen
 * document has not been created yet). Letting that reject would fill the
 * console with noise and, worse, break unrelated await chains.
 */
export async function sendMessageIgnoringNoReceiver(
  message: ExtensionMessage,
): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (sendError: unknown) {
    // Deliberately ignored: no listener is a normal state, not a failure.
  }
}
