// =============================================================================
// src/ai/format.ts
// GeneratedBugReport -> the exact fixed plain-text template, ready to paste.
//
// The model returns DATA. The extension owns the LAYOUT. That separation means
// the template can change without touching the prompt, and the model can never
// break the formatting.
// =============================================================================

import type { GeneratedBugReport } from "../shared/types";

/**
 * Renders the report in the team's fixed template.
 *
 * Field order and field names are FIXED and must not be reordered: the QA lead
 * reads these reports in this order, and downstream tooling may key off them.
 */
export function formatReportAsPlainText(report: GeneratedBugReport): string {
  const lines: string[] = [];

  lines.push("Title: " + report.title.trim());
  lines.push("Description: " + report.description.trim());
  lines.push("Precondition: " + report.precondition.trim());
  lines.push("Steps to Reproduce:");

  for (let index = 0; index < report.stepsToReproduce.length; index = index + 1) {
    lines.push(String(index + 1) + ". " + report.stepsToReproduce[index].trim());
  }

  lines.push("Current Behavior: " + report.currentBehavior.trim());
  lines.push("Expected Behavior: " + report.expectedBehavior.trim());

  return lines.join("\n");
}

/**
 * The report with the tester's own Expected Behavior in place of the model's.
 *
 * WHAT: returns the same six-field template, with Expected Behavior replaced
 * when the tester has written one, and marked as theirs.
 *
 * WHY the attribution is not optional: the model is REQUIRED to write "not
 * determinable from the recording" when the evidence cannot establish what
 * should have happened, and that honesty is the point of the whole pipeline.
 * Silently overwriting it with a human sentence would erase the distinction
 * between what was observed and what someone believes. The tag keeps both.
 */
export function formatReportWithTesterExpectation(
  report: GeneratedBugReport,
  testerExpectedResult: string,
): string {
  const baseText: string = formatReportAsPlainText(report);
  const trimmed: string = testerExpectedResult.trim();

  if (trimmed === "") {
    return baseText;
  }

  const lines: string[] = baseText.split("\n");
  for (let index = 0; index < lines.length; index = index + 1) {
    if (lines[index].startsWith("Expected Behavior: ")) {
      lines[index] = "Expected Behavior: " + trimmed + " (stated by the tester)";
    }
  }

  return lines.join("\n");
}

/**
 * Renders the fixed template PLUS the metadata a tester may want to paste too.
 *
 * Kept separate from formatReportAsPlainText() so the fixed six-field template
 * stays byte-exact for anyone who only wants that.
 */
export function formatReportWithMetadata(
  report: GeneratedBugReport,
  sessionName: string,
  videoWasAnalysed: boolean,
): string {
  const lines: string[] = [];

  lines.push(formatReportAsPlainText(report));
  lines.push("");
  lines.push("---");
  lines.push("Severity (AI suggestion): " + report.severityGuess);
  lines.push("Defect type (AI suggestion): " + report.defectType);
  lines.push("AI confidence: " + report.confidence);
  lines.push("Recorded session: " + sessionName);

  const evidenceParts: string[] = [];
  if (report.evidenceUsed.video && videoWasAnalysed) {
    evidenceParts.push("session video");
  }
  if (report.evidenceUsed.playwrightScript) {
    evidenceParts.push("recorded action script");
  }
  if (report.evidenceUsed.pageCode) {
    evidenceParts.push("captured page code");
  }
  if (report.evidenceUsed.networkOrConsole) {
    evidenceParts.push("network and console logs");
  }

  if (evidenceParts.length === 0) {
    lines.push("Evidence analysed: none recorded");
  } else {
    lines.push("Evidence analysed: " + evidenceParts.join(", "));
  }

  if (!videoWasAnalysed) {
    lines.push("NOTE: the session video was NOT analysed by the AI for this report.");
  }

  if (report.supportingEvidence.length > 0) {
    lines.push("");
    lines.push("Supporting evidence:");
    for (let index = 0; index < report.supportingEvidence.length; index = index + 1) {
      lines.push("- " + report.supportingEvidence[index]);
    }
  }

  if (report.unverifiedClaims.length > 0) {
    lines.push("");
    lines.push("UNVERIFIED - inferred by the AI, not directly observed:");
    for (let index = 0; index < report.unverifiedClaims.length; index = index + 1) {
      lines.push("- " + report.unverifiedClaims[index]);
    }
  }

  if (report.secondaryIssues.length > 0) {
    lines.push("");
    lines.push("Other issues noticed (file separately):");
    for (let index = 0; index < report.secondaryIssues.length; index = index + 1) {
      lines.push("- " + report.secondaryIssues[index]);
    }
  }

  return lines.join("\n");
}
