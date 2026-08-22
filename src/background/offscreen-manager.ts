// =============================================================================
// src/background/offscreen-manager.ts
// Creating, checking and closing the single offscreen document.
//
// Only ONE offscreen document may exist per extension, and createDocument()
// throws if one is already open, so every call here is idempotent.
// =============================================================================

import { logInfo, logWarning } from "../shared/logger";

const OFFSCREEN_DOCUMENT_PATH: string = "offscreen/offscreen.html";

/**
 * True when our offscreen document already exists.
 *
 * CONFIRMED working on Chromium 149. Older builds exposed
 * chrome.offscreen.hasDocument() instead, so if getContexts is missing we fall
 * back to attempting creation and treating the "already exists" error as
 * success - which is why the creator below swallows that specific case.
 */
export async function isOffscreenDocumentOpen(): Promise<boolean> {
  const runtimeWithContexts = chrome.runtime as unknown as {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };

  if (typeof runtimeWithContexts.getContexts !== "function") {
    return false;
  }

  try {
    const contexts: unknown[] = await runtimeWithContexts.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  } catch (queryError: unknown) {
    logWarning("offscreen", "Could not query extension contexts.", queryError);
    return false;
  }
}

/**
 * Creates the offscreen document if it is not already open.
 *
 * CONFIRMED: USER_MEDIA (for the microphone and the tab stream) and BLOBS (for
 * holding the recording while it is written to storage) are accepted, and the
 * document is created and records successfully. If the names differ in a future
 * Chrome, fix them here: this is the only place they appear.
 */
export async function ensureOffscreenDocument(): Promise<void> {
  const alreadyOpen: boolean = await isOffscreenDocumentOpen();
  if (alreadyOpen) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [
        "USER_MEDIA" as chrome.offscreen.Reason,
        "BLOBS" as chrome.offscreen.Reason,
      ],
      justification:
        "Records tab video and microphone audio for a QA session, and holds the "
        + "resulting media Blob while it is written to extension storage.",
    });
    logInfo("offscreen", "Offscreen document created.");
  } catch (createError: unknown) {
    const message: string = String(createError);
    if (message.includes("Only a single offscreen document")
        || message.includes("already exists")) {
      // Someone else won the race. That is the outcome we wanted anyway.
      return;
    }
    throw createError;
  }
}

/**
 * Closes the offscreen document once recording is finished.
 *
 * WHY it matters: an open offscreen document keeps the browser's recording
 * indicator lit, which testers correctly find alarming, and holds the media
 * chunks in memory.
 */
export async function closeOffscreenDocument(): Promise<void> {
  const isOpen: boolean = await isOffscreenDocumentOpen();
  if (!isOpen) {
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
    logInfo("offscreen", "Offscreen document closed.");
  } catch (closeError: unknown) {
    logWarning("offscreen", "Could not close the offscreen document.", closeError);
  }
}
