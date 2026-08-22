// =============================================================================
// src/ai/bundle.ts
// Assembles everything the model will see. Nothing outside the returned object
// reaches Google.
//
// THE REDACTION GATE IS CALLED FROM HERE. If it throws, this function throws,
// and no API call is ever made. The caller must not catch-and-continue.
// =============================================================================

import type {
  AIEvidenceBundle,
  ActionTraceStep,
  BundledDomSnapshot,
  BundledElementContext,
  RecordingSession,
  RecordedEvent,
  DomSnapshot,
  ElementContext,
  NetworkEntry,
  ConsoleEntry,
  PageMeta,
  ReportLanguage,
} from "../shared/types";
import { redactSensitiveData } from "./redact";
import { prepareVideoForAI } from "./video";
import { formatVideoTimestamp } from "../shared/time";
import {
  MAX_SNAPSHOTS_IN_BUNDLE,
  MAX_ELEMENT_CONTEXTS_IN_BUNDLE,
  MAX_ACTION_TRACE_STEPS,
  MAX_SNAPSHOT_CHARACTERS,
  ESTIMATED_CHARACTERS_PER_TOKEN,
  ESTIMATED_VIDEO_TOKENS_PER_SECOND,
  ESTIMATED_TOKENS_PER_KEY_FRAME,
  FAILURE_ATTRIBUTION_WINDOW_MS,
} from "../shared/constants";

/**
 * Describes an element in words a QA engineer would use.
 *
 * WHY not just the selector: the model must write steps a non-technical tester
 * can follow, and 'div[role="rowgroup"] > div:nth-of-type(3)' is not that.
 */
export function describeElementForModel(event: RecordedEvent): string {
  if (event.locator === null) {
    return "the page";
  }

  const parts: string[] = [];
  if (event.locator.accessibleName !== "") {
    parts.push('"' + event.locator.accessibleName + '"');
  } else if (event.locator.visibleText !== "") {
    parts.push('"' + event.locator.visibleText + '"');
  }

  if (event.locator.ariaRole !== "") {
    parts.push("(role=" + event.locator.ariaRole + ")");
  } else {
    parts.push("(<" + event.locator.tagName + ">)");
  }

  if (parts.length === 1) {
    return "an unnamed " + parts[0];
  }
  return parts.join(" ");
}

/**
 * Converts recorded events into the ordered, human-readable action trace.
 */
function buildActionTrace(events: RecordedEvent[]): ActionTraceStep[] {
  const steps: ActionTraceStep[] = [];
  for (let index = 0; index < events.length; index = index + 1) {
    const event: RecordedEvent = events[index];
    steps.push({
      stepNumber: index + 1,
      actionType: event.type,
      elementDescription: describeElementForModel(event),
      inputValue: event.value,
      wasRedacted: event.valueWasRedacted,
      pageUrl: event.pageUrl,
      wallClockMs: event.wallClockMs,
      videoTimestamp: formatVideoTimestamp(event.videoOffsetMs),
      videoOffsetMs: event.videoOffsetMs,
    });
  }
  return steps;
}

/**
 * Writes, in plain English, why a snapshot moment mattered.
 *
 * WHY the extension writes this and not the model: the extension KNOWS why it
 * took the snapshot. Letting the model guess would be inventing evidence.
 */
function describeSnapshotSignificance(snapshot: DomSnapshot): string {
  if (snapshot.trigger === "first-load") {
    return "The page as it first loaded, before the tester did anything.";
  }
  if (snapshot.trigger === "navigation") {
    return "The page immediately after a full navigation to " + snapshot.pageUrl + ".";
  }
  if (snapshot.trigger === "url-change") {
    return "The page after an in-app route change to " + snapshot.pageUrl + ".";
  }
  if (snapshot.trigger === "console-error") {
    return "The page at the moment a JavaScript error was logged to the console.";
  }
  if (snapshot.trigger === "network-failure") {
    return "The page at the moment a network request failed.";
  }
  if (snapshot.trigger === "session-stop") {
    return "The final state of the page when the tester stopped recording.";
  }
  return "The page at the moment the tester interacted with it (step "
    + String(snapshot.eventIndex + 1) + ").";
}

/**
 * Picks which snapshots to send when there are more than the budget allows.
 *
 * Rule: always keep anything triggered by a failure, always keep the first and
 * the last, then fill remaining slots with the most recent.
 */
export function selectSnapshotsForBundle(snapshots: DomSnapshot[]): DomSnapshot[] {
  if (snapshots.length <= MAX_SNAPSHOTS_IN_BUNDLE) {
    return snapshots;
  }

  const selected: DomSnapshot[] = [];
  const alreadySelected: Set<string> = new Set<string>();

  function selectSnapshot(snapshot: DomSnapshot): void {
    if (alreadySelected.has(snapshot.id)) {
      return;
    }
    if (selected.length >= MAX_SNAPSHOTS_IN_BUNDLE) {
      return;
    }
    selected.push(snapshot);
    alreadySelected.add(snapshot.id);
  }

  // Failure-triggered snapshots have absolute priority: they are the evidence.
  for (let index = 0; index < snapshots.length; index = index + 1) {
    const snapshot: DomSnapshot = snapshots[index];
    if (snapshot.trigger === "console-error" || snapshot.trigger === "network-failure") {
      selectSnapshot(snapshot);
    }
  }

  selectSnapshot(snapshots[0]);
  selectSnapshot(snapshots[snapshots.length - 1]);

  // Fill remaining slots from the end backwards (most recent first).
  for (let index = snapshots.length - 1; index >= 0; index = index - 1) {
    selectSnapshot(snapshots[index]);
  }

  // Restore chronological order: the model needs it to reason about sequence.
  selected.sort(function compareByTime(left: DomSnapshot, right: DomSnapshot): number {
    return left.wallClockMs - right.wallClockMs;
  });
  return selected;
}

/**
 * Hard-enforces the per-snapshot character budget.
 *
 * Belt and braces: pruneDomForAI already respects it, but a bug upstream must
 * not be able to blow the request size.
 */
export function enforceSnapshotCharacterBudget(html: string): string {
  if (html.length <= MAX_SNAPSHOT_CHARACTERS) {
    return html;
  }
  return html.slice(0, MAX_SNAPSHOT_CHARACTERS)
    + "\n<!-- SNAPSHOT TRUNCATED AT BUDGET -->";
}

/**
 * Picks which element contexts to send: everything near a failure first, then
 * the most recent interactions.
 */
export function selectElementContextsForBundle(
  contexts: ElementContext[],
  failureEventIndexes: number[],
): ElementContext[] {
  if (contexts.length <= MAX_ELEMENT_CONTEXTS_IN_BUNDLE) {
    return contexts;
  }

  const selected: ElementContext[] = [];
  const alreadySelected: Set<string> = new Set<string>();

  function selectContext(context: ElementContext): void {
    if (alreadySelected.has(context.id)) {
      return;
    }
    if (selected.length >= MAX_ELEMENT_CONTEXTS_IN_BUNDLE) {
      return;
    }
    selected.push(context);
    alreadySelected.add(context.id);
  }

  for (let failureIndex = 0; failureIndex < failureEventIndexes.length;
       failureIndex = failureIndex + 1) {
    const centre: number = failureEventIndexes[failureIndex];
    for (let index = 0; index < contexts.length; index = index + 1) {
      if (Math.abs(contexts[index].eventIndex - centre) <= 3) {
        selectContext(contexts[index]);
      }
    }
  }

  for (let index = contexts.length - 1; index >= 0; index = index - 1) {
    selectContext(contexts[index]);
  }

  selected.sort(function compareByEventIndex(
    left: ElementContext,
    right: ElementContext,
  ): number {
    return left.eventIndex - right.eventIndex;
  });
  return selected;
}

/**
 * Truncates a long action trace from the MIDDLE, never from the ends.
 *
 * WHY the middle: the beginning establishes the precondition and the end is
 * where the defect appeared. The forty clicks in between are the expendable
 * part, and the model is told explicitly that a gap exists so it does not
 * narrate across it.
 */
export function truncateActionTrace(
  steps: ActionTraceStep[],
  truncationNotes: string[],
): ActionTraceStep[] {
  if (steps.length <= MAX_ACTION_TRACE_STEPS) {
    return steps;
  }

  const keepFromStart: number = Math.floor(MAX_ACTION_TRACE_STEPS / 2);
  const keepFromEnd: number = MAX_ACTION_TRACE_STEPS - keepFromStart;
  const droppedCount: number = steps.length - MAX_ACTION_TRACE_STEPS;

  const result: ActionTraceStep[] = [];
  for (let index = 0; index < keepFromStart; index = index + 1) {
    result.push(steps[index]);
  }
  for (let index = steps.length - keepFromEnd; index < steps.length; index = index + 1) {
    result.push(steps[index]);
  }

  truncationNotes.push(
    "The action trace was too long to send in full. Steps "
    + String(keepFromStart + 1) + " to " + String(keepFromStart + droppedCount)
    + " (" + String(droppedCount) + " steps) were omitted from the middle. "
    + "Do not assume anything about what happened during the omitted steps.");

  return result;
}

/**
 * Guesses the environment from the hostname.
 * Used only to fill the Precondition field; the model is told it is metadata.
 */
export function detectEnvironment(url: string): string {
  const lowerUrl: string = url.toLowerCase();
  if (lowerUrl.includes("localhost") || lowerUrl.includes("127.0.0.1")
      || lowerUrl.includes("0.0.0.0")) {
    return "local";
  }
  if (lowerUrl.includes("staging") || lowerUrl.includes("stg.")
      || lowerUrl.includes("uat") || lowerUrl.includes("test.")
      || lowerUrl.includes("qa.")) {
    return "staging";
  }
  if (lowerUrl.includes("dev.") || lowerUrl.includes("develop")) {
    return "development";
  }
  if (lowerUrl === "") {
    return "unknown";
  }
  return "unknown";
}

/**
 * Finds the event indexes that a failure happened near.
 * Used to prioritise which evidence survives truncation.
 */
export function findFailureEventIndexes(
  events: RecordedEvent[],
  networkFailures: NetworkEntry[],
  consoleErrors: ConsoleEntry[],
): number[] {
  const indexes: number[] = [];

  for (let index = 0; index < events.length; index = index + 1) {
    const event: RecordedEvent = events[index];
    let isNearFailure: boolean = false;

    for (let failureIndex = 0; failureIndex < networkFailures.length;
         failureIndex = failureIndex + 1) {
      const delta: number =
        Math.abs(networkFailures[failureIndex].startedAtMs - event.wallClockMs);
      if (delta < FAILURE_ATTRIBUTION_WINDOW_MS) {
        isNearFailure = true;
        break;
      }
    }

    if (!isNearFailure) {
      for (let errorIndex = 0; errorIndex < consoleErrors.length;
           errorIndex = errorIndex + 1) {
        const delta: number =
          Math.abs(consoleErrors[errorIndex].wallClockMs - event.wallClockMs);
        if (delta < FAILURE_ATTRIBUTION_WINDOW_MS) {
          isNearFailure = true;
          break;
        }
      }
    }

    if (isNearFailure) {
      indexes.push(index);
    }
  }

  return indexes;
}

/**
 * Rough token estimate. Explicitly an ESTIMATE, used only to warn the tester
 * before an expensive call and to decide whether to truncate further.
 *
 * VERIFY the video token rate against the pricing documentation. And note that
 * ARABIC TEXT TOKENISES CONSIDERABLY WORSE than English — closer to two
 * characters per token than four — so this underestimates Arabic-heavy pages.
 */
export function estimateInputTokens(bundle: AIEvidenceBundle): number {
  let textCharacters: number = 0;
  textCharacters = textCharacters + bundle.playwrightScript.length;
  textCharacters = textCharacters + JSON.stringify(bundle.actionTrace).length;
  textCharacters = textCharacters + JSON.stringify(bundle.networkFailures).length;
  textCharacters = textCharacters + JSON.stringify(bundle.consoleErrors).length;

  for (let index = 0; index < bundle.domSnapshots.length; index = index + 1) {
    textCharacters = textCharacters + bundle.domSnapshots[index].prunedHtml.length;
  }

  for (let index = 0; index < bundle.elementContext.length; index = index + 1) {
    const context: BundledElementContext = bundle.elementContext[index];
    textCharacters = textCharacters
      + context.elementHtml.length
      + context.ancestorHtml.length
      + context.siblingHtml.join("").length;
  }

  const textTokens: number =
    Math.ceil(textCharacters / ESTIMATED_CHARACTERS_PER_TOKEN);

  let videoTokens: number = 0;
  if (bundle.video.deliveryMode === "files-api-uri"
      || bundle.video.deliveryMode === "inline-base64") {
    videoTokens = Math.ceil(bundle.video.durationMs / 1000)
      * ESTIMATED_VIDEO_TOKENS_PER_SECOND;
  } else if (bundle.video.deliveryMode === "key-frames") {
    videoTokens = bundle.video.keyFrameBase64.length * ESTIMATED_TOKENS_PER_KEY_FRAME;
  }

  return textTokens + videoTokens;
}

export interface BuildBundleInput {
  session: RecordingSession;
  events: RecordedEvent[];
  snapshots: DomSnapshot[];
  contexts: ElementContext[];
  networkEntries: NetworkEntry[];
  consoleEntries: ConsoleEntry[];
  videoBlob: Blob | null;
  reportLanguage: ReportLanguage;
  /** False when the tester declined consent or the global switch forbids it. */
  allowVideoUpload: boolean;
  /** User-supplied redaction patterns from the options page. */
  customRedactionPatterns: readonly string[];
}

/**
 * Assembles the complete evidence bundle after a session stops.
 */
export async function buildEvidenceBundle(
  input: BuildBundleInput,
): Promise<AIEvidenceBundle> {
  const truncationNotes: string[] = [];

  // --- Failures first: they drive every selection decision below. -----------
  const networkFailures: NetworkEntry[] = [];
  for (let index = 0; index < input.networkEntries.length; index = index + 1) {
    if (input.networkEntries[index].isFailure) {
      networkFailures.push(input.networkEntries[index]);
    }
  }

  const consoleErrors: ConsoleEntry[] = [];
  for (let index = 0; index < input.consoleEntries.length; index = index + 1) {
    const entry: ConsoleEntry = input.consoleEntries[index];
    if (entry.level === "error" || entry.level === "unhandled-rejection") {
      consoleErrors.push(entry);
    }
  }

  const failureEventIndexes: number[] =
    findFailureEventIndexes(input.events, networkFailures, consoleErrors);

  // --- Action trace --------------------------------------------------------
  let actionTrace: ActionTraceStep[] = buildActionTrace(input.events);
  actionTrace = truncateActionTrace(actionTrace, truncationNotes);

  // --- DOM snapshots -------------------------------------------------------
  const chosenSnapshots: DomSnapshot[] = selectSnapshotsForBundle(input.snapshots);
  const bundledSnapshots: BundledDomSnapshot[] = [];
  for (let index = 0; index < chosenSnapshots.length; index = index + 1) {
    const snapshot: DomSnapshot = chosenSnapshots[index];
    bundledSnapshots.push({
      snapshotId: snapshot.id,
      trigger: snapshot.trigger,
      significanceReason: describeSnapshotSignificance(snapshot),
      videoTimestamp: formatVideoTimestamp(snapshot.videoOffsetMs),
      pageUrl: snapshot.pageUrl,
      documentLang: snapshot.documentLang,
      documentDir: snapshot.documentDir,
      prunedHtml: enforceSnapshotCharacterBudget(snapshot.prunedHtml),
      wasTruncated: snapshot.wasTruncated,
    });
  }
  if (input.snapshots.length > chosenSnapshots.length) {
    truncationNotes.push(
      String(input.snapshots.length - chosenSnapshots.length)
      + " additional page snapshots were captured but not sent, to stay inside "
      + "the size budget.");
  }

  // --- Element contexts ----------------------------------------------------
  const chosenContexts: ElementContext[] =
    selectElementContextsForBundle(input.contexts, failureEventIndexes);
  const bundledContexts: BundledElementContext[] = [];

  for (let index = 0; index < chosenContexts.length; index = index + 1) {
    const context: ElementContext = chosenContexts[index];
    let description: string = "step " + String(context.eventIndex + 1);
    let timestamp: string = "--:--";

    for (let eventIndex = 0; eventIndex < input.events.length;
         eventIndex = eventIndex + 1) {
      if (input.events[eventIndex].index === context.eventIndex) {
        description = describeElementForModel(input.events[eventIndex]);
        timestamp = formatVideoTimestamp(input.events[eventIndex].videoOffsetMs);
        break;
      }
    }

    bundledContexts.push({
      stepNumber: context.eventIndex + 1,
      elementDescription: description,
      videoTimestamp: timestamp,
      elementHtml: context.elementHtml,
      ancestorHtml: context.ancestorHtml,
      siblingHtml: context.siblingHtml,
      computedStyles: context.computedStyles,
      ariaState: context.ariaState,
      inheritedLang: context.inheritedLang,
      inheritedDir: context.inheritedDir,
    });
  }
  if (input.contexts.length > chosenContexts.length) {
    truncationNotes.push(
      String(input.contexts.length - chosenContexts.length)
      + " additional interacted-element contexts were captured but not sent, to "
      + "stay inside the size budget.");
  }

  // --- Page metadata -------------------------------------------------------
  let documentLang: string = "";
  let documentDir: string = "";
  let viewportWidth: number = 0;
  let viewportHeight: number = 0;

  if (input.snapshots.length > 0) {
    const lastSnapshot: DomSnapshot = input.snapshots[input.snapshots.length - 1];
    documentLang = lastSnapshot.documentLang;
    documentDir = lastSnapshot.documentDir;
    viewportWidth = lastSnapshot.viewportWidth;
    viewportHeight = lastSnapshot.viewportHeight;
  }

  const finalUrl: string =
    input.session.visitedUrls.length > 0
      ? input.session.visitedUrls[input.session.visitedUrls.length - 1]
      : input.session.originUrl;

  const pageMeta: PageMeta = {
    title: input.session.originTitle,
    url: finalUrl,
    documentLang: documentLang,
    documentDir: documentDir,
    viewportWidth: viewportWidth,
    viewportHeight: viewportHeight,
    detectedEnvironment: detectEnvironment(input.session.originUrl),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  };

  // --- Video ---------------------------------------------------------------
  const preparedVideo = await prepareVideoForAI(
    input.videoBlob,
    input.session.media,
    input.events,
    failureEventIndexes,
    input.allowVideoUpload,
  );

  // --- Assemble, then run the gate. ---------------------------------------
  const draftBundle: AIEvidenceBundle = {
    sessionId: input.session.id,
    reportLanguage: input.reportLanguage,
    actionTrace: actionTrace,
    playwrightScript: input.session.playwrightScript,
    domSnapshots: bundledSnapshots,
    elementContext: bundledContexts,
    networkFailures: networkFailures,
    consoleErrors: consoleErrors,
    video: preparedVideo,
    pageMeta: pageMeta,
    redactionCompleted: false,
    redactionSummary: {},
    truncationNotes: truncationNotes,
    estimatedInputTokens: 0,
  };

  // THE GATE. Throws on failure; the caller must NOT catch-and-continue.
  const redactedBundle: AIEvidenceBundle =
    redactSensitiveData(draftBundle, input.customRedactionPatterns);

  redactedBundle.estimatedInputTokens = estimateInputTokens(redactedBundle);
  return redactedBundle;
}
