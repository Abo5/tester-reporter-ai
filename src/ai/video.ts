// =============================================================================
// src/ai/video.ts
// Decides HOW the video reaches the model, and produces the fallback when it
// cannot go as video at all.
//
// SIZE IS CONTROLLED AT RECORD TIME (720p, 10 fps, 1 Mbps in the offscreen
// recorder), not by re-encoding here. Re-encoding in the browser would need an
// ffmpeg-in-WebAssembly build: several megabytes of extension payload, slow on
// the mid-range laptops testers actually use, and a large new dependency to
// justify at review time — all to serve an edge case the record-time settings
// already prevent.
//
// The fallback is key frames, which needs no dependency at all: a <video>
// element plus a <canvas>. It loses motion and audio, which is a real loss, but
// it preserves layout, colour and rendered text at the moments that matter, and
// it always works.
//
// This module must run in a DOM context (the review page), never in the service
// worker, because it needs <video> and <canvas>.
// =============================================================================

import type {
  BundledVideo,
  MediaRecordInfo,
  RecordedEvent,
} from "../shared/types";
import {
  VIDEO_HARD_SIZE_CEILING_BYTES,
  VIDEO_HARD_DURATION_CEILING_MS,
  VIDEO_INLINE_THRESHOLD_BYTES,
  KEY_FRAME_COUNT,
  KEY_FRAME_JPEG_QUALITY,
  KEY_FRAME_MAX_WIDTH,
  ASSUMED_SUPPORTED_VIDEO_MIME_TYPES,
} from "../shared/constants";
import { logWarning } from "../shared/logger";
import { formatBytes } from "../shared/time";

/**
 * True when the recorded MIME type looks acceptable to the model.
 * We compare only the part before ";codecs=", because the recorded type is
 * always the long form.
 *
 * VERIFY the assumed list in shared/constants.ts against current Gemini video
 * documentation. If video/webm is not accepted and the browser cannot record
 * MP4, every session silently takes the key-frame path — which works, but you
 * would want to know that is what is happening.
 */
export function isVideoMimeTypeSupported(recordedMimeType: string): boolean {
  const baseMimeType: string =
    recordedMimeType.split(";")[0].trim().toLowerCase();
  for (let index = 0; index < ASSUMED_SUPPORTED_VIDEO_MIME_TYPES.length;
       index = index + 1) {
    if (ASSUMED_SUPPORTED_VIDEO_MIME_TYPES[index] === baseMimeType) {
      return true;
    }
  }
  return false;
}

/**
 * Converts a Blob to a base64 string with no data: prefix.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>(function executor(resolve, reject): void {
    const reader: FileReader = new FileReader();
    reader.onloadend = function onLoadEnd(): void {
      const dataUrl: string = String(reader.result);
      const commaIndex: number = dataUrl.indexOf(",");
      if (commaIndex === -1) {
        reject(new Error("Unexpected FileReader output while encoding the video."));
        return;
      }
      resolve(dataUrl.slice(commaIndex + 1));
    };
    reader.onerror = function onError(): void {
      reject(reader.error ?? new Error("Could not read the recording."));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Chooses which moments to grab key frames from.
 *
 * Slots are reserved BY PRIORITY, then sorted for output. An earlier version
 * collected every candidate, sorted them, and filled the cap from the start of
 * that sorted list - so the six EARLIEST offsets won. A five-minute session
 * with failures at 00:30 and 04:00 sent four frames of the first 32 seconds,
 * dropped the second failure entirely, and dropped the final-state frame, which
 * the docs promise is always included.
 *
 * The order is: first frame, last frame, then failures working backwards from
 * the most recent - because the last thing that broke is usually the thing the
 * tester stopped to report.
 */
export function chooseKeyFrameOffsets(
  durationMs: number,
  events: RecordedEvent[],
  failureEventIndexes: number[],
): number[] {
  const safeDurationMs: number = durationMs > 0 ? durationMs : 1000;
  const chosen: number[] = [];

  /** Adds an offset unless it duplicates one already chosen, or the cap is hit. */
  function reserve(rawOffset: number): void {
    if (chosen.length >= KEY_FRAME_COUNT) {
      return;
    }
    const offset: number = Math.max(0, Math.min(safeDurationMs, Math.round(rawOffset)));
    for (let index = 0; index < chosen.length; index = index + 1) {
      if (Math.abs(chosen[index] - offset) < 500) {
        return;
      }
    }
    chosen.push(offset);
  }

  // 1. The documented guarantees: where the session started and where it ended.
  reserve(0);
  reserve(safeDurationMs - 200);

  // 2. Failures, most recent first.
  for (let index = failureEventIndexes.length - 1; index >= 0; index = index - 1) {
    const eventIndex: number = failureEventIndexes[index];
    if (eventIndex < 0 || eventIndex >= events.length) {
      continue;
    }
    const failureOffsetMs: number = events[eventIndex].videoOffsetMs;
    if (failureOffsetMs < 0) {
      continue;
    }
    reserve(failureOffsetMs);
    reserve(failureOffsetMs - 1500);
    reserve(failureOffsetMs + 2000);
  }

  // 3. Anything left over goes to an even spread.
  let spreadIndex: number = 1;
  while (chosen.length < KEY_FRAME_COUNT && spreadIndex < KEY_FRAME_COUNT) {
    reserve((safeDurationMs * spreadIndex) / KEY_FRAME_COUNT);
    spreadIndex = spreadIndex + 1;
  }

  // Chronological for output: the model reads them as a sequence.
  chosen.sort(function compareNumbers(left: number, right: number): number {
    return left - right;
  });
  return chosen;
}

/**
 * Extracts still frames from a video Blob using only built-in browser APIs.
 *
 * WHY no library: a <video> element plus a <canvas> does this natively, and
 * adding an encoder dependency for a fallback path is not justified.
 */
export interface ExtractedKeyFrames {
  /** base64 JPEG payloads, without the data: prefix. */
  frames: string[];
  /** The offset each frame was ACTUALLY taken at, aligned with `frames`. */
  offsetsMs: number[];
}

export async function extractKeyFrames(
  videoBlob: Blob,
  offsetsMs: number[],
): Promise<ExtractedKeyFrames> {
  const objectUrl: string = URL.createObjectURL(videoBlob);
  const videoElement: HTMLVideoElement = document.createElement("video");
  videoElement.src = objectUrl;
  videoElement.muted = true;
  videoElement.preload = "auto";

  const frames: string[] = [];
  // Kept in step with `frames`. An earlier version returned only the frames and
  // let the caller do offsets.slice(0, frames.length), which assumes every
  // failed seek was at the END. A failure in the middle shifted every later
  // frame's label by one, so the model was told the wrong moment for each.
  const achievedOffsetsMs: number[] = [];

  try {
    await new Promise<void>(function executor(resolve, reject): void {
      const timeoutId: number = window.setTimeout(function onTimeout(): void {
        reject(new Error("Reading the recording timed out."));
      }, 20000);

      videoElement.onloadedmetadata = function onLoaded(): void {
        window.clearTimeout(timeoutId);
        resolve();
      };
      videoElement.onerror = function onError(): void {
        window.clearTimeout(timeoutId);
        reject(new Error("Could not read the recorded video for key frames."));
      };
    });

    const canvas: HTMLCanvasElement = document.createElement("canvas");
    const sourceWidth: number =
      videoElement.videoWidth > 0 ? videoElement.videoWidth : KEY_FRAME_MAX_WIDTH;
    const sourceHeight: number =
      videoElement.videoHeight > 0 ? videoElement.videoHeight : 720;
    const scale: number = Math.min(1, KEY_FRAME_MAX_WIDTH / sourceWidth);

    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const context: CanvasRenderingContext2D | null = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context unavailable for key-frame extraction.");
    }

    for (let index = 0; index < offsetsMs.length; index = index + 1) {
      const seekTargetSeconds: number = offsetsMs[index] / 1000;

      const seeked: boolean = await seekVideoTo(videoElement, seekTargetSeconds);
      if (!seeked) {
        continue;   // One unreachable frame is not worth failing the whole path.
      }

      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const dataUrl: string = canvas.toDataURL("image/jpeg", KEY_FRAME_JPEG_QUALITY);
      const commaIndex: number = dataUrl.indexOf(",");
      if (commaIndex !== -1) {
        frames.push(dataUrl.slice(commaIndex + 1));
        achievedOffsetsMs.push(offsetsMs[index]);
      }
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  if (frames.length === 0) {
    throw new Error("No frames could be extracted from the recording.");
  }
  return { frames: frames, offsetsMs: achievedOffsetsMs };
}

/**
 * Seeks a video element and waits for the frame to be ready.
 * Returns false when the seek did not complete in time.
 */
function seekVideoTo(
  videoElement: HTMLVideoElement,
  targetSeconds: number,
): Promise<boolean> {
  return new Promise<boolean>(function executor(resolve): void {
    const timeoutId: number = window.setTimeout(function onTimeout(): void {
      videoElement.onseeked = null;
      resolve(false);
    }, 5000);

    videoElement.onseeked = function onSeeked(): void {
      window.clearTimeout(timeoutId);
      videoElement.onseeked = null;
      resolve(true);
    };

    try {
      videoElement.currentTime = targetSeconds;
    } catch (seekError: unknown) {
      window.clearTimeout(timeoutId);
      resolve(false);
    }
  });
}

/**
 * Builds the "no video at all" result.
 */
function buildOmittedVideo(
  durationMs: number,
  downgradeReason: string,
): BundledVideo {
  return {
    deliveryMode: "omitted",
    fileUri: "",
    base64Data: "",
    keyFrameBase64: [],
    keyFrameOffsetsMs: [],
    mimeType: "",
    durationMs: durationMs,
    sizeBytes: 0,
    downgradeReason: downgradeReason,
  };
}

/**
 * Decides how the video will reach the model and prepares it accordingly.
 *
 * It NEVER throws. Losing the video must never stop the report from being
 * produced: a report derived from the page code and the script alone is still a
 * good report, it just cannot speak to timing or animation.
 *
 * @param allowUpload false when the tester declined consent or the global
 *                    "never upload video" switch is on.
 */
export async function prepareVideoForAI(
  videoBlob: Blob | null,
  mediaInfo: MediaRecordInfo,
  events: RecordedEvent[],
  failureEventIndexes: number[],
  allowUpload: boolean,
): Promise<BundledVideo> {
  if (!allowUpload) {
    return buildOmittedVideo(
      mediaInfo.durationMs,
      "The video was not sent because uploading it was not permitted for this "
      + "session. The report was written from the page code and the action "
      + "script only.");
  }

  if (videoBlob === null || videoBlob.size === 0) {
    return buildOmittedVideo(
      mediaInfo.durationMs,
      "No video was recorded for this session, so the report was written from "
      + "the page code and the action script only.");
  }

  const tooLarge: boolean = videoBlob.size > VIDEO_HARD_SIZE_CEILING_BYTES;
  const tooLong: boolean = mediaInfo.durationMs > VIDEO_HARD_DURATION_CEILING_MS;
  const unsupportedFormat: boolean = !isVideoMimeTypeSupported(mediaInfo.mimeType);

  if (tooLarge || tooLong || unsupportedFormat) {
    let reason: string = "";
    if (tooLarge) {
      reason = "The recording was " + formatBytes(videoBlob.size)
        + ", above the size ceiling for video analysis.";
    } else if (tooLong) {
      reason = "The recording was longer than the supported duration for video "
        + "analysis.";
    } else {
      reason = "The recording format (" + mediaInfo.mimeType + ") is not "
        + "accepted for video analysis.";
    }

    try {
      const offsets: number[] =
        chooseKeyFrameOffsets(mediaInfo.durationMs, events, failureEventIndexes);
      const extracted = await extractKeyFrames(videoBlob, offsets);
      const frames: string[] = extracted.frames;
      return {
        deliveryMode: "key-frames",
        fileUri: "",
        base64Data: "",
        keyFrameBase64: frames,
        keyFrameOffsetsMs: extracted.offsetsMs,
        mimeType: "image/jpeg",
        durationMs: mediaInfo.durationMs,
        sizeBytes: videoBlob.size,
        downgradeReason: reason + " " + String(frames.length)
          + " still frames were sent instead of the video.",
      };
    } catch (keyFrameError: unknown) {
      logWarning("video", "Key-frame extraction failed.", keyFrameError);
      return buildOmittedVideo(
        mediaInfo.durationMs,
        reason + " Key-frame extraction also failed, so no visual evidence was "
        + "sent.");
    }
  }

  if (videoBlob.size <= VIDEO_INLINE_THRESHOLD_BYTES) {
    try {
      const base64Data: string = await blobToBase64(videoBlob);
      return {
        deliveryMode: "inline-base64",
        fileUri: "",
        base64Data: base64Data,
        keyFrameBase64: [],
        keyFrameOffsetsMs: [],
        mimeType: mediaInfo.mimeType.split(";")[0],
        durationMs: mediaInfo.durationMs,
        sizeBytes: videoBlob.size,
        downgradeReason: "",
      };
    } catch (encodeError: unknown) {
      logWarning("video", "Inline encoding failed; falling back to upload.",
        encodeError);
    }
  }

  // The normal path: the Gemini client uploads it and fills in fileUri.
  return {
    deliveryMode: "files-api-uri",
    fileUri: "",
    base64Data: "",
    keyFrameBase64: [],
    keyFrameOffsetsMs: [],
    mimeType: mediaInfo.mimeType.split(";")[0],
    durationMs: mediaInfo.durationMs,
    sizeBytes: videoBlob.size,
    downgradeReason: "",
  };
}

/**
 * Downgrades an already-prepared video to key frames, or to nothing.
 * Used when an upload fails at request time.
 */
export async function downgradeVideoToKeyFrames(
  videoBlob: Blob | null,
  prepared: BundledVideo,
  events: RecordedEvent[],
  failureEventIndexes: number[],
  reason: string,
): Promise<BundledVideo> {
  if (videoBlob === null) {
    return buildOmittedVideo(prepared.durationMs, reason);
  }
  try {
    const offsets: number[] =
      chooseKeyFrameOffsets(prepared.durationMs, events, failureEventIndexes);
    const extracted = await extractKeyFrames(videoBlob, offsets);
    const frames: string[] = extracted.frames;
    return {
      ...prepared,
      deliveryMode: "key-frames",
      fileUri: "",
      base64Data: "",
      keyFrameBase64: frames,
      keyFrameOffsetsMs: extracted.offsetsMs,
      mimeType: "image/jpeg",
      downgradeReason: reason + " " + String(frames.length)
        + " still frames were sent instead.",
    };
  } catch (keyFrameError: unknown) {
    return buildOmittedVideo(prepared.durationMs, reason);
  }
}
