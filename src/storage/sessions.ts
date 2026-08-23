// =============================================================================
// src/storage/sessions.ts
// CRUD for RecordingSession. Nothing clever: read, mutate, write back.
// =============================================================================

import type {
  RecordingSession,
  ReportLanguage,
  MediaRecordInfo,
} from "../shared/types";
import {
  putRecord,
  getRecord,
  getAllRecords,
  deleteEverythingForSession,
  STORE_SESSIONS,
} from "./db";

export interface CreateSessionInput {
  id: string;
  name: string;
  originTabId: number;
  originUrl: string;
  originTitle: string;
  startedAtMs: number;
  reportLanguage: ReportLanguage;
  /** Empty unless the recording ran without a host grant. See RecordingSession. */
  interactionCaptureDegradedReason: string;
}

/**
 * Builds a MediaRecordInfo describing "nothing recorded yet".
 * WHY a function and not a shared constant: the object is mutable and a shared
 * constant would be accidentally mutated by the first session that used it.
 */
export function createEmptyMediaInfo(): MediaRecordInfo {
  return {
    mediaId: "",
    mimeType: "",
    sizeBytes: 0,
    durationMs: 0,
    videoWidth: 0,
    videoHeight: 0,
    frameRate: 0,
    hasMicrophoneAudio: false,
    hasTabAudio: false,
    state: "not-started",
    failureReason: "",
  };
}

/**
 * Creates and persists a new session row at the moment recording starts.
 */
export async function createSession(
  input: CreateSessionInput,
): Promise<RecordingSession> {
  const session: RecordingSession = {
    id: input.id,
    name: input.name,
    status: "recording",
    startedAtMs: input.startedAtMs,
    stoppedAtMs: 0,
    wallClockDurationMs: 0,
    recordedDurationMs: 0,
    originTabId: input.originTabId,
    originUrl: input.originUrl,
    originTitle: input.originTitle,
    visitedUrls: input.originUrl === "" ? [] : [input.originUrl],
    eventCount: 0,
    domSnapshotCount: 0,
    networkEntryCount: 0,
    networkFailureCount: 0,
    consoleErrorCount: 0,
    media: createEmptyMediaInfo(),
    playwrightScript: "",
    bugReport: null,
    editedReportText: "",
    reportLanguage: input.reportLanguage,
    reportFailureReason: "",
    videoUploadConsentGiven: false,
    redactionSummary: {},
    lastVideoDeliveryMode: "omitted",
    videoDowngradeReason: "",
    interactionCaptureDegradedReason: input.interactionCaptureDegradedReason,
    finalScreenshotDataUrl: "",
    testerExpectedResult: "",
  };

  await putRecord<RecordingSession>(STORE_SESSIONS, session);
  return session;
}

/**
 * Reads one session, or null when the id is unknown.
 */
/**
 * Fills in fields a session stored by an older version does not have.
 *
 * WHY this exists: a session recorded before a field was added comes back from
 * IndexedDB without it, and `undefined` is not `""`. A guard written as
 * `if (session.someField !== "")` therefore PASSES on the old row and hands
 * undefined to code that expected a string.
 *
 * That is not hypothetical. Adding finalScreenshotDataUrl broke every session
 * recorded before it with "Cannot read properties of undefined (reading
 * 'indexOf')" - the report simply would not generate, on exactly the sessions a
 * tester already cared about. readSettings() has merged against defaults since
 * the beginning for this reason; sessions never did, and every field added from
 * here would have repeated it.
 *
 * Normalising on the way OUT rather than migrating in place is deliberate:
 * there is no migration to get wrong, no version number to keep in step, and a
 * row written by a newer version and read by an older one still behaves.
 */
export function normaliseSession(stored: RecordingSession): RecordingSession {
  const session: RecordingSession = { ...stored };

  if (typeof session.finalScreenshotDataUrl !== "string") {
    session.finalScreenshotDataUrl = "";
  }
  if (typeof session.testerExpectedResult !== "string") {
    session.testerExpectedResult = "";
  }
  if (typeof session.interactionCaptureDegradedReason !== "string") {
    session.interactionCaptureDegradedReason = "";
  }
  if (typeof session.videoDowngradeReason !== "string") {
    session.videoDowngradeReason = "";
  }
  if (typeof session.playwrightScript !== "string") {
    session.playwrightScript = "";
  }
  if (typeof session.editedReportText !== "string") {
    session.editedReportText = "";
  }
  if (typeof session.reportFailureReason !== "string") {
    session.reportFailureReason = "";
  }
  if (!Array.isArray(session.visitedUrls)) {
    session.visitedUrls = [];
  }
  if (session.redactionSummary === undefined || session.redactionSummary === null) {
    session.redactionSummary = {};
  }

  return session;
}

export async function getSession(
  sessionId: string,
): Promise<RecordingSession | null> {
  const stored: RecordingSession | null =
    await getRecord<RecordingSession>(STORE_SESSIONS, sessionId);
  if (stored === null) {
    return null;
  }
  return normaliseSession(stored);
}

/**
 * Reads every session, newest first.
 */
export async function listSessions(): Promise<RecordingSession[]> {
  const stored: RecordingSession[] =
    await getAllRecords<RecordingSession>(STORE_SESSIONS);
  const sessions: RecordingSession[] = [];
  for (let index = 0; index < stored.length; index = index + 1) {
    sessions.push(normaliseSession(stored[index]));
  }
  sessions.sort(function compareByStart(
    left: RecordingSession,
    right: RecordingSession,
  ): number {
    return right.startedAtMs - left.startedAtMs;
  });
  return sessions;
}

/**
 * Applies a partial update to a stored session.
 *
 * WHY read-modify-write rather than a patch API: several contexts write to the
 * same row, and reading immediately before writing keeps the last writer from
 * silently discarding fields it did not know about.
 */
export async function updateSession(
  sessionId: string,
  changes: Partial<RecordingSession>,
): Promise<RecordingSession | null> {
  const existing: RecordingSession | null = await getSession(sessionId);
  if (existing === null) {
    return null;
  }
  const updated: RecordingSession = { ...existing, ...changes };
  await putRecord<RecordingSession>(STORE_SESSIONS, updated);
  return updated;
}


/**
 * Records one event's worth of progress in a SINGLE read-modify-write.
 *
 * WHY this exists instead of calling two separate updates
 * one after the other: both are read-modify-write cycles on the same row, so
 * two events arriving close together can interleave and the later write silently
 * discards the earlier one's visitedUrls. Combining them removes the race.
 */
export async function recordEventProgress(
  sessionId: string,
  eventCount: number,
  pageUrl: string,
): Promise<void> {
  const session: RecordingSession | null = await getSession(sessionId);
  if (session === null) {
    return;
  }

  let visitedUrls: string[] = session.visitedUrls;
  if (pageUrl !== "") {
    const lastUrl: string =
      visitedUrls.length === 0 ? "" : visitedUrls[visitedUrls.length - 1];
    if (lastUrl !== pageUrl) {
      visitedUrls = [...visitedUrls, pageUrl];
    }
  }

  await putRecord<RecordingSession>(STORE_SESSIONS, {
    ...session,
    eventCount: eventCount,
    visitedUrls: visitedUrls,
  });
}

/**
 * Deletes a session and every artifact belonging to it, including the video.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await deleteEverythingForSession(sessionId);
}

/**
 * Deletes sessions older than the retention setting.
 *
 * WHY it exists: the options page offers "delete recordings older than N days".
 * Storing that number without ever acting on it is a broken promise, and a
 * tester who believes their staging recordings are being cleaned up when they
 * are not is worse off than one who was never offered the option.
 *
 * Returns the number of sessions deleted, so the UI can say what happened.
 * A retentionDays of 0 means "never", and is the default.
 */
export async function applyRetentionPolicy(
  retentionDays: number,
  nowMs: number,
): Promise<number> {
  if (retentionDays <= 0) {
    return 0;
  }

  const cutoffMs: number = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const sessions: RecordingSession[] = await listSessions();
  let deletedCount: number = 0;

  for (let index = 0; index < sessions.length; index = index + 1) {
    const session: RecordingSession = sessions[index];

    // Never delete something still being recorded, whatever its start time.
    if (session.status === "recording" || session.status === "paused"
        || session.status === "processing") {
      continue;
    }

    if (session.startedAtMs < cutoffMs) {
      await deleteSession(session.id);
      deletedCount = deletedCount + 1;
    }
  }

  return deletedCount;
}
