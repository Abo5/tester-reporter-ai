// =============================================================================
// src/background/navigation-listener.ts
// chrome.webNavigation + chrome.tabs -> navigate / reload / tab-activated
// events, and the iframe tree used to build frameLocator() chains.
// =============================================================================

import type { RecordedEvent } from "../shared/types";
import type { FrameInventoryEntry } from "../shared/messages";
import { readActiveState, writeActiveState, videoOffsetForState }
  from "./session-state";
import type { ActiveRecordingState } from "./session-state";
import { appendEvent } from "../storage/events";
import { recordEventProgress } from "../storage/sessions";
import { withSerialisedState } from "./message-router";
import { logWarning } from "../shared/logger";
import {
  injectIntoTabForThisSession,
  isTabOriginGranted,
} from "./content-script-registration";


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
      frameSelector: selectorForFrame(frame.parentFrameId, frame.url),
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
function selectorForFrame(parentFrameId: number, frameUrl: string): string {
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

  if (matches.length >= 1) {
    return matches[0].selector;   // Ambiguity is warned about by codegen.
  }

  // No match. Derive the selector from the frame's own URL rather than from
  // its id: frameId is an opaque browser-assigned number, so
  // `iframe:nth-of-type((frameId % count) + 1)` was a guess wearing the costume
  // of a selector, and it would silently target a DIFFERENT iframe.
  return 'iframe[src*="' + shortUrlFragment(frameUrl) + '"]';
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
    keystrokes: [],
    dropTargetLocator: null,
  };

  await appendEvent(event);

  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);
  await recordEventProgress(state.sessionId, state.eventCount, url);
}


/**
 * Puts the content scripts back into a tab that has just navigated.
 *
 * WHY this is necessary, and why it was not obvious: when the tester records on
 * a site they have not granted, the scripts are injected with
 * chrome.scripting.executeScript under activeTab. That injection belongs to one
 * DOCUMENT, not to the tab. The first full page load throws it away, and from
 * that moment the session records navigations and nothing else - no clicks, no
 * typing.
 *
 * The first real session against a live site showed exactly that shape: ten
 * interactions on the login page, then seven bare navigations and not one click
 * for the rest of the journey. The generated script was a list of page.goto()
 * calls, which replays but proves nothing.
 *
 * A registered content script does not have this problem - Chrome re-injects it
 * on every load - so this only runs for origins with no grant.
 *
 * WHY onCommitted rather than onCompleted: the MAIN-world script patches fetch,
 * and a patch that arrives after the page has already made its requests records
 * nothing. Committed is the earliest point at which a document exists to inject
 * into.
 */
async function reinjectAfterNavigation(tabId: number, url: string): Promise<void> {
  const granted: boolean = await isTabOriginGranted(url);
  if (granted) {
    return;   // A registered script is already handling this origin.
  }

  const injected: boolean = await injectIntoTabForThisSession(tabId);
  if (!injected) {
    // activeTab is revoked by a cross-origin navigation, so this is a normal
    // end state for a journey that leaves the site, not a bug. The session
    // keeps recording navigations; it just stops seeing interactions.
    logWarning("navigation",
      "Could not re-inject after navigation. Grant this site to record it fully.");
  }
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
      // Serialised with the capture handlers: a navigation landing in the same
      // tick as a click would otherwise claim the same event index and one of
      // the two would be silently overwritten.
      void withSerialisedState(function runNavigation(): Promise<void> {
        return recordNavigationEvent(
          isReload ? "reload" : "navigate",
          details.url,
          "",
          details.tabId,
          details.frameId,
        );
      });

      // Outside the serialised chain on purpose: injection does not touch
      // session state, and making it queue behind the event chain would delay
      // the fetch patch past the page's first requests.
      void readActiveState().then(function afterState(
        state: ActiveRecordingState | null,
      ): void {
        if (state === null || state.status !== "recording") {
          return;
        }
        if (details.tabId !== state.tabId) {
          return;
        }
        void reinjectAfterNavigation(details.tabId, details.url);
      });
    },
  );

  chrome.tabs.onActivated.addListener(
    function onActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
      void withSerialisedState(function runTabActivated(): Promise<void> {
        return handleTabActivated(activeInfo.tabId);
      });
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
    keystrokes: [],
    dropTargetLocator: null,
  };

  await appendEvent(event);
  state.eventCount = state.eventCount + 1;
  await writeActiveState(state);
  await recordEventProgress(state.sessionId, state.eventCount, tab.url ?? "");
}
