// =============================================================================
// src/offscreen/offscreen.ts
// Owns the streams, the audio mixdown, and the MediaRecorder. The ONLY place in
// the extension where media APIs are touched.
//
// It writes the finished Blob DIRECTLY to IndexedDB and messages only an id,
// because a 60 MB structured clone across the message channel would stall or
// fail outright.
// =============================================================================

import type { MediaRecordInfo } from "../shared/types";
import { asExtensionMessage, sendMessageIgnoringNoReceiver } from "../shared/messages";
import { storeMediaBlob } from "../storage/media";
import { logInfo, logWarning, logError } from "../shared/logger";
import {
  TARGET_VIDEO_WIDTH,
  TARGET_VIDEO_HEIGHT,
  TARGET_FRAME_RATE,
  TARGET_VIDEO_BITS_PER_SECOND,
  TARGET_AUDIO_BITS_PER_SECOND,
  RECORDER_CHUNK_INTERVAL_MS,
  PREFERRED_RECORDING_MIME_TYPES,
} from "../shared/constants";

// -----------------------------------------------------------------------------
// Recorder state
// -----------------------------------------------------------------------------

let recordedChunks: Blob[] = [];
let mediaRecorder: MediaRecorder | null = null;
let combinedStream: MediaStream | null = null;
let tabStream: MediaStream | null = null;
let microphoneStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let playbackElement: HTMLAudioElement | null = null;
let currentSessionId: string = "";

/** Recorded (pause-excluding) duration accounting. */
let segmentStartedAtMs: number = 0;
let accumulatedRecordedMs: number = 0;
let isCurrentlyPaused: boolean = false;

/** Filled in at start so the finished info can report what we actually got. */
let capturedVideoWidth: number = TARGET_VIDEO_WIDTH;
let capturedVideoHeight: number = TARGET_VIDEO_HEIGHT;
let capturedFrameRate: number = TARGET_FRAME_RATE;
let hasMicrophoneAudio: boolean = false;
let hasTabAudio: boolean = false;

/**
 * The MIME type MediaRecorder actually chose.
 *
 * Held separately from the recorder itself because stopRecording() clears the
 * recorder reference before it builds the finished MediaRecordInfo, and the
 * downstream pipeline needs the real type to decide whether the video can be
 * sent to the model as video at all.
 */
let activeRecordingMimeType: string = "";

// -----------------------------------------------------------------------------
// Stream setup
// -----------------------------------------------------------------------------

/**
 * Picks the best container and codec this browser can actually record.
 *
 * WHY the ordered list: MP4 is far more likely to be accepted by a multimodal
 * API and by every player, but Chrome only gained MP4 recording relatively
 * recently, so WebM must remain the fallback.
 *
 * VERIFY: run MediaRecorder.isTypeSupported() in YOUR target Chrome, and check
 * the chosen type against the API's supported-video list. If neither MP4 nor
 * WebM is accepted by the model, the key-frame fallback in ai/video.ts is what
 * saves the feature.
 */
function chooseRecordingMimeType(): string {
  for (let index = 0; index < PREFERRED_RECORDING_MIME_TYPES.length; index = index + 1) {
    const mimeType: string = PREFERRED_RECORDING_MIME_TYPES[index];
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";   // Let the browser pick; we read mimeType back afterwards.
}

/**
 * Turns a tabCapture stream id into a real MediaStream.
 *
 * VERIFY: this constraint shape. The mandatory.chromeMediaSource form is a
 * long-standing Chrome-specific extension to getUserMedia and is what the
 * official offscreen-recording sample uses, but it is non-standard and the
 * exact key names must be confirmed against current documentation.
 */
async function openTabStream(
  tabStreamId: string,
  captureTabAudio: boolean,
): Promise<MediaStream> {
  // The cast is genuinely unavoidable: chromeMediaSource and
  // chromeMediaSourceId are Chrome-only constraint keys that do not exist in
  // the standard MediaTrackConstraints type, so the object cannot be typed
  // accurately without inventing a shape TypeScript would reject anyway.
  // ONLY the Chrome-specific source keys go in `mandatory`.
  //
  // An earlier version also put maxWidth / maxHeight / maxFrameRate in this
  // legacy block. Those keys are long deprecated, so the size limits are now
  // applied to the track afterwards with the standard applyConstraints() API
  // instead. (Testing showed this was not what caused capture to fail - the
  // audio track was - but mixing deprecated constraint dialects in a call this
  // fragile is not worth the risk.)
  const videoConstraint = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: tabStreamId,
    },
  };

  const chromeConstraints = (
    captureTabAudio
      ? {
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: tabStreamId,
            },
          },
          video: videoConstraint,
        }
      : { video: videoConstraint }
  ) as unknown as MediaStreamConstraints;

  const stream: MediaStream =
    await navigator.mediaDevices.getUserMedia(chromeConstraints);

  await limitVideoTrackSize(stream);
  return stream;
}

/**
 * Applies the capture size and frame rate with the STANDARD constraint API.
 *
 * Failure here is deliberately non-fatal: a slightly larger recording is a cost
 * problem, whereas refusing to record is a lost session.
 */
async function limitVideoTrackSize(stream: MediaStream): Promise<void> {
  const videoTracks: MediaStreamTrack[] = stream.getVideoTracks();
  if (videoTracks.length === 0) {
    return;
  }
  try {
    await videoTracks[0].applyConstraints({
      width: { max: TARGET_VIDEO_WIDTH },
      height: { max: TARGET_VIDEO_HEIGHT },
      frameRate: { max: TARGET_FRAME_RATE },
    });
  } catch (constraintError: unknown) {
    logWarning("offscreen",
      "Could not limit the capture size; recording at the tab's own size.",
      constraintError);
  }
}

/**
 * Opens the microphone, or returns null if it is unavailable or denied.
 *
 * WHY it returns null instead of throwing: losing the microphone must degrade
 * the session to a silent video, never cancel the recording.
 *
 * VERIFY: whether an offscreen document can raise a permission prompt at all.
 * Our understanding is that it cannot, so the grant must already exist — which
 * is why the options page has an "Enable microphone narration" button that
 * requests it once from a normal extension page.
 */
async function openMicrophoneStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  } catch (microphoneError: unknown) {
    logWarning("offscreen", "Microphone unavailable; recording video only.",
      microphoneError);
    return null;
  }
}

/**
 * Mixes tab audio and microphone audio into ONE audio track.
 *
 * WHY a mixdown is required rather than simply adding two tracks: a MediaStream
 * with two audio tracks records unreliably and most players read only the first
 * track, so the tester's narration would silently disappear.
 */
function mixAudioTracks(
  openTabAudioTracks: MediaStreamTrack[],
  openMicrophoneTracks: MediaStreamTrack[],
): MediaStreamTrack | null {
  if (openTabAudioTracks.length === 0 && openMicrophoneTracks.length === 0) {
    return null;
  }

  audioContext = new AudioContext();
  const destination: MediaStreamAudioDestinationNode =
    audioContext.createMediaStreamDestination();

  if (openTabAudioTracks.length > 0) {
    const tabSource: MediaStreamAudioSourceNode =
      audioContext.createMediaStreamSource(new MediaStream(openTabAudioTracks));
    tabSource.connect(destination);

    // Play the tab audio back to the speakers as well.
    // WHY: capturing a tab's audio mutes it for the tester, who then thinks the
    // application has broken. VERIFY whether this is still necessary in your
    // target Chrome.
    tabSource.connect(audioContext.destination);
  }

  if (openMicrophoneTracks.length > 0) {
    const microphoneSource: MediaStreamAudioSourceNode =
      audioContext.createMediaStreamSource(new MediaStream(openMicrophoneTracks));
    microphoneSource.connect(destination);
    // Deliberately NOT connected to audioContext.destination: that would echo
    // the tester's own voice back at them through their speakers.
  }

  const mixedTracks: MediaStreamTrack[] = destination.stream.getAudioTracks();
  if (mixedTracks.length === 0) {
    return null;
  }
  return mixedTracks[0];
}

// -----------------------------------------------------------------------------
// Recording lifecycle
// -----------------------------------------------------------------------------

/**
 * Starts recording. Called once per session.
 */
async function startRecording(
  tabStreamId: string,
  captureMicrophone: boolean,
  captureTabAudio: boolean,
  sessionId: string,
): Promise<void> {
  currentSessionId = sessionId;
  recordedChunks = [];
  accumulatedRecordedMs = 0;
  isCurrentlyPaused = false;

  // ONE attempt. There is no second chance.
  //
  // A failed tabCapture request leaves the tab registered as captured, so every
  // later getMediaStreamId for it returns "Cannot capture a tab with an active
  // stream". Retrying - with the same id or a fresh one - cannot work, which is
  // why the request has to be right the first time and why tab audio is opt-in.
  tabStream = await openTabStream(tabStreamId, captureTabAudio);

  microphoneStream = null;
  if (captureMicrophone) {
    microphoneStream = await openMicrophoneStream();
  }

  const videoTracks: MediaStreamTrack[] = tabStream.getVideoTracks();
  const tabAudioTracks: MediaStreamTrack[] = tabStream.getAudioTracks();
  const microphoneTracks: MediaStreamTrack[] =
    microphoneStream === null ? [] : microphoneStream.getAudioTracks();

  hasTabAudio = tabAudioTracks.length > 0;
  hasMicrophoneAudio = microphoneTracks.length > 0;

  const mixedAudioTrack: MediaStreamTrack | null =
    mixAudioTracks(tabAudioTracks, microphoneTracks);

  const tracksForRecording: MediaStreamTrack[] = [];
  for (let index = 0; index < videoTracks.length; index = index + 1) {
    tracksForRecording.push(videoTracks[index]);
  }
  if (mixedAudioTrack !== null) {
    tracksForRecording.push(mixedAudioTrack);
  }

  if (tracksForRecording.length === 0) {
    throw new Error("Tab capture produced no tracks to record.");
  }

  if (videoTracks.length > 0) {
    const settings: MediaTrackSettings = videoTracks[0].getSettings();
    capturedVideoWidth = settings.width ?? TARGET_VIDEO_WIDTH;
    capturedVideoHeight = settings.height ?? TARGET_VIDEO_HEIGHT;
    capturedFrameRate = settings.frameRate ?? TARGET_FRAME_RATE;

    // If the tester closes the tab, the track ends. Finish cleanly rather than
    // leaving the session stuck in "processing" forever.
    videoTracks[0].addEventListener("ended", function onTrackEnded(): void {
      logWarning("offscreen", "The captured tab ended; finalising the recording.");
      void stopRecording();
    });
  }

  combinedStream = new MediaStream(tracksForRecording);

  const mimeType: string = chooseRecordingMimeType();
  const recorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: TARGET_VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: TARGET_AUDIO_BITS_PER_SECOND,
  };
  if (mimeType !== "") {
    recorderOptions.mimeType = mimeType;
  }

  mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);

  mediaRecorder.ondataavailable = function onDataAvailable(event: BlobEvent): void {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onerror = function onRecorderError(event: Event): void {
    void reportFailure("MediaRecorder error: " + String(event.type));
  };

  // A non-zero timeslice makes chunks arrive continuously instead of only at
  // stop. WHY that matters: if the browser crashes mid-session we still hold
  // most of the recording rather than losing everything.
  mediaRecorder.start(RECORDER_CHUNK_INTERVAL_MS);
  activeRecordingMimeType = mediaRecorder.mimeType;
  segmentStartedAtMs = Date.now();

  logInfo("offscreen", "Recording started (" + mediaRecorder.mimeType + ").");

  await sendMessageIgnoringNoReceiver({
    kind: "offscreen/ready",
    info: buildMediaInfo("", 0, "recording", ""),
  });
}

/**
 * Pauses recording.
 *
 * MediaRecorder.pause() stops emitting data WITHOUT closing the file, so the
 * single resulting Blob stays valid. That is exactly the behaviour the product
 * needs: pause and resume must not corrupt the file.
 */
function pauseRecording(): void {
  if (mediaRecorder === null || mediaRecorder.state !== "recording") {
    return;
  }
  mediaRecorder.pause();
  accumulatedRecordedMs = accumulatedRecordedMs + (Date.now() - segmentStartedAtMs);
  isCurrentlyPaused = true;
  logInfo("offscreen", "Recording paused.");
}

/**
 * Resumes recording into the SAME file.
 */
function resumeRecording(): void {
  if (mediaRecorder === null || mediaRecorder.state !== "paused") {
    return;
  }
  mediaRecorder.resume();
  segmentStartedAtMs = Date.now();
  isCurrentlyPaused = false;
  logInfo("offscreen", "Recording resumed.");
}

/**
 * Stops recording, assembles the single Blob, and writes it to IndexedDB.
 */
async function stopRecording(): Promise<void> {
  if (mediaRecorder === null) {
    return;
  }

  const recorder: MediaRecorder = mediaRecorder;
  mediaRecorder = null;   // Guard against a second stop from the track-ended handler.

  const finalMimeType: string =
    recorder.mimeType !== "" ? recorder.mimeType : activeRecordingMimeType;
  activeRecordingMimeType = finalMimeType;

  if (!isCurrentlyPaused) {
    accumulatedRecordedMs = accumulatedRecordedMs + (Date.now() - segmentStartedAtMs);
  }

  try {
    if (recorder.state !== "inactive") {
      const stopPromise: Promise<void> = new Promise<void>(
        function executor(resolve): void {
          recorder.onstop = function onStop(): void {
            resolve();
          };
        },
      );
      recorder.stop();
      await stopPromise;
    }

    const finalBlob: Blob = new Blob(recordedChunks, { type: finalMimeType });
    releaseEverything();

    if (finalBlob.size === 0) {
      await reportFailure("The recording finished with no data.");
      return;
    }

    const mediaId: string = await storeMediaBlob(
      currentSessionId,
      finalBlob,
      accumulatedRecordedMs,
      finalMimeType,
    );

    logInfo("offscreen", "Recording stored (" + String(finalBlob.size) + " bytes).");

    await sendMessageIgnoringNoReceiver({
      kind: "offscreen/finished",
      sessionId: currentSessionId,
      info: buildMediaInfo(mediaId, finalBlob.size, "stopped", ""),
    });
  } catch (stopError: unknown) {
    logError("offscreen", "Finalising the recording failed.", stopError);
    await reportFailure(String(stopError));
  }
}

/**
 * Builds the MediaRecordInfo the service worker stores on the session.
 */
function buildMediaInfo(
  mediaId: string,
  sizeBytes: number,
  state: MediaRecordInfo["state"],
  failureReason: string,
): MediaRecordInfo {
  return {
    mediaId: mediaId,
    mimeType: activeRecordingMimeType,
    sizeBytes: sizeBytes,
    durationMs: accumulatedRecordedMs,
    videoWidth: capturedVideoWidth,
    videoHeight: capturedVideoHeight,
    frameRate: capturedFrameRate,
    hasMicrophoneAudio: hasMicrophoneAudio,
    hasTabAudio: hasTabAudio,
    state: state,
    failureReason: failureReason,
  };
}

/**
 * Tells the service worker the recording failed, so the session still completes
 * with its events and its script intact.
 */
async function reportFailure(reason: string): Promise<void> {
  releaseEverything();
  await sendMessageIgnoringNoReceiver({
    kind: "offscreen/error",
    sessionId: currentSessionId,
    reason: reason,
  });
}

/**
 * Releases every track and closes the AudioContext.
 *
 * WHY it matters: leaving a microphone or tab track live keeps the browser's
 * recording indicator lit, which testers correctly find alarming.
 */
function releaseEverything(): void {
  const streams: (MediaStream | null)[] = [combinedStream, tabStream, microphoneStream];
  for (let streamIndex = 0; streamIndex < streams.length; streamIndex = streamIndex + 1) {
    const stream: MediaStream | null = streams[streamIndex];
    if (stream === null) {
      continue;
    }
    const tracks: MediaStreamTrack[] = stream.getTracks();
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex = trackIndex + 1) {
      tracks[trackIndex].stop();
    }
  }
  combinedStream = null;
  tabStream = null;
  microphoneStream = null;

  if (playbackElement !== null) {
    playbackElement.pause();
    playbackElement.srcObject = null;
    playbackElement = null;
  }

  if (audioContext !== null) {
    void audioContext.close();
    audioContext = null;
  }

  recordedChunks = [];
}

// -----------------------------------------------------------------------------
// Message handling
// -----------------------------------------------------------------------------

/**
 * Handles the four commands the service worker sends.
 *
 * Messages are broadcast to every extension context, so this listener ignores
 * everything that is not namespaced "offscreen/".
 */
function handleRuntimeMessage(rawMessage: unknown): void {
  const message = asExtensionMessage(rawMessage);
  if (message === null) {
    return;
  }

  if (message.kind === "offscreen/start") {
    startRecording(
      message.tabStreamId,
      message.captureMicrophone,
      message.captureTabAudio,
      message.sessionId,
    ).catch(function onStartError(startError: unknown): void {
      logError("offscreen", "Could not start recording.", startError);
      void reportFailure(String(startError));
    });
    return;
  }

  if (message.kind === "offscreen/pause") {
    pauseRecording();
    return;
  }

  if (message.kind === "offscreen/resume") {
    resumeRecording();
    return;
  }

  if (message.kind === "offscreen/stop") {
    void stopRecording();
  }
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);
logInfo("offscreen", "Offscreen recorder loaded.");
