// =============================================================================
// src/background/network-listener.ts
// Observational chrome.webRequest -> NetworkEntry.
//
// This is the CORROBORATING source. The MAIN-world fetch/XHR patch is the
// primary one because it can read response BODIES, which is what turns
// "POST /api/contracts -> 500" into "...{"error":"tenant_not_found"}".
// webRequest cannot read bodies, but it sees requests the page's own
// JavaScript never reports: navigations, subresources, and calls the
// application swallows internally.
// =============================================================================

import type { NetworkEntry } from "../shared/types";
import { readActiveState, videoOffsetForState } from "./session-state";
import { putNetworkEntry } from "../storage/artifacts";
import { logWarning } from "../shared/logger";

import { createId } from "../shared/ids";
/**
 * Decides whether a network entry is likely bug evidence.
 *
 * WHY it is a named exported function and not an inline condition: this rule is
 * quoted to the tester in the UI and to the model in the prompt, so it must
 * have exactly one definition.
 */
export function isLikelyBugEvidence(statusCode: number): boolean {
  if (statusCode === 0) {
    return true;    // The request never completed at all.
  }
  if (statusCode >= 400) {
    return true;    // Any 4xx or 5xx.
  }
  return false;
}

/**
 * Persists one webRequest observation, if a session is recording.
 */
async function recordWebRequestEntry(
  method: string,
  url: string,
  statusCode: number,
  statusText: string,
  timeStampMs: number,
  tabId: number,
): Promise<void> {
  const state = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  // Only the tab under test. Other tabs are none of our business.
  if (tabId !== state.tabId) {
    return;
  }
  // Never record our own calls to the AI service.
  if (url.includes("generativelanguage.googleapis.com")) {
    return;
  }

  const entry: NetworkEntry = {
    id: createId(),
    sessionId: state.sessionId,
    source: "web-request-api",
    method: method,
    url: url,
    statusCode: statusCode,
    statusText: statusText,
    startedAtMs: Math.round(timeStampMs),
    durationMs: -1,
    videoOffsetMs: videoOffsetForState(state, Math.round(timeStampMs)),
    requestBodyExcerpt: "",
    responseBodyExcerpt: "",
    requestHeaders: {},
    responseContentType: "",
    isFailure: isLikelyBugEvidence(statusCode),
    initiatorPageUrl: "",
  };

  try {
    await putNetworkEntry(entry);
  } catch (storeError: unknown) {
    logWarning("network", "Could not store a webRequest entry.", storeError);
  }
}

/**
 * Registers the observational webRequest listeners.
 *
 * CONFIRMED: details.statusCode IS populated in onCompleted under MV3 with host
 * permissions only, and no extraInfoSpec is needed - only the BLOCKING
 * webRequest variants were removed. Verified by capturing a real 500 from both
 * the fixture server and the OrangeHRM demo.
 *
 * NOTE: if the extension only holds optional host permissions that the tester
 * has not granted, these listeners simply never fire. That is a supported,
 * degraded mode, not an error.
 */
export function installNetworkListeners(): void {
  if (chrome.webRequest === undefined) {
    logWarning("network", "chrome.webRequest is unavailable; status codes will "
      + "come from the page-world patch only.");
    return;
  }

  chrome.webRequest.onCompleted.addListener(
    function onCompleted(details: chrome.webRequest.WebResponseCacheDetails): void {
      void recordWebRequestEntry(
        details.method,
        details.url,
        details.statusCode,
        details.statusLine ?? "",
        details.timeStamp,
        details.tabId,
      );
    },
    { urls: ["<all_urls>"] },
  );

  chrome.webRequest.onErrorOccurred.addListener(
    function onErrorOccurred(details: chrome.webRequest.WebResponseErrorDetails): void {
      void recordWebRequestEntry(
        details.method,
        details.url,
        0,
        details.error,
        details.timeStamp,
        details.tabId,
      );
    },
    { urls: ["<all_urls>"] },
  );
}
