// =============================================================================
// src/report/local-report.ts
//
// The free report. Written by this file, not by a model.
//
// WHAT IT IS: the same six-field template, filled in from what was recorded -
// the action trace, the network failures, the console errors, the page titles.
// Every sentence in it restates something the recording observed.
//
// WHAT IT IS NOT: an analysis. It cannot say WHY something went wrong, it
// cannot tell a defect from intended behaviour, and it will not guess. Where
// the AI report reasons, this one describes. That difference is the product's
// paid tier, and the report says so on its face rather than letting a reader
// assume they are looking at the same thing.
//
// WHY IT IS WORTH SHIPPING ANYWAY: most of the half hour a tester spends
// writing a bug report is transcription - the exact steps, the exact values,
// the exact URL, the timestamps. This does all of that in a few milliseconds,
// offline, for free. What is left is the judgement, which is the part they were
// always better at than any transcript.
// =============================================================================

import type {
  ActionTraceStep,
  ConsoleEntry,
  GeneratedBugReport,
  NetworkEntry,
  RecordingSession,
} from "../shared/types";
import { NOT_DETERMINABLE_SENTENCE } from "../shared/constants";

/** Everything the local generator needs. There is no network call. */
export interface LocalReportInput {
  session: RecordingSession;
  actionTrace: ActionTraceStep[];
  networkFailures: NetworkEntry[];
  consoleErrors: ConsoleEntry[];
}

/** Wraps a value in quotes, shortening a long one rather than dropping it. */
export function quoteValue(value: string): string {
  const trimmed: string = value.trim();
  if (trimmed === "") {
    return "an empty value";
  }
  if (trimmed.length <= 60) {
    return '"' + trimmed + '"';
  }
  return '"' + trimmed.slice(0, 57) + '..."';
}

/**
 * Turns one recorded step into the sentence a tester would have typed.
 *
 * WHY each action type gets its own wording rather than a generic "clicked
 * element": a bug report is read by someone who was not there, and "Typed
 * TN-40192 into the Tenant field" tells them something that "input event on
 * input#tenant" does not.
 */
export function describeStepInWords(step: ActionTraceStep): string {
  const element: string = step.elementDescription.trim();
  const where: string = element === "" ? "" : " on " + element;

  if (step.actionType === "navigate") {
    return "Opened " + step.pageUrl;
  }
  if (step.actionType === "reload") {
    return "Reloaded the page";
  }
  if (step.actionType === "url-change") {
    return "The page changed to " + step.pageUrl;
  }
  if (step.actionType === "click") {
    return "Clicked" + where;
  }
  if (step.actionType === "dblclick") {
    return "Double-clicked" + where;
  }
  if (step.actionType === "right-click") {
    return "Right-clicked" + where;
  }
  if (step.actionType === "middle-click") {
    return "Middle-clicked" + where;
  }
  if (step.actionType === "input") {
    if (step.wasRedacted) {
      return "Typed a hidden value" + where;
    }
    return "Typed " + quoteValue(step.inputValue) + where;
  }
  if (step.actionType === "paste") {
    if (step.wasRedacted) {
      return "Pasted a hidden value" + where;
    }
    return "Pasted " + quoteValue(step.inputValue) + where;
  }
  if (step.actionType === "copy") {
    return "Copied " + quoteValue(step.inputValue) + where;
  }
  if (step.actionType === "cut") {
    return "Cut " + quoteValue(step.inputValue) + where;
  }
  if (step.actionType === "select-option") {
    return "Selected " + quoteValue(step.inputValue) + where;
  }
  if (step.actionType === "check") {
    return "Ticked" + where;
  }
  if (step.actionType === "uncheck") {
    return "Unticked" + where;
  }
  if (step.actionType === "press-key") {
    return "Pressed " + step.inputValue + where;
  }
  if (step.actionType === "drag-drop") {
    return "Dragged" + where;
  }
  if (step.actionType === "hover") {
    return "Hovered" + where;
  }
  if (step.actionType === "scroll") {
    return "Scrolled the page";
  }
  if (step.actionType === "tab-activated") {
    return "Switched browser tabs";
  }
  if (step.actionType === "tester-note") {
    return "Note from the tester: " + step.inputValue;
  }

  return step.actionType.replace("-", " ") + where;
}

/**
 * The steps a reader needs, with the noise left out.
 *
 * WHY pointer movement and hovers are dropped here but kept in the recording:
 * they are evidence for someone investigating and clutter for someone
 * reproducing. A numbered list is an instruction to follow, and "moved the
 * pointer" is not an instruction.
 */
export function buildStepsInWords(trace: ActionTraceStep[]): string[] {
  const steps: string[] = [];

  for (let index = 0; index < trace.length; index = index + 1) {
    const step: ActionTraceStep = trace[index];
    if (step.actionType === "mouse-path" || step.actionType === "hover") {
      continue;
    }
    if (step.actionType === "session-start" || step.actionType === "session-stop") {
      continue;
    }
    steps.push(describeStepInWords(step));
  }

  return steps;
}

/** Path and query only, so a sentence stays readable. */
export function shortenUrl(url: string): string {
  try {
    const parsed: URL = new URL(url);
    return parsed.pathname + parsed.search;
  } catch (parseError: unknown) {
    return url;
  }
}

/**
 * What the recording OBSERVED going wrong, in the application own words.
 *
 * This is as close to analysis as this file gets, and it is not analysis: a 500
 * is a fact the network layer recorded and a console error is a string the page
 * printed. Neither is interpreted.
 */
export function describeObservedFailures(
  networkFailures: NetworkEntry[],
  consoleErrors: ConsoleEntry[],
): string {
  const parts: string[] = [];

  for (let index = 0; index < networkFailures.length && index < 5; index = index + 1) {
    const failure: NetworkEntry = networkFailures[index];
    parts.push(
      failure.method + " " + shortenUrl(failure.url) + " returned "
      + String(failure.statusCode));
  }

  for (let index = 0; index < consoleErrors.length && index < 5; index = index + 1) {
    parts.push("the page logged: " + consoleErrors[index].message.slice(0, 160));
  }

  if (parts.length === 0) {
    return "";
  }

  return parts.join("; ");
}

/** "2-minute 53-second", in words a sentence can use. */
export function describeDuration(durationMs: number): string {
  const totalSeconds: number = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return String(totalSeconds) + "-second";
  }

  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (seconds === 0) {
    return String(minutes) + "-minute";
  }
  return String(minutes) + "-minute " + String(seconds) + "-second";
}

/** Timestamps and codes a reader can act on. */
function buildSupportingEvidence(input: LocalReportInput): string[] {
  const evidence: string[] = [];

  for (let index = 0; index < input.networkFailures.length && index < 8;
       index = index + 1) {
    const failure: NetworkEntry = input.networkFailures[index];
    evidence.push(
      failure.method + " " + shortenUrl(failure.url) + " -> "
      + String(failure.statusCode));
  }

  for (let index = 0; index < input.consoleErrors.length && index < 8;
       index = index + 1) {
    evidence.push("console: " + input.consoleErrors[index].message.slice(0, 120));
  }

  return evidence;
}

/**
 * Builds the free report.
 *
 * Deterministic, offline, and honest about being a transcript. Every field is
 * either an observation or an explicit statement that the observation is not
 * available.
 */
export function buildLocalReport(input: LocalReportInput): GeneratedBugReport {
  const steps: string[] = buildStepsInWords(input.actionTrace);
  const failureText: string =
    describeObservedFailures(input.networkFailures, input.consoleErrors);

  const pageName: string =
    input.session.originTitle.trim() === ""
      ? "the application"
      : input.session.originTitle.trim();

  // The title names what was RECORDED, not what is wrong - because this
  // generator does not know what is wrong, and a title that guesses is the
  // fastest way to have the whole report distrusted.
  let title: string = "Recorded session on " + pageName;
  if (failureText !== "") {
    title = "Failure during a recorded session on " + pageName;
  }

  const description: string =
    "A " + describeDuration(input.session.recordedDurationMs)
    + " session was recorded on " + pageName + ", covering "
    + String(steps.length) + " steps."
    + (failureText === ""
      ? " No failed requests or console errors were captured."
      : " The recording captured: " + failureText + ".");

  const currentBehavior: string =
    failureText === ""
      ? "The recording shows the steps above being carried out. No failed "
        + "request or console error was captured, so what is wrong is visible "
        + "in the video rather than in the technical evidence."
      : "During those steps the application produced: " + failureText + ".";

  const expected: string =
    input.session.testerExpectedResult.trim() === ""
      ? NOT_DETERMINABLE_SENTENCE
      : input.session.testerExpectedResult.trim() + " (stated by the tester)";

  return {
    title: title,
    description: description,
    precondition:
      "Signed in as the tester was, starting at " + input.session.originUrl + ".",
    stepsToReproduce: steps,
    currentBehavior: currentBehavior,
    expectedBehavior: expected,
    expectedBehaviorDeterminable:
      input.session.testerExpectedResult.trim() !== "",
    // "minor" rather than a guess dressed up as one. This generator cannot
    // judge severity - it does not know what the application was for - and the
    // banner says the whole report is a transcript, so a reader who takes this
    // field seriously has been warned twice.
    severityGuess: "minor",
    defectType: "unknown",
    evidenceUsed: {
      video: false,
      pageCode: false,
      playwrightScript: false,
      networkOrConsole:
        input.networkFailures.length > 0 || input.consoleErrors.length > 0,
    },
    supportingEvidence: buildSupportingEvidence(input),
    unverifiedClaims: [],
    secondaryIssues: [],
    confidence: "low",
  };
}

/**
 * The line that keeps the free report from being mistaken for the paid one.
 *
 * WHY it is not a footnote: the two reports use the same six headings, and a
 * reader who does not know which one they have will read a transcript as an
 * analysis. Saying so at the top costs one line and prevents someone acting on
 * a judgement that nothing made.
 */
export const LOCAL_REPORT_BANNER: string =
  "[Written by the extension from the recording, not by AI. It transcribes what "
  + "was observed; it does not diagnose. The AI report reads the page code and "
  + "the video and explains what went wrong.]";
