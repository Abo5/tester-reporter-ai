// =============================================================================
// src/storage/artifacts.ts
// DomSnapshot / ElementContext / NetworkEntry / ConsoleEntry stores.
// =============================================================================

import type {
  DomSnapshot,
  ElementContext,
  NetworkEntry,
  ConsoleEntry,
} from "../shared/types";
import {
  putRecord,
  readAllForSession,
  STORE_DOM_SNAPSHOTS,
  STORE_ELEMENT_CONTEXTS,
  STORE_NETWORK,
  STORE_CONSOLE,
} from "./db";

/** Stores one pruned full-page snapshot. */
export async function putDomSnapshot(snapshot: DomSnapshot): Promise<void> {
  await putRecord<DomSnapshot>(STORE_DOM_SNAPSHOTS, snapshot);
}

/** Reads every snapshot for a session, oldest first. */
export async function readDomSnapshots(sessionId: string): Promise<DomSnapshot[]> {
  const snapshots: DomSnapshot[] =
    await readAllForSession<DomSnapshot>(STORE_DOM_SNAPSHOTS, sessionId);
  snapshots.sort(function compareByTime(left: DomSnapshot, right: DomSnapshot): number {
    return left.wallClockMs - right.wallClockMs;
  });
  return snapshots;
}

/** Stores the bounded context captured around one interacted element. */
export async function putElementContext(context: ElementContext): Promise<void> {
  await putRecord<ElementContext>(STORE_ELEMENT_CONTEXTS, context);
}

/** Reads every element context for a session, ordered by event index. */
export async function readElementContexts(
  sessionId: string,
): Promise<ElementContext[]> {
  const contexts: ElementContext[] =
    await readAllForSession<ElementContext>(STORE_ELEMENT_CONTEXTS, sessionId);
  contexts.sort(function compareByEvent(
    left: ElementContext,
    right: ElementContext,
  ): number {
    return left.eventIndex - right.eventIndex;
  });
  return contexts;
}

/** Stores one network entry from either capture mechanism. */
export async function putNetworkEntry(entry: NetworkEntry): Promise<void> {
  await putRecord<NetworkEntry>(STORE_NETWORK, entry);
}

/** Reads every network entry for a session, oldest first. */
export async function readNetworkEntries(sessionId: string): Promise<NetworkEntry[]> {
  const entries: NetworkEntry[] =
    await readAllForSession<NetworkEntry>(STORE_NETWORK, sessionId);
  entries.sort(function compareByStart(left: NetworkEntry, right: NetworkEntry): number {
    return left.startedAtMs - right.startedAtMs;
  });
  return entries;
}

/** Stores one console entry. */
export async function putConsoleEntry(entry: ConsoleEntry): Promise<void> {
  await putRecord<ConsoleEntry>(STORE_CONSOLE, entry);
}

/** Reads every console entry for a session, oldest first. */
export async function readConsoleEntries(sessionId: string): Promise<ConsoleEntry[]> {
  const entries: ConsoleEntry[] =
    await readAllForSession<ConsoleEntry>(STORE_CONSOLE, sessionId);
  entries.sort(function compareByTime(left: ConsoleEntry, right: ConsoleEntry): number {
    return left.wallClockMs - right.wallClockMs;
  });
  return entries;
}
