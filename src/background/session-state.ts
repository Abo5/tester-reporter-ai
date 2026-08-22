// =============================================================================
// src/background/session-state.ts
// The recording state machine.
//
// It lives in chrome.storage.session — NOT in a module variable — because an
// MV3 service worker is terminated when idle and restarted on the next event.
// Assume the worker can die between any two messages; that assumption is always
// safe, whatever the current idle rules happen to be.
// =============================================================================

import type { SessionStatus } from "../shared/types";
import { wallClockToVideoOffsetMs } from "../shared/time";

const SESSION_STATE_KEY: string = "activeRecordingState";

export interface ActiveRecordingState {
  sessionId: string;
  status: SessionStatus;
  tabId: number;
  startedAtMs: number;
  /** Total real time already spent paused, in milliseconds. */
  accumulatedPausedMs: number;
  /** Date.now() when the CURRENT pause began; 0 when not paused. */
  pauseStartedAtMs: number;
  eventCount: number;
  /** Whether the microphone was requested for this session. */
  captureMicrophone: boolean;
  /**
   * A warning to keep showing in the side panel, or "".
   *
   * It lives HERE rather than in a module variable because the service worker
   * is terminated when idle: the variable reset to "" while the recording
   * carried on, and the next broadcast actively erased a warning that was still
   * true - typically the "recording without video" notice, at the exact moment
   * the tester had stopped interacting long enough to read it.
   */
  errorText: string;
}

/**
 * Reads the current recording state, or null when nothing is being recorded.
 *
 * WHY every listener must start by calling this: the worker may have been
 * restarted since the previous message, so no in-memory variable can be
 * trusted.
 */
export async function readActiveState(): Promise<ActiveRecordingState | null> {
  const stored: Record<string, unknown> =
    await chrome.storage.session.get(SESSION_STATE_KEY);
  const value: unknown = stored[SESSION_STATE_KEY];
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as ActiveRecordingState;
}

/**
 * Writes the recording state. Small object, safe to write often.
 */
export async function writeActiveState(state: ActiveRecordingState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
}

/**
 * Clears the recording state after a session stops.
 */
export async function clearActiveState(): Promise<void> {
  await chrome.storage.session.remove(SESSION_STATE_KEY);
}

/**
 * Converts a wall-clock timestamp into a position inside the recorded media,
 * using the current state's pause accounting.
 */
export function videoOffsetForState(
  state: ActiveRecordingState,
  wallClockMs: number,
): number {
  return wallClockToVideoOffsetMs(
    state.startedAtMs,
    state.accumulatedPausedMs,
    state.pauseStartedAtMs,
    wallClockMs,
  );
}

/**
 * Returns the total recorded (pause-excluding) duration so far.
 */
export function recordedDurationForState(state: ActiveRecordingState): number {
  return videoOffsetForState(state, Date.now());
}

