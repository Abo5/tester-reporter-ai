// =============================================================================
// src/ai/prompt.ts
// The EXACT instruction text sent to the model, as one constant, so that
// auditing what we ask the AI to do is a single-file review.
// =============================================================================

import type { AIEvidenceBundle, ReportLanguage } from "../shared/types";
import { NOT_DETERMINABLE_SENTENCE } from "../shared/constants";

/**
 * The system instruction.
 *
 * VERIFY: the exact field name for a system instruction in the current API. If
 * the field does not exist for this model, prepend this text as the first user
 * part instead — the wording does not change.
 */
export const SYSTEM_INSTRUCTION: string = [
  "You are a senior QA engineer at a software company in Saudi Arabia. You write defect",
  "reports for a bilingual web application that ships in both English and Arabic. Your",
  "reports are read by developers who will fix the defect and by a QA lead who will",
  "verify it. You are precise, factual and brief. You never speculate.",
  "",
  "You are given the complete evidence from one recorded manual test session and you must",
  "determine what the defect is from that evidence alone.",
  "",
  "=== THE THREE KINDS OF EVIDENCE, AND WHAT EACH ONE IS FOR ===",
  "",
  "1. THE SESSION VIDEO answers: what did the tester SEE go wrong, and WHEN. It is your",
  "   only source for timing, animation, layout, flicker, things that appeared and",
  "   disappeared, and things that never rendered at all. It may also contain the tester's",
  "   spoken narration, which often states the problem directly - listen to it.",
  "   The video is a compressed recording. Do NOT read exact text off the video.",
  "",
  "2. THE PLAYWRIGHT SCRIPT and THE ACTION TRACE answer: what exact sequence of actions",
  "   led to the problem. These are a literal recording of what the tester did, already",
  "   cleaned up and ordered. Use them as your source for Steps to Reproduce.",
  "",
  "3. THE PAGE CODE (pruned HTML snapshots and per-element context) answers: what is",
  "   actually rendered, and why it is wrong. It contains the real text content, the real",
  "   attributes, the real disabled / invalid / expanded states, and the real lang and dir",
  "   values. This is your ONLY acceptable source for exact strings.",
  "",
  "=== PRECEDENCE RULES WHEN SOURCES DISAGREE ===",
  "",
  "- For exact strings - labels, error messages, field values, status codes - THE PAGE",
  "  CODE IS THE SOURCE OF TRUTH. Quote it character for character. Never transcribe text",
  "  from a video frame when the same text is present in the page code. Never 'correct'",
  "  the page code to match what you think you see in the video.",
  "- For timing, ordering, visual appearance and layout defects - THE VIDEO IS THE SOURCE",
  "  OF TRUTH, because a page snapshot is a still image and cannot show movement.",
  "- For what the tester did - THE SCRIPT AND ACTION TRACE ARE THE SOURCE OF TRUTH.",
  "- If two sources genuinely contradict each other, that contradiction is itself",
  "  evidence. Report the defect from the higher-precedence source and record the",
  "  contradiction in the unverifiedClaims field. Do not silently pick one.",
  "",
  "=== HARD RULES ===",
  "",
  "- Use ONLY the evidence provided in this request. You have no other knowledge of this",
  "  application.",
  "- NEVER invent a step, a typed value, an HTTP status code, a selector, an error",
  "  message, an element name, or an expected behaviour. If it is not in the evidence, it",
  "  does not exist.",
  "- Where the evidence shows [REDACTED:something], a real value was present but was",
  "  removed for security before you saw it. Treat it as 'a value was entered'. Do not",
  "  guess it, and do not mention the redaction marker in the report body.",
  "- Where a note says steps or content were omitted, do NOT narrate across the gap.",
  "- An element carrying data-qa-hidden=\"true\" was present in the DOM but NOT visible on",
  "  screen at that moment. That distinction is frequently the defect itself.",
  "- Report AT MOST ONE primary defect. If you can see several independent defects, choose",
  "  the most severe one as the subject of the report and list the others briefly, one",
  "  short sentence each, in the secondaryIssues field.",
  "- If the evidence shows no defect at all, say so in the title and description, set",
  "  confidence to 'low', and put your reasoning in unverifiedClaims. Do not manufacture a",
  "  defect to fill the template.",
  "",
  "=== HOW TO WRITE STEPS TO REPRODUCE ===",
  "",
  "Derive the steps from the Playwright script and the action trace, then rewrite them as",
  "instructions a non-technical tester can follow. Specifically:",
  "",
  "- Merge low-level actions into meaningful ones. Four keystrokes and a key press become",
  "  one step: 'Enter the tenant ID in the search field and press Enter.'",
  "- Use the visible label of a control, never a CSS selector, an XPath, or a variable",
  "  name. Write 'click the Contract Renewal & Continuation tab', not 'click",
  "  div[role=\"rowgroup\"] > div:nth-of-type(3)'.",
  "- Start from a state a reader can reach: the opening step should name the page and the",
  "  environment.",
  "- Keep it to the steps that actually matter for reproducing the defect. Do not",
  "  transcribe every recorded event.",
  "- Aim for 3 to 8 steps.",
  "",
  "=== HOW TO WRITE CURRENT BEHAVIOR ===",
  "",
  "State what actually happens, and QUOTE the exact strings from the page code inside",
  "double quotes. If the defect is about wording, list every affected string as it",
  "literally appears in the captured HTML. If the defect is about an API failure, quote",
  "the method, the path and the status code exactly as recorded. Never paraphrase",
  "on-screen text.",
  "",
  "=== HOW TO WRITE EXPECTED BEHAVIOR ===",
  "",
  "Expected behaviour must be derivable from the evidence - for example from an error",
  "message that states a rule, from a validation constraint visible in the HTML, from the",
  "application's own behaviour elsewhere in the recording, or from the tester's spoken",
  "narration in the video.",
  "",
  "If you cannot derive it from the evidence, you MUST set expectedBehaviorDeterminable to",
  "false and set expectedBehavior to EXACTLY this string, with no additions:",
  "",
  NOT_DETERMINABLE_SENTENCE,
  "",
  "Do not invent a specification. Do not write what you assume a well-designed",
  "application would do. An invented expectation is worse than an absent one.",
  "",
  "=== ANTI-HALLUCINATION FIELDS - THESE ARE NOT OPTIONAL ===",
  "",
  "- evidenceUsed: set each flag to true only if you actually used that evidence type. If",
  "  no video was provided, video MUST be false.",
  "- supportingEvidence: short, checkable pointers to the specific evidence behind your",
  "  conclusion. Examples: 'console error at 00:42: TypeError: cannot read property id of",
  "  undefined', 'GET /api/contracts/TN-40192 returned 500', 'snapshot at 00:15 shows",
  "  aria-invalid=\"true\" on the tenant field'.",
  "- unverifiedClaims: every statement in your report that you INFERRED rather than",
  "  directly observed, and every contradiction between sources. If everything in your",
  "  report is directly observed, return an empty array. Do not pad this field, and do not",
  "  leave it empty just to look confident.",
  "",
  "=== OUTPUT ===",
  "",
  "Return ONLY the JSON object matching the provided schema. No preamble, no explanation,",
  "no markdown fences, no commentary before or after.",
].join("\n");

/**
 * Builds the language instruction.
 *
 * Kept separate from the long constant so the report language never has to be
 * interpolated into it, and so the Arabic path is auditable on its own.
 */
export function buildLanguageInstruction(language: ReportLanguage): string {
  if (language === "ar") {
    return [
      "=== REPORT LANGUAGE ===",
      "Write every field of the report in ARABIC (Modern Standard Arabic, as used in",
      "professional Saudi software documentation).",
      "EXCEPTION: strings you quote from the page code, URLs, HTTP methods, status codes,",
      "and technical identifiers must be reproduced EXACTLY as captured, in their original",
      "script and characters. Never translate a quoted string.",
    ].join("\n");
  }
  return [
    "=== REPORT LANGUAGE ===",
    "Write every field of the report in ENGLISH.",
    "EXCEPTION: strings you quote from the page code must be reproduced EXACTLY as",
    "captured. If a captured string is in Arabic, quote the Arabic and do not translate",
    "it; you may add a short English gloss in parentheses after it.",
  ].join("\n");
}

/**
 * Serialises the evidence bundle into the text part of the request.
 *
 * WHY explicit section headers instead of one big JSON blob: the model is being
 * asked to apply different precedence rules to different evidence types, and
 * clearly delimited sections make that instruction actionable rather than
 * aspirational.
 */
export function buildEvidenceText(bundle: AIEvidenceBundle): string {
  const sections: string[] = [];

  sections.push(buildLanguageInstruction(bundle.reportLanguage));
  sections.push("");
  sections.push("=== PAGE METADATA ===");
  sections.push(JSON.stringify(bundle.pageMeta, null, 2));

  if (bundle.truncationNotes.length > 0) {
    sections.push("");
    sections.push("=== IMPORTANT: GAPS IN THE EVIDENCE ===");
    for (let index = 0; index < bundle.truncationNotes.length; index = index + 1) {
      sections.push("- " + bundle.truncationNotes[index]);
    }
  }

  sections.push("");
  sections.push("=== VIDEO STATUS ===");
  if (bundle.video.deliveryMode === "omitted") {
    sections.push(
      "NO VIDEO WAS PROVIDED with this request. " + bundle.video.downgradeReason);
    sections.push("You MUST set evidenceUsed.video to false.");
  } else if (bundle.video.deliveryMode === "key-frames") {
    sections.push("The full video could not be sent. " + bundle.video.downgradeReason);
    const secondsList: string[] = [];
    for (let index = 0; index < bundle.video.keyFrameOffsetsMs.length;
         index = index + 1) {
      secondsList.push(
        String(Math.round(bundle.video.keyFrameOffsetsMs[index] / 1000)));
    }
    sections.push(
      "You were given " + String(bundle.video.keyFrameBase64.length)
      + " still frames instead, at these video timestamps in seconds: "
      + secondsList.join(", "));
    sections.push(
      "Still frames cannot show timing or motion. Do not claim anything about timing "
      + "from them, and record any such inference in unverifiedClaims.");
  } else {
    sections.push(
      "The full session video is attached. Its duration is "
      + String(Math.round(bundle.video.durationMs / 1000)) + " seconds. Video "
      + "timestamps in the action trace below are positions in this video, in MM:SS.");
  }

  sections.push("");
  sections.push("=== ACTION TRACE (what the tester did, in order) ===");
  sections.push(JSON.stringify(bundle.actionTrace, null, 2));

  sections.push("");
  sections.push("=== GENERATED PLAYWRIGHT SCRIPT ===");
  if (bundle.playwrightScript === "") {
    sections.push("No script was generated for this session.");
  } else {
    sections.push(bundle.playwrightScript);
  }

  sections.push("");
  sections.push("=== PAGE CODE: FULL-PAGE SNAPSHOTS ===");
  if (bundle.domSnapshots.length === 0) {
    sections.push("No page code was captured for this session. You MUST set "
      + "evidenceUsed.pageCode to false and you MUST NOT quote any on-screen text.");
  } else {
    sections.push(
      "These are pruned HTML snapshots. Attributes and text are real and verbatim; "
      + "scripts, styles, inline SVG path data and framework noise were removed.");
    for (let index = 0; index < bundle.domSnapshots.length; index = index + 1) {
      const snapshot = bundle.domSnapshots[index];
      sections.push("");
      sections.push(
        "--- SNAPSHOT " + String(index + 1) + " at video "
        + snapshot.videoTimestamp + " ---");
      sections.push("Why this moment matters: " + snapshot.significanceReason);
      sections.push("URL: " + snapshot.pageUrl);
      sections.push(
        'Document lang="' + snapshot.documentLang + '" dir="'
        + snapshot.documentDir + '"');
      if (snapshot.wasTruncated) {
        sections.push("NOTE: this snapshot hit the size budget and is incomplete.");
      }
      sections.push(snapshot.prunedHtml);
    }
  }

  sections.push("");
  sections.push("=== PAGE CODE: INTERACTED ELEMENTS IN CONTEXT ===");
  if (bundle.elementContext.length === 0) {
    sections.push("None were captured.");
  } else {
    for (let index = 0; index < bundle.elementContext.length; index = index + 1) {
      const context = bundle.elementContext[index];
      sections.push("");
      sections.push(
        "--- STEP " + String(context.stepNumber) + " at video "
        + context.videoTimestamp + ": " + context.elementDescription + " ---");
      sections.push("Element HTML: " + context.elementHtml);
      sections.push("Containing element: " + context.ancestorHtml);
      if (context.siblingHtml.length > 0) {
        sections.push("Neighbouring elements: " + context.siblingHtml.join(" | "));
      }
      sections.push("Computed styles: " + JSON.stringify(context.computedStyles));
      sections.push("ARIA and form state: " + JSON.stringify(context.ariaState));
      sections.push(
        'Inherited lang="' + context.inheritedLang + '" dir="'
        + context.inheritedDir + '"');
    }
  }

  sections.push("");
  sections.push("=== FAILED NETWORK REQUESTS ===");
  if (bundle.networkFailures.length === 0) {
    sections.push("None were recorded.");
  } else {
    sections.push(JSON.stringify(bundle.networkFailures, null, 2));
  }

  sections.push("");
  sections.push("=== CONSOLE ERRORS ===");
  if (bundle.consoleErrors.length === 0) {
    sections.push("None were recorded.");
  } else {
    sections.push(JSON.stringify(bundle.consoleErrors, null, 2));
  }

  sections.push("");
  sections.push("Now produce the defect report as JSON matching the schema.");

  return sections.join("\n");
}
