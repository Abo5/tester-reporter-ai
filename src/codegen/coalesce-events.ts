// =============================================================================
// src/codegen/coalesce-events.ts
// Removes the events that would produce noise in a generated spec, and merges
// the ones that describe a single human action.
//
// Most coalescing already happened at capture time (forty keystrokes became one
// "input" event). What is left is duplicate navigations, redundant scrolls, and
// tab switches that went nowhere.
// =============================================================================

import type { RecordedEvent } from "../shared/types";

/**
 * True when two consecutive events describe the same navigation twice.
 *
 * WHY it happens: a click that triggers a route change produces both an SPA
 * url-change from the history patch and, sometimes, a webNavigation commit.
 * Emitting two waitForURL calls for the same URL is harmless but confusing.
 */
function isDuplicateNavigation(previous: RecordedEvent, current: RecordedEvent): boolean {
  const navigationTypes: string[] = ["navigate", "url-change"];
  if (!navigationTypes.includes(previous.type)) {
    return false;
  }
  if (!navigationTypes.includes(current.type)) {
    return false;
  }
  if (previous.pageUrl !== current.pageUrl) {
    return false;
  }
  return current.wallClockMs - previous.wallClockMs < 2000;
}

/**
 * True when two events targeted what looks like the same element.
 * Compared by primary locator value, which is what codegen will emit anyway.
 */
function isSameElement(left: RecordedEvent, right: RecordedEvent): boolean {
  if (left.locator === null || right.locator === null) {
    return false;
  }
  return left.locator.primary.value === right.locator.primary.value
    && left.locator.primary.strategy === right.locator.primary.strategy;
}

/**
 * Removes events that add nothing to a replayable script.
 *
 * The rules, and why each one exists:
 *  - Duplicate navigations to the same URL within two seconds: one is enough.
 *  - A scroll immediately followed by another scroll: only the last position
 *    mattered, and Playwright scrolls automatically anyway.
 *  - Tab activations back to the tab under test: they are context for the AI,
 *    not steps to replay, and codegen renders them as a comment.
 *  - session-start and session-stop markers: the spec has its own preamble.
 */
export function coalesceEventsForCodegen(events: RecordedEvent[]): RecordedEvent[] {
  const kept: RecordedEvent[] = [];

  for (let index = 0; index < events.length; index = index + 1) {
    const current: RecordedEvent = events[index];

    if (current.type === "session-start" || current.type === "session-stop") {
      continue;
    }

    if (kept.length > 0) {
      const previous: RecordedEvent = kept[kept.length - 1];

      if (isDuplicateNavigation(previous, current)) {
        continue;
      }

      // A double-click is preceded by a single click on the same element that
      // the content script could not know was the start of a double-click.
      // Drop it here, where we can see what came next.
      if (current.type === "dblclick" && previous.type === "click"
          && isSameElement(previous, current)
          && current.wallClockMs - previous.wallClockMs < 700) {
        kept.pop();
      }

      if (previous.type === "scroll" && current.type === "scroll") {
        kept[kept.length - 1] = current;   // Keep only the final position.
        continue;
      }
    }

    kept.push(current);
  }

  return kept;
}

/**
 * Finds the event that follows the given one, or null at the end.
 * A named helper because the "is the next event a navigation?" question is
 * asked from two places in the generator.
 */
export function nextEventAfter(
  events: RecordedEvent[],
  index: number,
): RecordedEvent | null {
  if (index + 1 < events.length) {
    return events[index + 1];
  }
  return null;
}
