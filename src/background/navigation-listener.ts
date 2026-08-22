// =============================================================================
// src/background/navigation-listener.ts
// chrome.webNavigation + chrome.tabs -> navigate / reload / tab-activated
// events, and the iframe tree used to build frameLocator() chains.
// =============================================================================

import type { RecordedEvent } from "../shared/types";
import type { FrameInventoryEntry } from "../shared/messages";
import { readActiveState, writeActiveState, videoOffsetForState }
  from "./session-state";
import { appendEvent } from "../storage/events";
import { recordEventProgress } from "../storage/sessions";
import { logWarning } from "../shared/logger";

/**
 * The iframe inventory reported by each frame's content script, keyed by the
 * frame id that reported it. Held in memory only: it is a convenience for
 * building frame paths, and losing it on a worker restart costs nothing worse
 * than a slightly less precise frame selector.
 */
const frameInventoryByFrameId: Map<number, FrameInventoryEntry[]> =
  new Map<number, FrameInventoryEntry[]>();

/** Stores what one frame reported about its own iframes. */
export function rememberFrameInventory(
  frameId: number,
  frames: FrameInventoryEntry[],
): void {
  frameInventoryByFrameId.set(frameId, frames);
}

/** Forgets every remembered inventory. Called when a session starts. */
export function clearFrameInventory(): void {
  frameInventoryByFrameId.clear();
}

/**
 * Builds the chain of frames from the top-level document down to a frame.
 *
 * Returns an empty array for the top-level frame, and for any frame whose
 * ancestry we cannot resolve — in which case codegen falls back to targeting
 * the top-level page and says so in a comment, rather than emitting a
 * frameLocator chain that is quietly wrong.
 */
export async function buildFramePath(
  tabId: number,
  frameId: number,
): Promise<{ frameId: number; frameSelector: string; frameUrl: string }[]> {
  if (frameId === 0 || frameId === -1) {
    return [];
  }
  if (chrome.webNavigation === undefined) {
    return [];
  }

  let allFrames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
  try {
    allFrames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
  } catch (queryError: unknown) {
    logWarning("navigation", "Could not read the frame tree.", queryError);
    return [];
  }
  if (allFrames === null) {
    return [];
  }

  const frameById: Map<number, chrome.webNavigation.GetAllFrameResultDetails> =
    new Map<number, chrome.webNavigation.GetAllFrameResultDetails>();
  for (let index = 0; index < allFrames.length; index = index + 1) {
    frameById.set(allFrames[index].frameId, allFrames[index]);
  }

  // Walk from the target frame up to the root, collecting the chain.
  const chainBottomUp: chrome.webNavigation.GetAllFrameResultDetails[] = [];
  let currentId: number = frameId;
  let guard: number = 0;
  while (guard < 12) {
    guard = guard + 1;
    const frame = frameById.get(currentId);
    if (frame === undefined) {
      break;
    }
    if (frame.parentFrameId === -1) {
      break;   // Reached the top-level document.
    }
    chainBottomUp.push(frame);
    currentId = frame.parentFrameId;
  }

  const framePath: { frameId: number; frameSelector: string; frameUrl: string }[] = [];
  for (let index = chainBottomUp.length - 1; index >= 0; index = index - 1) {
    const frame = chainBottomUp[index];
    framePath.push({
      frameId: frame.frameId,
      frameSelector: selectorForFrame(frame.parentFrameId, frame.url, frame.frameId),
      frameUrl: frame.url,
    });
  }
  return framePath;
}

/**
 * Finds the CSS selector the PARENT document would use for this iframe.
 *
 * Matching is by URL, which is imperfect when a page embeds the same URL twice.
 * In that case we fall back to a positional selector and the generated spec
 * carries a comment saying the position was assumed.
 */
function selectorForFrame(
  parentFrameId: number,
  frameUrl: string,
  frameId: number,
): string {
  const inventory: FrameInventoryEntry[] | undefined =
    frameInventoryByFrameId.get(parentFrameId);
  if (inventory === undefined) {
    return 'iframe[src*="' + shortUrlFragment(frameUrl) + '"]';
  }

  const matches: FrameInventoryEntry[] = [];
  for (let index = 0; index < inventory.length; index = index + 1) {
    const entry: FrameInventoryEntry = inventory[index];
    if (entry.src !== "" && frameUrl.includes(entry.src)) {
      matches.push(entry);
    } else if (entry.src !== "" && entry.src.includes(shortUrlFragment(frameUrl))) {
      matches.push(entry);
    }
  }

  if (matches.length === 1) {
    return matches[0].selector;
  }
  if (matches.length > 1) {
    return matches[0].selector;   // Ambiguous; codegen warns about it.
  }
  return "iframe:nth-of-type(" + String((frameId % inventory.length) + 1) + ")";
}

/**
 * Extracts a short, distinctive fragment of a URL for use in a src*= selector.
 */
function shortUrlFragment(url: string): string {
  try {
    const parsed: URL = new URL(url);
    const path: string = parsed.pathname;
    if (path !== "" && path !== "/") {
      return path;
    }
    return parsed.hostname;
  } catch (parseError: unknown) {
    return url.slice(0, 60);
  }
}

/**
 * Persists a navigation-shaped event.
 */
async function recordNavigationEvent(
  type: "navigate" | "reload" | "tab-activated",
  url: string,
  title: string,
  tabId: number,
  frameId: number,
): Promise<void> {
  const state = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }
  if (tabId !== state.tabId) {
    return;
  }

  const wallClockMs: number = Date.now();
  const event: RecordedEvent = {
    index: state.eventCount,
    sessionId: state.sessionId,
    type: type,
    wallClockMs: wallClockMs,
    videoOffsetMs: videoOffsetForState(state, wallClockMs),
    pageUrl: url,
    pageTitle: title,
    tabId: tabId,
    frameId: frameId,
    locator: null,
    value: "",
    valueWasRedacted: false,
    clientX: -1,
    clientY: -1,
    domSnapshotId: "",
    elementContextId: "",
  };

  await appendEvent(event);

  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);
  await recordEventProgress(state.sessionId, state.eventCount, url);
}

/**
 * Registers navigation listeners.
 *
 * WHY onCommitted and not onCompleted: committed fires when the browser has
 * decided which document it is showing, which is the moment the tester
 * perceives as "the page changed". onCompleted waits for every subresource.
 */
export function installNavigationListeners(): void {
  if (chrome.webNavigation === undefined) {
    logWarning("navigation", "chrome.webNavigation is unavailable.");
    return;
  }

  chrome.webNavigation.onCommitted.addListener(
    function onCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void {
      if (details.frameId !== 0) {
        return;   // Subframe loads are not journey steps.
      }
      const isReload: boolean = details.transitionType === "reload";
      void recordNavigationEvent(
        isReload ? "reload" : "navigate",
        details.url,
        "",
        details.tabId,
        details.frameId,
      );
    },
  );

  chrome.tabs.onActivated.addListener(
    function onActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
      void handleTabActivated(activeInfo.tabId);
    },
  );
}

/**
 * Records that the tester switched to a different tab.
 *
 * We record it even when the new tab is NOT the tab under test, because "the
 * tester went somewhere else for 40 seconds" explains a gap in the video that
 * would otherwise look like the application hanging.
 */
async function handleTabActivated(tabId: number): Promise<void> {
  const state = await readActiveState();
  if (state === null || state.status !== "recording") {
    return;
  }

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (getError: unknown) {
    return;
  }

  const wallClockMs: number = Date.now();
  const event: RecordedEvent = {
    index: state.eventCount,
    sessionId: state.sessionId,
    type: "tab-activated",
    wallClockMs: wallClockMs,
    videoOffsetMs: videoOffsetForState(state, wallClockMs),
    pageUrl: tab.url ?? "",
    pageTitle: tab.title ?? "",
    tabId: tabId,
    frameId: 0,
    locator: null,
    value: tabId === state.tabId ? "returned-to-tab-under-test" : "left-tab-under-test",
    valueWasRedacted: false,
    clientX: -1,
    clientY: -1,
    domSnapshotId: "",
    elementContextId: "",
  };

  await appendEvent(event);
  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);
  await recordEventProgress(state.sessionId, state.eventCount, tab.url ?? "");
}
