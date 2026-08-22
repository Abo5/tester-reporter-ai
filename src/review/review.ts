// =============================================================================
// src/review/review.ts
// The review page, which is also where the POST-STOP PIPELINE runs.
//
// WHY the pipeline runs here and not in the service worker: a normal document
// is not terminated for being idle, so codegen, evidence bundling, key-frame
// extraction and the AI call are all safe from the MV3 worker lifecycle. It is
// also the context that already has a DOM, which key-frame extraction needs.
//
// DESIGN INVARIANT, enforced by the order of operations below:
// THE TESTER NEVER LOSES THEIR RECORDING BECAUSE THE AI FAILED.
//   1. The video Blob is already in IndexedDB before this page opens.
//   2. The Playwright script is generated and saved locally.
//   3. The page renders as fully useful.
//   4. Only then is a network request even considered.
// =============================================================================

import type {
  RecordingSession,
  RecordedEvent,
  DomSnapshot,
  ElementContext,
  NetworkEntry,
  ConsoleEntry,
  GeneratedBugReport,
  AIEvidenceBundle,
  ExtensionSettings,
} from "../shared/types";
import { getSession, updateSession, deleteSession } from "../storage/sessions";
import { readEventsForSession } from "../storage/events";
import {
  readDomSnapshots,
  readElementContexts,
  readNetworkEntries,
  readConsoleEntries,
} from "../storage/artifacts";
import { getMediaBlob, deleteMediaForSession, type StoredMedia } from "../storage/media";
import { readSettings, writeSettings, incrementRequestCount } from "../storage/settings";
import { generatePlaywrightSpec, buildSpecFileName } from "../codegen/generate-spec";
import { buildEvidenceBundle, findFailureEventIndexes } from "../ai/bundle";
import { generateBugReport, type GeminiOutcome } from "../ai/gemini";
import { formatReportAsPlainText, formatReportWithMetadata } from "../ai/format";
import {
  renderEvidenceBadges,
  renderUnverifiedClaims,
  renderSupportingEvidence,
  renderSecondaryIssues,
} from "./evidence-badges";
import { formatVideoTimestamp, formatDuration, formatBytes } from "../shared/time";
import { logError, logWarning } from "../shared/logger";

// -----------------------------------------------------------------------------
// Element lookup
// -----------------------------------------------------------------------------

/** Looks up an element by id and throws if it is missing. */
function requireElement<T extends HTMLElement>(elementId: string): T {
  const element: HTMLElement | null = document.getElementById(elementId);
  if (element === null) {
    throw new Error("Missing element in review.html: #" + elementId);
  }
  return element as T;
}

const sessionNameHeading = requireElement<HTMLElement>("session-name");
const sessionMetaLine = requireElement<HTMLElement>("session-meta");
const pageError = requireElement<HTMLElement>("page-error");
const settingsButton = requireElement<HTMLButtonElement>("settings-button");
const deleteButton = requireElement<HTMLButtonElement>("delete-button");

const sessionVideo = requireElement<HTMLVideoElement>("session-video");
const videoNote = requireElement<HTMLElement>("video-note");
const downloadVideoButton = requireElement<HTMLButtonElement>("download-video-button");
const deleteVideoButton = requireElement<HTMLButtonElement>("delete-video-button");

const stepCountLabel = requireElement<HTMLElement>("step-count");
const stepList = requireElement<HTMLOListElement>("step-list");

const reportStatusText = requireElement<HTMLElement>("report-status-text");
const reportActions = requireElement<HTMLElement>("report-actions");
const generateButton = requireElement<HTMLButtonElement>("generate-button");
const generateNoVideoButton =
  requireElement<HTMLButtonElement>("generate-no-video-button");
const setupPanel = requireElement<HTMLElement>("setup-panel");
const openSettingsButton = requireElement<HTMLButtonElement>("open-settings-button");
const unverifiedBanner = requireElement<HTMLElement>("unverified-banner");
const unverifiedList = requireElement<HTMLElement>("unverified-list");
const evidenceBadges = requireElement<HTMLElement>("evidence-badges");
const reportText = requireElement<HTMLTextAreaElement>("report-text");
const copyReportButton = requireElement<HTMLButtonElement>("copy-report-button");
const copyReportFullButton =
  requireElement<HTMLButtonElement>("copy-report-full-button");
const regenerateButton = requireElement<HTMLButtonElement>("regenerate-button");
const copyStatus = requireElement<HTMLElement>("copy-status");
const supportingContainer = requireElement<HTMLElement>("supporting-container");
const supportingList = requireElement<HTMLElement>("supporting-list");
const secondaryContainer = requireElement<HTMLElement>("secondary-container");
const secondaryList = requireElement<HTMLElement>("secondary-list");

const scriptText = requireElement<HTMLElement>("script-text");
const copyScriptButton = requireElement<HTMLButtonElement>("copy-script-button");
const downloadScriptButton = requireElement<HTMLButtonElement>("download-script-button");

const redactionLine = requireElement<HTMLElement>("redaction-line");
const bundleText = requireElement<HTMLElement>("bundle-text");
const rawResponseContainer = requireElement<HTMLElement>("raw-response-container");
const rawResponseText = requireElement<HTMLElement>("raw-response-text");

const consentDialog = requireElement<HTMLDialogElement>("consent-dialog");
const consentCheckbox = requireElement<HTMLInputElement>("consent-checkbox");
const consentWithVideo = requireElement<HTMLButtonElement>("consent-with-video");
const consentWithoutVideo = requireElement<HTMLButtonElement>("consent-without-video");
const consentCancel = requireElement<HTMLButtonElement>("consent-cancel");

// -----------------------------------------------------------------------------
// Page state
// -----------------------------------------------------------------------------

/** Everything loaded for the session currently on screen. */
interface LoadedSession {
  session: RecordingSession;
  events: RecordedEvent[];
  snapshots: DomSnapshot[];
  contexts: ElementContext[];
  networkEntries: NetworkEntry[];
  consoleEntries: ConsoleEntry[];
  media: StoredMedia | null;
}

let loaded: LoadedSession | null = null;
let settings: ExtensionSettings | null = null;
let videoObjectUrl: string = "";
let isGenerating: boolean = false;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** Shows a page-level error the tester cannot miss. */
function showPageError(text: string): void {
  pageError.hidden = false;
  pageError.textContent = text;
}

/** Reads the session id out of the query string. */
function readSessionIdFromUrl(): string {
  const params: URLSearchParams = new URLSearchParams(window.location.search);
  return params.get("session") ?? "";
}

/** Briefly shows a confirmation next to the copy buttons. */
let copyStatusTimerId: number = 0;
function flashCopyStatus(text: string): void {
  copyStatus.textContent = text;
  window.clearTimeout(copyStatusTimerId);
  copyStatusTimerId = window.setTimeout(function clearStatus(): void {
    copyStatus.textContent = "";
  }, 2000);
}

/**
 * Triggers a download of a text file.
 * WHY an object URL and not a data: URL: a generated spec can be tens of
 * kilobytes, which is past the practical limit for data: URLs in some browsers.
 */
function downloadTextFile(fileName: string, contents: string, mimeType: string): void {
  const blob: Blob = new Blob([contents], { type: mimeType });
  const url: string = URL.createObjectURL(blob);
  const link: HTMLAnchorElement = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(function revoke(): void {
    URL.revokeObjectURL(url);
  }, 10000);
}

/** Copies text to the clipboard and reports success or failure honestly. */
async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flashCopyStatus(label + " copied.");
  } catch (copyError: unknown) {
    flashCopyStatus("Could not copy: " + String(copyError));
  }
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

/** Reads every artifact belonging to one session. */
async function loadSession(sessionId: string): Promise<LoadedSession | null> {
  const session: RecordingSession | null = await getSession(sessionId);
  if (session === null) {
    return null;
  }

  const events: RecordedEvent[] = await readEventsForSession(sessionId);
  const snapshots: DomSnapshot[] = await readDomSnapshots(sessionId);
  const contexts: ElementContext[] = await readElementContexts(sessionId);
  const networkEntries: NetworkEntry[] = await readNetworkEntries(sessionId);
  const consoleEntries: ConsoleEntry[] = await readConsoleEntries(sessionId);

  let media: StoredMedia | null = null;
  if (session.media.mediaId !== "") {
    media = await getMediaBlob(session.media.mediaId);
  }

  return {
    session: session,
    events: events,
    snapshots: snapshots,
    contexts: contexts,
    networkEntries: networkEntries,
    consoleEntries: consoleEntries,
    media: media,
  };
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/** Renders the header line describing the session. */
function renderHeader(state: LoadedSession): void {
  sessionNameHeading.textContent = state.session.name;

  const parts: string[] = [];
  parts.push(new Date(state.session.startedAtMs).toLocaleString());
  parts.push(formatDuration(state.session.recordedDurationMs));
  parts.push(String(state.events.length) + " steps");
  parts.push(String(state.snapshots.length) + " page snapshots");

  let failureCount: number = 0;
  for (let index = 0; index < state.networkEntries.length; index = index + 1) {
    if (state.networkEntries[index].isFailure) {
      failureCount = failureCount + 1;
    }
  }
  if (failureCount > 0) {
    parts.push(String(failureCount) + " failed requests");
  }
  if (state.consoleEntries.length > 0) {
    parts.push(String(state.consoleEntries.length) + " console entries");
  }

  sessionMetaLine.textContent = parts.join(" · ");
}

/**
 * Renders the video player.
 *
 * KNOWN QUIRK handled here: WebM produced by MediaRecorder frequently lacks
 * duration metadata in its header, which makes some players refuse to seek. The
 * standard workaround is to seek to a very large time once, which forces the
 * browser to compute the duration. We also know the true duration ourselves, so
 * the step list never has to trust the file.
 */
function renderVideo(state: LoadedSession): void {
  if (state.media === null) {
    sessionVideo.hidden = true;
    downloadVideoButton.disabled = true;
    deleteVideoButton.disabled = true;

    if (state.session.media.state === "failed") {
      videoNote.textContent =
        "No video was stored for this session. " + state.session.media.failureReason;
    } else {
      videoNote.textContent = "No video was stored for this session.";
    }
    return;
  }

  videoObjectUrl = URL.createObjectURL(state.media.blob);
  sessionVideo.src = videoObjectUrl;
  sessionVideo.hidden = false;

  let hasForcedDuration: boolean = false;
  sessionVideo.addEventListener("loadedmetadata", function onMetadata(): void {
    if (hasForcedDuration) {
      return;
    }
    hasForcedDuration = true;
    if (!Number.isFinite(sessionVideo.duration)) {
      sessionVideo.currentTime = 1e6;
      window.setTimeout(function resetTime(): void {
        sessionVideo.currentTime = 0;
      }, 200);
    }
  });

  const noteParts: string[] = [];
  noteParts.push(formatBytes(state.media.blob.size));
  noteParts.push(state.session.media.mimeType);
  noteParts.push(
    String(state.session.media.videoWidth) + "x"
    + String(state.session.media.videoHeight));
  if (state.session.media.hasMicrophoneAudio) {
    noteParts.push("with narration");
  } else {
    noteParts.push("no narration");
  }
  videoNote.textContent = noteParts.join(" · ");
}

/**
 * Renders the step list, synced to the video timeline.
 *
 * Each event already carries videoOffsetMs corrected for pauses, so clicking a
 * row seeks to the right frame even in a session that was paused three times.
 */
function renderStepList(state: LoadedSession): void {
  stepList.replaceChildren();
  stepCountLabel.textContent = "(" + String(state.events.length) + ")";

  if (state.events.length === 0) {
    const empty: HTMLLIElement = document.createElement("li");
    empty.textContent = "No interactions were recorded.";
    stepList.append(empty);
    return;
  }

  for (let index = 0; index < state.events.length; index = index + 1) {
    const event: RecordedEvent = state.events[index];

    const item: HTMLLIElement = document.createElement("li");
    const button: HTMLButtonElement = document.createElement("button");
    button.type = "button";
    button.className = "step-button";

    const timeSpan: HTMLSpanElement = document.createElement("span");
    timeSpan.className = "step-time";
    timeSpan.textContent = formatVideoTimestamp(event.videoOffsetMs);

    const textSpan: HTMLSpanElement = document.createElement("span");
    textSpan.className = "step-text";
    textSpan.textContent = describeEventForHuman(event);
    textSpan.title = textSpan.textContent;

    button.append(timeSpan, textSpan);

    if (hasFailureNear(state, event)) {
      const failureSpan: HTMLSpanElement = document.createElement("span");
      failureSpan.className = "step-failure";
      failureSpan.textContent = "● failure";
      failureSpan.title = "A request failed or an error was logged around here.";
      button.append(failureSpan);
    }

    button.addEventListener("click", function onSeek(): void {
      if (state.media === null || event.videoOffsetMs < 0) {
        return;
      }
      sessionVideo.currentTime = event.videoOffsetMs / 1000;
      void sessionVideo.play().catch(function ignorePlayError(): void {
        // Autoplay may be refused; seeking still happened, which is the point.
      });
    });

    item.append(button);
    stepList.append(item);
  }
}

/** One-line human description of a recorded event. */
function describeEventForHuman(event: RecordedEvent): string {
  let target: string = "";
  if (event.locator !== null) {
    if (event.locator.accessibleName !== "") {
      target = ' "' + event.locator.accessibleName + '"';
    } else if (event.locator.visibleText !== "") {
      target = ' "' + event.locator.visibleText + '"';
    } else {
      target = " <" + event.locator.tagName + ">";
    }
  }

  if (event.type === "click") {
    return "Click" + target;
  }
  if (event.type === "dblclick") {
    return "Double-click" + target;
  }
  if (event.type === "input") {
    return "Type \"" + event.value + "\" into" + target;
  }
  if (event.type === "select-option") {
    return "Choose \"" + event.value + "\" in" + target;
  }
  if (event.type === "check") {
    return "Tick" + target;
  }
  if (event.type === "uncheck") {
    return "Untick" + target;
  }
  if (event.type === "press-key") {
    return "Press " + event.value + (target === "" ? "" : " in" + target);
  }
  if (event.type === "hover") {
    return "Hover over" + target + " (something changed on screen)";
  }
  if (event.type === "scroll") {
    return "Scroll to " + event.value;
  }
  if (event.type === "navigate") {
    return "Open " + event.pageUrl;
  }
  if (event.type === "url-change") {
    return "Page moves to " + event.pageUrl;
  }
  if (event.type === "reload") {
    return "Reload the page";
  }
  if (event.type === "tab-activated") {
    return "Switch tab (" + event.value + ")";
  }
  if (event.type === "tester-note") {
    return "Note: " + event.value;
  }
  return event.type;
}

/** True when a failure was recorded within a few seconds of this event. */
function hasFailureNear(state: LoadedSession, event: RecordedEvent): boolean {
  const windowMs: number = 3000;
  for (let index = 0; index < state.networkEntries.length; index = index + 1) {
    const entry: NetworkEntry = state.networkEntries[index];
    if (!entry.isFailure) {
      continue;
    }
    if (Math.abs(entry.startedAtMs - event.wallClockMs) < windowMs) {
      return true;
    }
  }
  for (let index = 0; index < state.consoleEntries.length; index = index + 1) {
    const entry: ConsoleEntry = state.consoleEntries[index];
    if (entry.level === "warning") {
      continue;
    }
    if (Math.abs(entry.wallClockMs - event.wallClockMs) < windowMs) {
      return true;
    }
  }
  return false;
}

/** Renders the generated Playwright script. */
function renderScript(state: LoadedSession): void {
  scriptText.textContent = state.session.playwrightScript;
}

/** Renders a finished report into the editable box and its badges. */
function renderReport(
  state: LoadedSession,
  report: GeneratedBugReport,
  videoWasSent: boolean,
): void {
  const text: string =
    state.session.editedReportText !== ""
      ? state.session.editedReportText
      : formatReportAsPlainText(report);

  reportText.value = text;
  reportText.dir = state.session.reportLanguage === "ar" ? "rtl" : "ltr";

  renderEvidenceBadges(evidenceBadges, report, videoWasSent);
  renderUnverifiedClaims(unverifiedBanner, unverifiedList, report);
  renderSupportingEvidence(supportingContainer, supportingList, report);
  renderSecondaryIssues(secondaryContainer, secondaryList, report);

  reportStatusText.textContent =
    "Report ready. Edit the wording below before you share it.";
  reportActions.hidden = true;
}

/** Renders the redaction summary line, so the gate is observable. */
function renderRedactionSummary(summary: Record<string, number>): void {
  const names: string[] = Object.keys(summary);
  if (names.length === 0) {
    redactionLine.textContent =
      "Redaction found nothing to remove in this session.";
    return;
  }

  const readable: string[] = [];
  for (let index = 0; index < names.length; index = index + 1) {
    readable.push(String(summary[names[index]]) + " " + names[index]);
  }
  redactionLine.textContent =
    "Redaction removed " + readable.join(", ") + " before anything was sent.";
}

/** Renders the evidence bundle so the tester can see exactly what was sent. */
function renderBundle(bundle: AIEvidenceBundle): void {
  // The video payload itself is megabytes of base64 and would freeze the page.
  const displayable = {
    ...bundle,
    video: {
      ...bundle.video,
      base64Data: bundle.video.base64Data === "" ? "" : "[omitted from this view]",
      keyFrameBase64:
        bundle.video.keyFrameBase64.length === 0
          ? []
          : ["[" + String(bundle.video.keyFrameBase64.length)
             + " key frames omitted from this view]"],
    },
  };

  bundleText.textContent = JSON.stringify(displayable, null, 2);
  renderRedactionSummary(bundle.redactionSummary);

  reportStatusText.textContent =
    "Evidence ready: about " + bundle.estimatedInputTokens.toLocaleString()
    + " tokens, including " + describeVideoDelivery(bundle) + ".";
}

/** Plain-English description of how the video will be sent. */
function describeVideoDelivery(bundle: AIEvidenceBundle): string {
  if (bundle.video.deliveryMode === "omitted") {
    return "no video";
  }
  if (bundle.video.deliveryMode === "key-frames") {
    return String(bundle.video.keyFrameBase64.length) + " still frames";
  }
  return "a " + String(Math.round(bundle.video.durationMs / 1000))
    + " second video";
}

// -----------------------------------------------------------------------------
// The pipeline
// -----------------------------------------------------------------------------

/**
 * Generates the Playwright script if it does not exist yet, and saves it.
 *
 * This runs BEFORE anything touches the network, and its result is persisted
 * immediately. That ordering is the design invariant, not an optimisation.
 */
async function ensureScriptGenerated(state: LoadedSession): Promise<void> {
  if (state.session.playwrightScript !== "") {
    return;
  }

  const script: string = generatePlaywrightSpec(
    state.session,
    state.events,
    state.networkEntries,
  );

  state.session.playwrightScript = script;
  await updateSession(state.session.id, { playwrightScript: script });
}

/**
 * Builds the evidence bundle. Throws only if the redaction gate throws, which
 * must stop the whole pipeline rather than degrade it.
 */
async function buildBundle(
  state: LoadedSession,
  allowVideoUpload: boolean,
): Promise<AIEvidenceBundle> {
  const currentSettings: ExtensionSettings =
    settings ?? (await readSettings());

  return await buildEvidenceBundle({
    session: state.session,
    events: state.events,
    snapshots: state.snapshots,
    contexts: state.contexts,
    networkEntries: state.networkEntries,
    consoleEntries: state.consoleEntries,
    videoBlob: state.media === null ? null : state.media.blob,
    reportLanguage: state.session.reportLanguage,
    allowVideoUpload: allowVideoUpload,
    customRedactionPatterns: currentSettings.customRedactionPatterns,
  });
}

/**
 * Turns a Gemini outcome into a rendered page state.
 *
 * EVERY branch here leaves the video and the script on screen and usable. That
 * is the whole point of the invariant, expressed in code.
 */
async function handleOutcome(
  state: LoadedSession,
  outcome: GeminiOutcome,
): Promise<void> {
  rawResponseContainer.hidden = true;

  if (outcome.kind === "success") {
    const videoWasSent: boolean =
      outcome.bundleUsed.video.deliveryMode !== "omitted";

    await updateSession(state.session.id, {
      status: "complete",
      bugReport: outcome.report,
      reportFailureReason: "",
      lastVideoDeliveryMode: outcome.bundleUsed.video.deliveryMode,
      videoDowngradeReason: outcome.bundleUsed.video.downgradeReason,
      redactionSummary: outcome.bundleUsed.redactionSummary,
    });
    state.session.bugReport = outcome.report;

    renderBundle(outcome.bundleUsed);
    renderReport(state, outcome.report, videoWasSent);

    if (outcome.bundleUsed.video.downgradeReason !== "") {
      reportStatusText.textContent =
        "Report ready. " + outcome.bundleUsed.video.downgradeReason;
      reportActions.hidden = true;
    }

    rawResponseContainer.hidden = false;
    rawResponseText.textContent = outcome.rawResponseText;
    await incrementRequestCount();
    return;
  }

  // --- Every failure path below still leaves the artifacts intact. ---------
  await markReportFailed(state, describeOutcomeForTester(outcome));

  if (outcome.kind === "no-api-key") {
    setupPanel.hidden = false;
    return;
  }

  if (outcome.kind === "safety-blocked" || outcome.kind === "empty-response"
      || outcome.kind === "malformed-json") {
    rawResponseContainer.hidden = false;
    rawResponseText.textContent = outcome.rawResponseText;

    if (outcome.kind === "malformed-json") {
      // Surface the validation problems in the same amber banner the tester
      // already knows to read, rather than inventing a second warning style.
      unverifiedBanner.hidden = false;
      unverifiedList.replaceChildren();
      for (let index = 0; index < outcome.problems.length; index = index + 1) {
        const item: HTMLLIElement = document.createElement("li");
        item.textContent = outcome.problems[index];
        unverifiedList.append(item);
      }
    }
  }
}

/** Human-readable explanation of a failed outcome, with the next action. */
function describeOutcomeForTester(outcome: GeminiOutcome): string {
  if (outcome.kind === "no-api-key") {
    return "No API key is set, so no report was generated. Your video and your "
      + "Playwright script are ready below.";
  }
  if (outcome.kind === "offline") {
    return "You are offline. The session is saved — press Generate report when "
      + "you are back online.";
  }
  if (outcome.kind === "rate-limited") {
    return "The AI service is rate limiting this API key (tried "
      + String(outcome.attemptsMade) + " times). Wait a minute and press "
      + "Regenerate.";
  }
  if (outcome.kind === "safety-blocked") {
    return "The AI service refused to answer for this content. The full evidence "
      + "bundle is below so you can write the report by hand.";
  }
  if (outcome.kind === "empty-response") {
    return "The AI returned an empty response. The full evidence bundle is below "
      + "so you can write the report by hand.";
  }
  if (outcome.kind === "malformed-json") {
    return "The AI returned something this extension could not read, twice. The "
      + "raw response and the evidence bundle are below.";
  }
  if (outcome.kind === "upload-failed") {
    return "The video could not be uploaded: " + outcome.message;
  }
  if (outcome.kind === "http-error") {
    return "The AI request failed (HTTP " + String(outcome.statusCode) + "). "
      + outcome.message;
  }
  // "success" never reaches here; the caller handles it before calling this.
  return "The report could not be generated.";
}

/** Records the failure on the session and shows it, without losing anything. */
async function markReportFailed(
  state: LoadedSession,
  reason: string,
): Promise<void> {
  await updateSession(state.session.id, {
    status: "report-failed",
    reportFailureReason: reason,
  });
  reportStatusText.textContent = reason;
  reportActions.hidden = false;
  generateButton.textContent = "Try again";
}

/**
 * Runs the whole AI step: bundle, call, render.
 *
 * @param allowVideoUpload false for "generate without video".
 */
async function runReportGeneration(allowVideoUpload: boolean): Promise<void> {
  if (loaded === null || isGenerating) {
    return;
  }
  const state: LoadedSession = loaded;

  isGenerating = true;
  generateButton.disabled = true;
  generateNoVideoButton.disabled = true;
  regenerateButton.disabled = true;
  reportStatusText.textContent = "Preparing the evidence and redacting it…";
  reportActions.hidden = true;

  try {
    const currentSettings: ExtensionSettings = await readSettings();
    settings = currentSettings;

    let bundle: AIEvidenceBundle;
    try {
      bundle = await buildBundle(state, allowVideoUpload);
    } catch (redactionError: unknown) {
      // THE GATE THREW. No request is made at all.
      logError("review", "Redaction blocked the request.", redactionError);
      showPageError(String(redactionError));
      await markReportFailed(state, String(redactionError));
      return;
    }

    renderBundle(bundle);
    reportStatusText.textContent =
      "Sending about " + bundle.estimatedInputTokens.toLocaleString()
      + " tokens to " + currentSettings.modelId + "…";

    const failureEventIndexes: number[] = findFailureEventIndexes(
      state.events,
      bundle.networkFailures,
      bundle.consoleErrors,
    );

    const outcome: GeminiOutcome = await generateBugReport({
      apiKey: currentSettings.geminiApiKey,
      modelId: currentSettings.modelId,
      bundle: bundle,
      videoBlob: state.media === null ? null : state.media.blob,
      events: state.events,
      failureEventIndexes: failureEventIndexes,
    });

    await handleOutcome(state, outcome);
  } catch (unexpectedError: unknown) {
    logError("review", "The report pipeline failed.", unexpectedError);
    await markReportFailed(
      state,
      "Something went wrong while generating the report: "
      + String(unexpectedError)
      + " Your video and your Playwright script are unaffected.",
    );
  } finally {
    isGenerating = false;
    generateButton.disabled = false;
    generateNoVideoButton.disabled = false;
    regenerateButton.disabled = false;
  }
}

/**
 * Decides whether the consent dialog has to be shown before the first upload.
 *
 * The rules, in order:
 *   - "Never upload video" in settings wins over everything.
 *   - No video stored means nothing to consent to.
 *   - Consent already given for this installation means go ahead.
 *   - Otherwise, ask, and let the tester choose "without video" instead.
 */
async function startGenerationWithConsent(): Promise<void> {
  if (loaded === null) {
    return;
  }
  const currentSettings: ExtensionSettings = await readSettings();
  settings = currentSettings;

  if (currentSettings.neverUploadVideo || loaded.media === null) {
    await runReportGeneration(false);
    return;
  }

  if (currentSettings.videoUploadConsentGiven) {
    await runReportGeneration(true);
    return;
  }

  consentCheckbox.checked = false;
  consentWithVideo.disabled = true;
  consentDialog.showModal();
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Wires every button on the page. */
function installHandlers(): void {
  settingsButton.addEventListener("click", function onSettings(): void {
    void chrome.runtime.openOptionsPage();
  });

  openSettingsButton.addEventListener("click", function onOpenSettings(): void {
    void chrome.runtime.openOptionsPage();
  });

  deleteButton.addEventListener("click", function onDelete(): void {
    if (loaded === null) {
      return;
    }
    const confirmed: boolean = window.confirm(
      "Delete this session, including its video, its generated script and its "
      + "report?\n\nThis cannot be undone.");
    if (!confirmed) {
      return;
    }
    const sessionId: string = loaded.session.id;
    deleteSession(sessionId)
      .then(function afterDelete(): void {
        window.close();
      })
      .catch(function onDeleteError(deleteError: unknown): void {
        showPageError("Could not delete the session: " + String(deleteError));
      });
  });

  downloadVideoButton.addEventListener("click", function onDownloadVideo(): void {
    if (loaded === null || loaded.media === null) {
      return;
    }
    const extension: string =
      loaded.media.mimeType.includes("mp4") ? "mp4" : "webm";
    const url: string = URL.createObjectURL(loaded.media.blob);
    const link: HTMLAnchorElement = document.createElement("a");
    link.href = url;
    link.download = "qa-session." + extension;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(function revoke(): void {
      URL.revokeObjectURL(url);
    }, 10000);
  });

  deleteVideoButton.addEventListener("click", function onDeleteVideo(): void {
    if (loaded === null) {
      return;
    }
    const confirmed: boolean = window.confirm(
      "Delete only the video, keeping the report and the script?\n\n"
      + "The video is by far the largest part of a session on disk.");
    if (!confirmed) {
      return;
    }
    const state: LoadedSession = loaded;
    deleteMediaForSession(state.session.id)
      .then(async function afterDelete(freedBytes: number): Promise<void> {
        await updateSession(state.session.id, {
          media: {
            ...state.session.media,
            mediaId: "",
            sizeBytes: 0,
            state: "failed",
            failureReason: "The tester deleted the video to free "
              + formatBytes(freedBytes) + ".",
          },
        });
        window.location.reload();
      })
      .catch(function onDeleteError(deleteError: unknown): void {
        showPageError("Could not delete the video: " + String(deleteError));
      });
  });

  generateButton.addEventListener("click", function onGenerate(): void {
    void startGenerationWithConsent();
  });

  generateNoVideoButton.addEventListener("click", function onGenerateNoVideo(): void {
    void runReportGeneration(false);
  });

  regenerateButton.addEventListener("click", function onRegenerate(): void {
    void startGenerationWithConsent();
  });

  reportText.addEventListener("change", function onReportEdited(): void {
    if (loaded === null) {
      return;
    }
    void updateSession(loaded.session.id, { editedReportText: reportText.value });
  });

  copyReportButton.addEventListener("click", function onCopyReport(): void {
    void copyToClipboard(reportText.value, "Report");
  });

  copyReportFullButton.addEventListener("click", function onCopyFull(): void {
    if (loaded === null || loaded.session.bugReport === null) {
      void copyToClipboard(reportText.value, "Report");
      return;
    }
    const videoWasAnalysed: boolean =
      loaded.session.lastVideoDeliveryMode !== "omitted";
    void copyToClipboard(
      formatReportWithMetadata(
        loaded.session.bugReport,
        loaded.session.name,
        videoWasAnalysed,
      ),
      "Report with metadata",
    );
  });

  copyScriptButton.addEventListener("click", function onCopyScript(): void {
    if (loaded === null) {
      return;
    }
    void copyToClipboard(loaded.session.playwrightScript, "Script");
  });

  downloadScriptButton.addEventListener("click", function onDownloadScript(): void {
    if (loaded === null) {
      return;
    }
    downloadTextFile(
      buildSpecFileName(loaded.session),
      loaded.session.playwrightScript,
      "text/typescript",
    );
  });

  consentCheckbox.addEventListener("change", function onConsentChange(): void {
    consentWithVideo.disabled = !consentCheckbox.checked;
  });

  consentWithVideo.addEventListener("click", function onConsentYes(): void {
    consentDialog.close();
    void writeSettings({ videoUploadConsentGiven: true }).then(
      function afterConsent(): void {
        if (loaded !== null) {
          void updateSession(loaded.session.id, { videoUploadConsentGiven: true });
        }
        void runReportGeneration(true);
      },
    );
  });

  consentWithoutVideo.addEventListener("click", function onConsentNo(): void {
    consentDialog.close();
    void runReportGeneration(false);
  });

  consentCancel.addEventListener("click", function onConsentCancel(): void {
    consentDialog.close();
    reportActions.hidden = false;
    reportStatusText.textContent =
      "No report generated yet. Your video and your Playwright script are ready.";
  });

  window.addEventListener("beforeunload", function onUnload(): void {
    if (videoObjectUrl !== "") {
      URL.revokeObjectURL(videoObjectUrl);
    }
  });
}

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

/**
 * Loads the session, renders every local artifact, and only then decides
 * whether to attempt the AI step.
 */
async function initialiseReviewPage(): Promise<void> {
  installHandlers();

  const sessionId: string = readSessionIdFromUrl();
  if (sessionId === "") {
    showPageError("No session was specified in the page address.");
    sessionNameHeading.textContent = "No session";
    return;
  }

  const state: LoadedSession | null = await loadSession(sessionId);
  if (state === null) {
    showPageError("That session no longer exists. It may have been deleted.");
    sessionNameHeading.textContent = "Session not found";
    return;
  }
  loaded = state;

  // STEP 1-3 of the invariant: everything local, before any network thought.
  await ensureScriptGenerated(state);
  renderHeader(state);
  renderVideo(state);
  renderStepList(state);
  renderScript(state);

  const currentSettings: ExtensionSettings = await readSettings();
  settings = currentSettings;

  // An already-generated report is shown straight away, with no new call.
  if (state.session.bugReport !== null) {
    renderReport(
      state,
      state.session.bugReport,
      state.session.lastVideoDeliveryMode !== "omitted",
    );
    renderRedactionSummary(state.session.redactionSummary);
    return;
  }

  if (currentSettings.geminiApiKey.trim() === "") {
    setupPanel.hidden = false;
    reportStatusText.textContent =
      "No API key is set, so no report was generated. Your video and your "
      + "Playwright script are ready.";
    reportActions.hidden = false;
    return;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    reportStatusText.textContent =
      "You are offline. The session is saved — press Generate report when you "
      + "are back online.";
    reportActions.hidden = false;
    return;
  }

  // STEP 4: only now.
  await startGenerationWithConsent();
}

initialiseReviewPage().catch(function onInitError(initError: unknown): void {
  logWarning("review", "The review page failed to start.", initError);
  showPageError("The review page failed to start: " + String(initError));
});
