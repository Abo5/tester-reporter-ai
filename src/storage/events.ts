// =============================================================================
// src/storage/events.ts
// Append and range-read for RecordedEvent.
// =============================================================================

import type { RecordedEvent } from "../shared/types";
import { putRecord, readAllForSession, STORE_EVENTS } from "./db";

/**
 * Appends one recorded event. The composite key [sessionId, index] means a
 * re-sent event with the same index overwrites rather than duplicating, which
 * makes the content script's fire-and-forget sending safe to retry.
 */
export async function appendEvent(event: RecordedEvent): Promise<void> {
  await putRecord<RecordedEvent>(STORE_EVENTS, event);
}

/**
 * Reads every event for a session, ordered by index.
 *
 * WHY we sort explicitly rather than trusting the index: getAll() on a
 * secondary index returns records in the SECONDARY key's order, and the
 * secondary key here is sessionId, which is the same for every row. The
 * resulting order is therefore unspecified, so we sort.
 */
/**
 * Fills in fields an event stored by an older version does not have.
 *
 * Same reason as normaliseSession: `keystrokes` did not exist until recently,
 * so every event recorded before it comes back without the array, and
 * describeKeystrokeCorrections(event.keystrokes) then throws rather than
 * generating a script - on exactly the sessions a tester already has.
 */
export function normaliseEvent(stored: RecordedEvent): RecordedEvent {
  const event: RecordedEvent = { ...stored };

  if (!Array.isArray(event.keystrokes)) {
    event.keystrokes = [];
  }
  if (event.dropTargetLocator === undefined) {
    event.dropTargetLocator = null;
  }
  if (typeof event.value !== "string") {
    event.value = "";
  }
  if (typeof event.pageUrl !== "string") {
    event.pageUrl = "";
  }

  return event;
}

export async function readEventsForSession(
  sessionId: string,
): Promise<RecordedEvent[]> {
  const stored: RecordedEvent[] =
    await readAllForSession<RecordedEvent>(STORE_EVENTS, sessionId);
  const events: RecordedEvent[] = [];
  for (let index = 0; index < stored.length; index = index + 1) {
    events.push(normaliseEvent(stored[index]));
  }
  events.sort(function compareByIndex(
    left: RecordedEvent,
    right: RecordedEvent,
  ): number {
    return left.index - right.index;
  });
  return events;
}
