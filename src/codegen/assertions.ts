// =============================================================================
// src/codegen/assertions.ts
// Waits and assertions DERIVED from what was observed. Never invented.
//
// THE RULE: we never emit page.waitForTimeout(). Playwright's locators auto-wait
// for actionability, which covers almost everything an arbitrary sleep was
// hiding. Where a real wait is needed we emit waitForURL, because we actually
// recorded that the URL changed.
// =============================================================================

import type { RecordedEvent, NetworkEntry } from "../shared/types";
import { locatorToPlaywrightExpression, quote } from "./locator-to-playwright";
import { FAILURE_ATTRIBUTION_WINDOW_MS } from "../shared/constants";

/**
 * Finds any request that failed shortly after a given event.
 *
 * WHY: a click that triggers a 500 is the single most useful thing to point at
 * in a generated spec, and the tester should not have to correlate it by hand.
 */
export function findFailureAfterEvent(
  event: RecordedEvent,
  networkEntries: NetworkEntry[],
): NetworkEntry | null {
  const windowEndMs: number = event.wallClockMs + FAILURE_ATTRIBUTION_WINDOW_MS;
  for (let index = 0; index < networkEntries.length; index = index + 1) {
    const entry: NetworkEntry = networkEntries[index];
    if (!entry.isFailure) {
      continue;
    }
    if (entry.startedAtMs >= event.wallClockMs && entry.startedAtMs <= windowEndMs) {
      return entry;
    }
  }
  return null;
}

/**
 * Builds the "a request failed here" comment for one event, or "" if none did.
 */
export function buildFailureComment(
  event: RecordedEvent,
  networkEntries: NetworkEntry[],
): string {
  const failure: NetworkEntry | null = findFailureAfterEvent(event, networkEntries);
  if (failure === null) {
    return "";
  }
  const statusText: string =
    failure.statusCode === 0 ? "no response" : String(failure.statusCode);
  return "// A request failed here during recording: "
    + failure.method + " " + failure.url + " -> " + statusText;
}

/**
 * Builds the closing assertion block, derived only from what was observed.
 *
 * WHY it is derived and never invented: an assertion the tester did not
 * demonstrate is a guess, and a guessed assertion in a QA artifact is worse
 * than no assertion at all.
 */
export function buildClosingAssertions(
  events: RecordedEvent[],
  indent: string,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(indent + "// --- Assertions derived from the final recorded state ---");
  lines.push(indent + "// These are what the recording PROVES was true at the end.");
  lines.push(indent + "// Add the assertions your test actually needs.");

  let lastInteraction: RecordedEvent | null = null;
  let finalUrl: string = "";

  for (let index = 0; index < events.length; index = index + 1) {
    const event: RecordedEvent = events[index];
    if (event.pageUrl !== "") {
      finalUrl = event.pageUrl;
    }
    if (event.locator !== null) {
      lastInteraction = event;
    }
  }

  if (finalUrl !== "") {
    lines.push(indent + "await expect(page).toHaveURL(" + quote(finalUrl) + ");");
  }

  if (lastInteraction !== null && lastInteraction.locator !== null
      && lastInteraction.locator.framePath.length === 0) {
    const expression: string = locatorToPlaywrightExpression(lastInteraction.locator);
    lines.push(indent + "await expect(" + expression + ").toBeVisible();");
  }

  if (lines.length === 4) {
    lines.push(indent + "// Nothing in the recording established a final state to "
      + "assert on.");
  }

  return lines;
}
