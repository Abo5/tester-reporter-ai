// =============================================================================
// src/ai/schema.ts
// The JSON schema sent to the API, kept structurally identical to the
// GeneratedBugReport interface in shared/types.ts.
//
// If you change one, change the other in the same commit. There is a test in
// tests/ that asserts the property names match.
// =============================================================================

import { NOT_DETERMINABLE_SENTENCE } from "../shared/constants";

/**
 * The response schema.
 *
 * CONFIRMED against the live API: `required`, `enum` and nested `object` types
 * are all honoured for schema-constrained output, including on requests that
 * carry video.
 *
 * validate.ts still matters regardless: a schema constrains SHAPE, not MEANING.
 * It cannot stop a model returning an empty string for every field, or setting
 * a flag that contradicts the sentence beside it.
 */
export const BUG_REPORT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "One sentence stating what is wrong and where.",
    },
    description: {
      type: "string",
      description:
        "Two to four sentences describing the defect factually. No speculation.",
    },
    precondition: {
      type: "string",
      description:
        "Login state, environment, language, and any data or design reference "
        + "needed to reproduce.",
    },
    stepsToReproduce: {
      type: "array",
      items: { type: "string" },
      description:
        "Human-readable steps derived from the action trace and the script. No "
        + "code, no selectors. Between 3 and 8 entries is typical.",
    },
    currentBehavior: {
      type: "string",
      description:
        "What actually happens, quoting exact strings from the page code.",
    },
    expectedBehavior: {
      type: "string",
      description:
        "What should happen. If it cannot be derived from the evidence, this "
        + "must be exactly: " + NOT_DETERMINABLE_SENTENCE,
    },
    expectedBehaviorDeterminable: {
      type: "boolean",
      description:
        "False when expectedBehavior is the not-determinable sentence.",
    },
    severityGuess: {
      type: "string",
      enum: ["blocker", "major", "minor", "cosmetic"],
    },
    defectType: {
      type: "string",
      enum: ["ui", "functional", "api", "content", "performance", "unknown"],
    },
    evidenceUsed: {
      type: "object",
      properties: {
        video: { type: "boolean" },
        playwrightScript: { type: "boolean" },
        pageCode: { type: "boolean" },
        networkOrConsole: { type: "boolean" },
      },
      required: ["video", "playwrightScript", "pageCode", "networkOrConsole"],
    },
    supportingEvidence: {
      type: "array",
      items: { type: "string" },
      description:
        "Short checkable pointers, for example 'console error at 00:42' or "
        + "'GET /api/contracts/TN-40192 returned 500'.",
    },
    unverifiedClaims: {
      type: "array",
      items: { type: "string" },
      description:
        "Everything inferred rather than directly observed, plus any "
        + "contradiction between evidence sources. Empty array if none.",
    },
    secondaryIssues: {
      type: "array",
      items: { type: "string" },
      description:
        "Other defects noticed but not reported as the primary one.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
  },
  required: [
    "title",
    "description",
    "precondition",
    "stepsToReproduce",
    "currentBehavior",
    "expectedBehavior",
    "expectedBehaviorDeterminable",
    "severityGuess",
    "defectType",
    "evidenceUsed",
    "supportingEvidence",
    "unverifiedClaims",
    "secondaryIssues",
    "confidence",
  ],
};

/**
 * The property names the schema declares, for the consistency test.
 */
export function schemaPropertyNames(): string[] {
  const properties = BUG_REPORT_RESPONSE_SCHEMA["properties"] as Record<string, unknown>;
  return Object.keys(properties);
}
