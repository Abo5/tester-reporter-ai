// =============================================================================
// src/content/snapshot-scheduler.ts
// Decides WHEN a moment is significant enough to be worth a full-page snapshot.
//
// WHY this needs its own module: without throttling, a fast typist generates
// forty snapshots of an identical page and blows both the storage and the token
// budget. Without a change fingerprint, most of those forty are byte-identical.
// =============================================================================

import type { DomSnapshot, SnapshotTrigger } from "../shared/types";
import { pruneDomForAI, DEFAULT_PRUNE_OPTIONS } from "../capture/prune-dom";
import { SNAPSHOT_THROTTLE_MS } from "../shared/constants";

import { createId } from "../shared/ids";
/** Wall-clock time the last snapshot was taken. */
let lastSnapshotAtMs: number = 0;

/** Cheap fingerprint of the page at the last snapshot. */
let lastSnapshotFingerprint: string = "";

/** Triggers that bypass the throttle entirely. */
const HIGH_PRIORITY_TRIGGERS: readonly SnapshotTrigger[] = [
  "first-load",
  "navigation",
  "url-change",
  "console-error",
  "network-failure",
  "session-stop",
];

/**
 * Builds a cheap fingerprint of the current page state.
 *
 * WHY not hash the pruned HTML: pruning is the expensive part, and the whole
 * point of the fingerprint is to decide whether to pay for it. Element count
 * plus text length plus the URL catches essentially every real change for a
 * couple of microseconds of work.
 */
function computePageFingerprint(): string {
  const body: HTMLElement | null = document.body;
  if (body === null) {
    return "no-body";
  }
  const elementCount: number = body.getElementsByTagName("*").length;
  const textLength: number = (body.textContent ?? "").length;
  return [
    window.location.href,
    String(elementCount),
    String(textLength),
    document.title,
  ].join("|");
}

/**
 * Resets the scheduler. Called when a session starts, so a snapshot taken
 * during a previous session cannot suppress the first one of a new session.
 */
export function resetSnapshotScheduler(): void {
  lastSnapshotAtMs = 0;
  lastSnapshotFingerprint = "";
}

/**
 * Decides whether to snapshot now, and if so builds it.
 * Returns the snapshot (already stamped with a fresh id) or null.
 *
 * @param trigger     Why this moment might matter.
 * @param sessionId   The active session, for the stored record.
 * @param eventIndex  The event this snapshot belongs to, or -1.
 */
export function maybeTakeSnapshot(
  trigger: SnapshotTrigger,
  sessionId: string,
  eventIndex: number,
): DomSnapshot | null {
  const nowMs: number = Date.now();
  const isHighPriority: boolean = HIGH_PRIORITY_TRIGGERS.includes(trigger);

  if (!isHighPriority) {
    if (nowMs - lastSnapshotAtMs < SNAPSHOT_THROTTLE_MS) {
      return null;
    }
    const fingerprint: string = computePageFingerprint();
    if (fingerprint === lastSnapshotFingerprint) {
      return null;   // Nothing visible changed since the last snapshot.
    }
  }

  const result = pruneDomForAI(document, DEFAULT_PRUNE_OPTIONS);
  if (result.prunedHtml === "") {
    return null;
  }

  lastSnapshotAtMs = nowMs;
  lastSnapshotFingerprint = computePageFingerprint();

  const rootElement: HTMLElement = document.documentElement;

  return {
    id: createId(),
    sessionId: sessionId,
    eventIndex: eventIndex,
    trigger: trigger,
    wallClockMs: nowMs,
    videoOffsetMs: -1,   // Stamped by the service worker, which owns the clock.
    pageUrl: window.location.href,
    pageTitle: document.title,
    documentLang: rootElement.getAttribute("lang") ?? "",
    documentDir: rootElement.getAttribute("dir") ?? "",
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    prunedHtml: result.prunedHtml,
    characterCount: result.characterCount,
    wasTruncated: result.wasTruncated,
    droppedElementCount: result.droppedElementCount,
  };
}
