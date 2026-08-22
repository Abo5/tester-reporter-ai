// =============================================================================
// src/storage/media.ts
// Blob put/get/delete plus the quota guard.
//
// WHY IndexedDB and not chrome.storage.local: chrome.storage stores JSON and is
// capped at roughly 10 MB by default; IndexedDB stores Blob objects natively
// and, with the "unlimitedStorage" permission, is bounded only by disk quota.
// =============================================================================

import {
  putRecord,
  getRecord,
  deleteRecord,
  readAllForSession,
  STORE_MEDIA,
} from "./db";
import { MINIMUM_FREE_BYTES_TO_START } from "../shared/constants";

import { createId } from "../shared/ids";
export interface StoredMedia {
  mediaId: string;
  sessionId: string;
  blob: Blob;
  createdAtMs: number;
  /** Duration we measured ourselves, because WebM headers often lack it. */
  durationMs: number;
  mimeType: string;
}

export interface QuotaStatus {
  usageBytes: number;
  quotaBytes: number;
  freeBytes: number;
  canStartRecording: boolean;
}

/**
 * Writes the finished recording and returns its key.
 */
export async function storeMediaBlob(
  sessionId: string,
  blob: Blob,
  durationMs: number,
  mimeType: string,
): Promise<string> {
  const mediaId: string = createId();
  const record: StoredMedia = {
    mediaId: mediaId,
    sessionId: sessionId,
    blob: blob,
    createdAtMs: Date.now(),
    durationMs: durationMs,
    mimeType: mimeType,
  };
  await putRecord<StoredMedia>(STORE_MEDIA, record);
  return mediaId;
}

/**
 * Reads one stored recording, or null when it is missing or was deleted.
 */
export async function getMediaBlob(mediaId: string): Promise<StoredMedia | null> {
  if (mediaId === "") {
    return null;
  }
  return await getRecord<StoredMedia>(STORE_MEDIA, mediaId);
}

/**
 * Deletes only the video for a session, keeping the report and the script.
 * WHY this exists separately from deleteSession: the video is 98% of the disk
 * cost and the least useful part a week later.
 */
export async function deleteMediaForSession(sessionId: string): Promise<number> {
  const records: StoredMedia[] =
    await readAllForSession<StoredMedia>(STORE_MEDIA, sessionId);
  let freedBytes: number = 0;
  for (let index = 0; index < records.length; index = index + 1) {
    freedBytes = freedBytes + records[index].blob.size;
    await deleteRecord(STORE_MEDIA, records[index].mediaId);
  }
  return freedBytes;
}

/**
 * Reads the current storage situation before a recording starts.
 *
 * WHY we check BEFORE rather than handling the failure after: a
 * QuotaExceededError six minutes into a session destroys the tester's work.
 * Refusing to start costs them five seconds.
 *
 * navigator.storage.estimate() is available in an extension context and returns
 * usable numbers - CONFIRMED in the options page and the pre-record guard. Its
 * values are deliberately imprecise by design, which is why they are only used
 * for a coarse go / no-go decision and never shown as an exact figure.
 */
export async function readQuotaStatus(): Promise<QuotaStatus> {
  if (navigator.storage === undefined
      || typeof navigator.storage.estimate !== "function") {
    // If we cannot measure, we do not block the tester.
    return {
      usageBytes: 0,
      quotaBytes: 0,
      freeBytes: Number.MAX_SAFE_INTEGER,
      canStartRecording: true,
    };
  }

  const estimate: StorageEstimate = await navigator.storage.estimate();
  const usageBytes: number = estimate.usage ?? 0;
  const quotaBytes: number = estimate.quota ?? 0;
  const freeBytes: number = quotaBytes - usageBytes;

  return {
    usageBytes: usageBytes,
    quotaBytes: quotaBytes,
    freeBytes: freeBytes,
    canStartRecording: quotaBytes === 0 || freeBytes > MINIMUM_FREE_BYTES_TO_START,
  };
}
