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
  };

  await putRecord<RecordingSession>(STORE_SESSIONS, session);
  return session;
}

/**
 * Reads one session, or null when the id is unknown.
 */
export async function getSession(
  sessionId: string,
): Promise<RecordingSession | null> {
  return await getRecord<RecordingSession>(STORE_SESSIONS, sessionId);
}

/**
 * Reads every session, newest first.
 */
export async function listSessions(): Promise<RecordingSession[]> {
  const sessions: RecordingSession[] =
    await getAllRecords<RecordingSession>(STORE_SESSIONS);
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
