// =============================================================================
// src/background/content-script-registration.ts
//
// Registers the two content scripts at RUN TIME, for the origins the tester has
// actually granted.
//
// WHY this file exists at all, rather than two entries in manifest.json:
//
// Section 13.3 of the plan required <all_urls> to appear only in
// optional_host_permissions, so that the install prompt is narrow and the
// tester grants their staging origin deliberately. It also carried a VERIFY:
// does a static content_scripts entry with <all_urls> matches force the broad
// grant anyway, even when the host permission is optional?
//
// It does. Measured, not assumed: with the static entries present,
// chrome.permissions.getAll() reports http://*/* and https://*/* as already
// granted on a fresh profile. With the same manifest and the static entries
// deleted, the same call reports only the API origin, and
// permissions.contains({origins:["https://example.com/*"]}) answers false.
// The static entry was the variable.
//
// So the static entries are gone, and registration happens here instead -
// which is the fix the plan named for exactly this outcome.
// =============================================================================

import { logError, logInfo } from "../shared/logger";

/** The id used to register and unregister our scripts as a set. */
const MAIN_WORLD_SCRIPT_ID: string = "tra-page-world";
const ISOLATED_WORLD_SCRIPT_ID: string = "tra-recorder";

/**
 * The origin patterns the tester may grant. Kept in one place because the
 * options page offers them and the registration consumes them, and a mismatch
 * between the two would register scripts for origins nobody can grant.
 */
export const GRANTABLE_ORIGIN_PATTERNS: string[] = ["http://*/*", "https://*/*"];

/**
 * Every http/https origin pattern currently granted to the extension.
 *
 * WHAT: reads the live permission set and keeps only the patterns a content
 * script can match. WHY the filter: getAll() also returns the Gemini API
 * origin, and registering a content script on the API host would be pointless
 * and slightly alarming.
 */
export async function readGrantedPagePatterns(): Promise<string[]> {
  const permissions: chrome.permissions.Permissions =
    await chrome.permissions.getAll();
  const origins: string[] = permissions.origins ?? [];
  const pagePatterns: string[] = [];

  for (const origin of origins) {
    if (origin.startsWith("http://") || origin.startsWith("https://")) {
      if (origin.indexOf("generativelanguage.googleapis.com") === -1) {
        pagePatterns.push(origin);
      }
    }
  }

  return pagePatterns;
}

/**
 * Makes the registered content scripts match the granted origins exactly.
 *
 * WHAT: unregisters ours, then registers them again for whatever is granted
 * now. WHY unregister first rather than update: updateContentScripts throws if
 * the script id is not already registered, and this function has to work both
 * on a fresh install (nothing registered) and after a grant (something is).
 * Unregister-then-register is the one sequence that is correct in both, and
 * this runs a handful of times per browser session, not per page.
 *
 * Called on install, on browser start, and whenever a permission is added or
 * removed. Safe to call repeatedly.
 */
export async function syncRegisteredContentScripts(): Promise<void> {
  const patterns: string[] = await readGrantedPagePatterns();

  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [MAIN_WORLD_SCRIPT_ID, ISOLATED_WORLD_SCRIPT_ID],
    });
  } catch (unregisterError: unknown) {
    // Nothing was registered. Normal on a fresh install.
  }

  if (patterns.length === 0) {
    logInfo("worker", "No page origins granted; no content scripts registered.");
    return;
  }

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: MAIN_WORLD_SCRIPT_ID,
        js: ["content/page-world.js"],
        matches: patterns,
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        persistAcrossSessions: true,
      },
      {
        id: ISOLATED_WORLD_SCRIPT_ID,
        js: ["content/recorder.js"],
        matches: patterns,
        runAt: "document_idle",
        world: "ISOLATED",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
    logInfo("worker", "Content scripts registered for " + patterns.join(", "));
  } catch (registerError: unknown) {
    logError("worker", "Could not register content scripts.", registerError);
  }
}

/**
 * Injects the two content scripts into ONE tab, right now.
 *
 * WHAT: the fallback for recording on a site the tester has not granted.
 * activeTab gives us scripting access to the tab the tester explicitly invoked
 * the extension on, and nothing else, which is the narrowest thing that still
 * lets them record.
 *
 * WHY it is a genuine downgrade, stated plainly: the MAIN-world script patches
 * fetch and XMLHttpRequest, and a registered script does that at
 * document_start, before the page has issued a single request. Injecting on
 * invocation runs it whenever Record was pressed, so any request the page made
 * before that moment is invisible. Everything else - clicks, inputs, the DOM
 * snapshot, the video - is unaffected. Grant the origin to get the network
 * capture back.
 *
 * Returns true if both worlds were injected.
 */
export async function injectIntoTabForThisSession(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ["content/page-world.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ["content/recorder.js"],
      world: "ISOLATED",
    });
    logInfo("worker", "Injected content scripts into tab " + String(tabId));
    return true;
  } catch (injectError: unknown) {
    logError("worker", "Could not inject into tab " + String(tabId), injectError);
    return false;
  }
}

/**
 * True when this tab's origin is already covered by a granted pattern.
 *
 * WHAT: decides whether the injection fallback is needed. WHY it compares by
 * scheme and host rather than calling permissions.contains with the tab URL:
 * contains() wants an origin pattern, and a tab URL carries a path and a query
 * string that would never match one.
 */
export async function isTabOriginGranted(tabUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch (parseError: unknown) {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const originPattern: string = parsed.protocol + "//" + parsed.hostname + "/*";
  return await chrome.permissions.contains({ origins: [originPattern] });
}
