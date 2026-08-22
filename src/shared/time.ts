// =============================================================================
// src/shared/time.ts
// The two clocks. Wall clock is real time; media clock is the position inside
// the recorded file, which is SHORTER because pauses are not recorded.
// Getting this wrong makes every video timestamp after the first pause point
// at the wrong frame, so it lives in one tested place.
// =============================================================================

/**
 * Formats a media-clock offset as MM:SS.
 * WHY the model and the UI both get MM:SS and not milliseconds: it is a
 * position in a video that a human or a model can act on. 42137 is not.
 */
export function formatVideoTimestamp(offsetMs: number): string {
  if (offsetMs < 0 || !Number.isFinite(offsetMs)) {
    return "--:--";
  }
  const totalSeconds: number = Math.floor(offsetMs / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  const paddedMinutes: string = String(minutes).padStart(2, "0");
  const paddedSeconds: string = String(seconds).padStart(2, "0");
  return paddedMinutes + ":" + paddedSeconds;
}

/**
 * Formats a duration in milliseconds as a human sentence, e.g. "3 min 12 s".
 * Used in the review page and the session list.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs <= 0 || !Number.isFinite(durationMs)) {
    return "0 s";
  }
  const totalSeconds: number = Math.round(durationMs / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (minutes === 0) {
    return String(seconds) + " s";
  }
  return String(minutes) + " min " + String(seconds) + " s";
}

/**
 * Formats a byte count for humans.
 */
export function formatBytes(byteCount: number): string {
  if (byteCount <= 0 || !Number.isFinite(byteCount)) {
    return "0 B";
  }
  if (byteCount < 1024) {
    return String(byteCount) + " B";
  }
  if (byteCount < 1024 * 1024) {
    return (byteCount / 1024).toFixed(1) + " KB";
  }
  if (byteCount < 1024 * 1024 * 1024) {
    return (byteCount / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (byteCount / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * Converts a wall-clock timestamp into a position inside the RECORDED media.
 *
 * WHY this exists: MediaRecorder.pause() does not record the paused interval,
 * so the video is shorter than real elapsed time. Without this correction,
 * every video timestamp we hand to the AI after the first pause is wrong.
 *
 * @param startedAtMs         Date.now() when recording began.
 * @param accumulatedPausedMs Total real time already spent paused, in ms.
 * @param pauseStartedAtMs    Date.now() when the CURRENT pause began, or 0.
 * @param wallClockMs         The timestamp to convert.
 */
export function wallClockToVideoOffsetMs(
  startedAtMs: number,
  accumulatedPausedMs: number,
  pauseStartedAtMs: number,
  wallClockMs: number,
): number {
  let pausedSoFarMs: number = accumulatedPausedMs;
  if (pauseStartedAtMs > 0) {
    pausedSoFarMs = pausedSoFarMs + (wallClockMs - pauseStartedAtMs);
  }
  const offsetMs: number = wallClockMs - startedAtMs - pausedSoFarMs;
  if (offsetMs < 0) {
    return 0;
  }
  return offsetMs;
}

/**
 * Returns the current month as "YYYY-MM", used to reset the request counter.
 */
export function currentMonthKey(): string {
  const now: Date = new Date();
  const year: string = String(now.getFullYear());
  const month: string = String(now.getMonth() + 1).padStart(2, "0");
  return year + "-" + month;
}
