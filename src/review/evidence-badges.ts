// =============================================================================
// src/review/evidence-badges.ts
// Renders the anti-hallucination channel: which evidence the model actually
// used, what it inferred rather than observed, and how confident it was.
//
// This is not decoration. The whole design rests on the tester being able to
// tell at a glance whether they are looking at a report grounded in captured
// code or a plausible story. That distinction is the difference between a tool
// that saves 28 minutes and a tool that costs the team credibility.
// =============================================================================

import type { GeneratedBugReport, EvidenceUsed } from "../shared/types";

/** One badge definition: the label, the flag, and what it contributes. */
interface BadgeDefinition {
  label: string;
  isUsed: boolean;
  tooltip: string;
}

/**
 * Builds the four evidence badges from the model's own claim.
 *
 * @param videoWasActuallySent Whether we sent any visual evidence at all. The
 *        badge is greyed out when we did not, even if the model claimed
 *        otherwise — reconcileEvidenceUsed() already corrected the flag, and
 *        this keeps the UI honest if that ever fails.
 */
function buildBadgeDefinitions(
  evidenceUsed: EvidenceUsed,
  videoWasActuallySent: boolean,
): BadgeDefinition[] {
  return [
    {
      label: "Video",
      isUsed: evidenceUsed.video && videoWasActuallySent,
      tooltip:
        "The session video answers what the tester saw go wrong and when. It is "
        + "the only source for timing, animation and layout problems.",
    },
    {
      label: "Script",
      isUsed: evidenceUsed.playwrightScript,
      tooltip:
        "The generated Playwright script answers what exact sequence of actions "
        + "led to the problem. Steps to Reproduce come from here.",
    },
    {
      label: "Page code",
      isUsed: evidenceUsed.pageCode,
      tooltip:
        "The captured HTML answers what is actually rendered. It is the only "
        + "acceptable source for exact on-screen strings.",
    },
    {
      label: "Network / console",
      isUsed: evidenceUsed.networkOrConsole,
      tooltip:
        "Failed requests and console errors. Present only when the session "
        + "recorded some.",
    },
  ];
}

/**
 * Renders the evidence badges into a container.
 */
export function renderEvidenceBadges(
  container: HTMLElement,
  report: GeneratedBugReport,
  videoWasActuallySent: boolean,
): void {
  container.replaceChildren();

  const definitions: BadgeDefinition[] =
    buildBadgeDefinitions(report.evidenceUsed, videoWasActuallySent);

  for (let index = 0; index < definitions.length; index = index + 1) {
    const definition: BadgeDefinition = definitions[index];
    const badge: HTMLSpanElement = document.createElement("span");
    badge.className = definition.isUsed ? "badge badge-on" : "badge badge-off";
    badge.title = definition.tooltip;
    badge.textContent =
      (definition.isUsed ? "✓ " : "— ") + definition.label;
    container.append(badge);
  }

  const confidenceChip: HTMLSpanElement = document.createElement("span");
  confidenceChip.className = "badge confidence-" + report.confidence;
  confidenceChip.title =
    "How confident the model says it is in this report, given the evidence it "
    + "was given.";
  confidenceChip.textContent = "Confidence: " + report.confidence;
  container.append(confidenceChip);
}

/**
 * Renders the amber warning banner listing everything the model inferred rather
 * than observed. Hides the banner when there is nothing to warn about.
 */
export function renderUnverifiedClaims(
  banner: HTMLElement,
  list: HTMLElement,
  report: GeneratedBugReport,
): void {
  list.replaceChildren();

  if (report.unverifiedClaims.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  for (let index = 0; index < report.unverifiedClaims.length; index = index + 1) {
    const item: HTMLLIElement = document.createElement("li");
    item.textContent = report.unverifiedClaims[index];
    list.append(item);
  }
}

/**
 * Renders the "why the AI says this" list.
 */
export function renderSupportingEvidence(
  container: HTMLElement,
  list: HTMLElement,
  report: GeneratedBugReport,
): void {
  list.replaceChildren();

  if (report.supportingEvidence.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (let index = 0; index < report.supportingEvidence.length; index = index + 1) {
    const item: HTMLLIElement = document.createElement("li");
    item.textContent = report.supportingEvidence[index];
    list.append(item);
  }
}

/**
 * Renders the secondary issues the model noticed but deliberately did not make
 * the subject of this report.
 */
export function renderSecondaryIssues(
  container: HTMLElement,
  list: HTMLElement,
  report: GeneratedBugReport,
): void {
  list.replaceChildren();

  if (report.secondaryIssues.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (let index = 0; index < report.secondaryIssues.length; index = index + 1) {
    const item: HTMLLIElement = document.createElement("li");
    item.textContent = report.secondaryIssues[index];
    list.append(item);
  }
}
