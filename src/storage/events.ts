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
export async function readEventsForSession(
  sessionId: string,
): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] =
    await readAllForSession<RecordedEvent>(STORE_EVENTS, sessionId);
  events.sort(function compareByIndex(
    left: RecordedEvent,
    right: RecordedEvent,
  ): number {
    return left.index - right.index;
  });
  return events;
}
