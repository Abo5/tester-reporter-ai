// =============================================================================
// src/shared/logger.ts
// Namespaced logging that can be switched off in production with one constant.
// WHY it exists: an extension logs from five different contexts at once, and
// without a namespace the console is unreadable when you are debugging.
// =============================================================================

/** Flip to false before publishing to the Chrome Web Store. */
const LOGGING_ENABLED: boolean = true;

/**
 * Writes an informational line prefixed with the calling context's name.
 */
export function logInfo(context: string, message: string, detail?: unknown): void {
  if (!LOGGING_ENABLED) {
    return;
  }
  if (detail === undefined) {
    console.log("[TRA:" + context + "] " + message);
  } else {
    console.log("[TRA:" + context + "] " + message, detail);
  }
}

/**
 * Writes a warning. Used for degraded-but-working situations, such as the
 * microphone being unavailable.
 */
export function logWarning(context: string, message: string, detail?: unknown): void {
  if (!LOGGING_ENABLED) {
    return;
  }
  if (detail === undefined) {
    console.warn("[TRA:" + context + "] " + message);
  } else {
    console.warn("[TRA:" + context + "] " + message, detail);
  }
}

/**
 * Writes an error. Used only for things that broke a user-visible promise.
 */
export function logError(context: string, message: string, detail?: unknown): void {
  if (!LOGGING_ENABLED) {
    return;
  }
  if (detail === undefined) {
    console.error("[TRA:" + context + "] " + message);
  } else {
    console.error("[TRA:" + context + "] " + message, detail);
  }
}
