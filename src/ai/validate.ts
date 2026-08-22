// =============================================================================
// src/ai/validate.ts
// A schema constrains SHAPE. It does not stop a model returning an empty string
// for every field, or setting a flag that contradicts the text next to it.
// This file checks MEANING.
// =============================================================================

import type { GeneratedBugReport } from "../shared/types";
import { NOT_DETERMINABLE_SENTENCE } from "../shared/constants";

/**
 * Canonicalises a sentence for comparison: unify dashes, collapse whitespace,
 * drop a trailing full stop, lower-case.
 *
 * WHY not just compare the strings: the required sentence contains an em dash,
 * and a model that emits a hyphen or an en dash instead is not wrong about the
 * defect. Failing the whole report over a dash - twice, after a retry - would
 * turn the most common Expected Behavior outcome into the most common failure.
 */
function canonicaliseSentence(value: string): string {
  let result: string = value.trim().toLowerCase();
  result = result.split("\u2014").join("-");   // em dash
  result = result.split("\u2013").join("-");   // en dash
  result = result.split("\u2212").join("-");   // minus sign
  result = result.replace(/\s+/g, " ");
  while (result.endsWith(".")) {
    result = result.slice(0, result.length - 1);
  }
  return result;
}

/**
 * True when a value says the same thing as the required sentence.
 */
export function isNotDeterminableSentence(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return canonicaliseSentence(value)
    === canonicaliseSentence(NOT_DETERMINABLE_SENTENCE);
}

/**
 * Rewrites the sentence to the canonical form when it matches loosely.
 *
 * The extension owns the template, so downstream consumers still see the exact
 * agreed wording; the model is simply not punished for a dash.
 */
export function normaliseExpectedBehavior(report: GeneratedBugReport): GeneratedBugReport {
  if (report.expectedBehaviorDeterminable === true) {
    return report;
  }
  if (report.expectedBehavior === NOT_DETERMINABLE_SENTENCE) {
    return report;
  }
  if (!isNotDeterminableSentence(report.expectedBehavior)) {
    return report;
  }
  return { ...report, expectedBehavior: NOT_DETERMINABLE_SENTENCE };
}

export interface ValidationResult {
  isValid: boolean;
  problems: string[];
}

/** True when a value is a non-empty, non-whitespace string. */
function isNonEmptyString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value.trim().length > 0;
}

/** True when a value is an array of strings (possibly empty). */
function isStringArray(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index = index + 1) {
    if (typeof value[index] !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Validates a parsed model response before we show it to a tester.
 *
 * WHY it returns a list of problems rather than a boolean: the problems are
 * shown in the UI when validation fails twice, so the tester can see exactly
 * what the model got wrong instead of a generic error.
 */
export function validateBugReport(candidate: unknown): ValidationResult {
  const problems: string[] = [];

  if (typeof candidate !== "object" || candidate === null) {
    return { isValid: false, problems: ["The response was not a JSON object."] };
  }

  const report = candidate as Partial<GeneratedBugReport>;

  if (!isNonEmptyString(report.title)) {
    problems.push("title is missing or empty.");
  }
  if (!isNonEmptyString(report.description)) {
    problems.push("description is missing or empty.");
  }
  if (!isNonEmptyString(report.precondition)) {
    problems.push("precondition is missing or empty.");
  }
  if (!isNonEmptyString(report.currentBehavior)) {
    problems.push("currentBehavior is missing or empty.");
  }
  if (!isNonEmptyString(report.expectedBehavior)) {
    problems.push("expectedBehavior is missing or empty.");
  }

  if (!isStringArray(report.stepsToReproduce)) {
    problems.push("stepsToReproduce is not an array of strings.");
  } else {
    const steps = report.stepsToReproduce as string[];
    if (steps.length < 1) {
      problems.push("stepsToReproduce must contain at least one step.");
    }
    for (let index = 0; index < steps.length; index = index + 1) {
      if (!isNonEmptyString(steps[index])) {
        problems.push(
          "stepsToReproduce contains an empty step at position "
          + String(index + 1) + ".");
      }
    }
  }

  const allowedSeverities: string[] = ["blocker", "major", "minor", "cosmetic"];
  if (typeof report.severityGuess !== "string"
      || !allowedSeverities.includes(report.severityGuess)) {
    problems.push("severityGuess is missing or not one of the allowed values.");
  }

  const allowedDefectTypes: string[] =
    ["ui", "functional", "api", "content", "performance", "unknown"];
  if (typeof report.defectType !== "string"
      || !allowedDefectTypes.includes(report.defectType)) {
    problems.push("defectType is missing or not one of the allowed values.");
  }

  const allowedConfidence: string[] = ["high", "medium", "low"];
  if (typeof report.confidence !== "string"
      || !allowedConfidence.includes(report.confidence)) {
    problems.push("confidence is missing or not one of the allowed values.");
  }

  if (typeof report.expectedBehaviorDeterminable !== "boolean") {
    problems.push("expectedBehaviorDeterminable is missing or not a boolean.");
  }

  // Consistency: the flag and the sentence must agree.
  //
  // WHY this is enforced: the UI shows a different banner in each case, and a
  // model that sets the flag to false but writes a made-up expectation anyway
  // is exactly the failure this whole design is trying to prevent.
  if (report.expectedBehaviorDeterminable === false
      && !isNotDeterminableSentence(report.expectedBehavior)) {
    problems.push(
      "expectedBehaviorDeterminable is false but expectedBehavior is not the "
      + "exact required sentence.");
  }
  if (report.expectedBehaviorDeterminable === true
      && isNotDeterminableSentence(report.expectedBehavior)) {
    problems.push(
      "expectedBehaviorDeterminable is true but expectedBehavior is the "
      + "not-determinable sentence.");
  }

  if (typeof report.evidenceUsed !== "object" || report.evidenceUsed === null) {
    problems.push("evidenceUsed is missing.");
  } else {
    const evidence = report.evidenceUsed;
    if (typeof evidence.video !== "boolean"
        || typeof evidence.playwrightScript !== "boolean"
        || typeof evidence.pageCode !== "boolean"
        || typeof evidence.networkOrConsole !== "boolean") {
      problems.push("evidenceUsed must have four boolean flags.");
    }
  }

  if (!isStringArray(report.supportingEvidence)) {
    problems.push("supportingEvidence is not an array of strings.");
  }
  if (!isStringArray(report.unverifiedClaims)) {
    problems.push("unverifiedClaims is not an array of strings.");
  }
  if (!isStringArray(report.secondaryIssues)) {
    problems.push("secondaryIssues is not an array of strings.");
  }

  return { isValid: problems.length === 0, problems: problems };
}

/**
 * Cross-checks the model's evidenceUsed claim against what we actually sent.
 *
 * WHY: a model that claims it watched a video we never sent has hallucinated,
 * and that is worth surfacing loudly rather than trusting the rest of the
 * report. We correct the flag, push a warning the UI displays, and drop the
 * confidence.
 */
export function reconcileEvidenceUsed(
  report: GeneratedBugReport,
  videoWasSent: boolean,
  networkOrConsoleWasSent: boolean,
  pageCodeWasSent: boolean,
): GeneratedBugReport {
  const corrected: GeneratedBugReport = {
    ...report,
    unverifiedClaims: [...report.unverifiedClaims],
    evidenceUsed: { ...report.evidenceUsed },
  };

  if (report.evidenceUsed.video && !videoWasSent) {
    corrected.evidenceUsed.video = false;
    corrected.unverifiedClaims.push(
      "The AI reported that it analysed the video, but no video was sent with "
      + "this request. Treat any statement about timing or appearance with "
      + "suspicion.");
    corrected.confidence = "low";
  }

  if (report.evidenceUsed.networkOrConsole && !networkOrConsoleWasSent) {
    corrected.evidenceUsed.networkOrConsole = false;
    corrected.unverifiedClaims.push(
      "The AI reported that it used network or console evidence, but none was "
      + "recorded for this session.");
  }

  if (report.evidenceUsed.pageCode && !pageCodeWasSent) {
    corrected.evidenceUsed.pageCode = false;
    corrected.unverifiedClaims.push(
      "The AI reported that it used the page code, but no page code was "
      + "captured for this session. Any quoted on-screen text is unverified.");
    corrected.confidence = "low";
  }

  return corrected;
}
