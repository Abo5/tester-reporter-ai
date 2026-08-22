// =============================================================================
// src/shared/sensitive-fields.ts
// ONE vocabulary for "does this field hold something that must not be kept".
//
// WHY this file exists: there used to be two lists. The content script had a
// literal substring list, and the redaction gate had a broader set of patterns.
// A field in the gap between them - "API Key", "Account Number", "Verification
// Code" - passed the capture-time check, so the raw value was written to
// IndexedDB, and only the gate caught it later. The stated contract is that
// such a value never reaches disk at all.
//
// Two lists that must agree will eventually disagree. This is the one list.
// =============================================================================

/** A named rule. The name becomes the marker, so it must stay human-readable. */
export interface SensitiveFieldRule {
  name: string;
  pattern: RegExp;
}

/**
 * Field-name patterns. If a field's NAME, id, label, placeholder or
 * autocomplete hint matches, its value is replaced whatever the value looks
 * like. This is the reliable half of redaction: the value-shape patterns in
 * ai/redact.ts are the other half, and neither is sufficient alone.
 */
export const SENSITIVE_FIELD_NAME_PATTERNS: readonly SensitiveFieldRule[] = [
  { name: "password", pattern: /pass(word|wd|code|phrase)?|\bpwd\b/i },
  {
    name: "otp",
    pattern: /\botp\b|one.?time|verification.?code|auth.?code|\bpin\b|security.?code/i,
  },
  { name: "cvv", pattern: /\bcvv\b|\bcvc\b|card.?security/i },
  {
    name: "card",
    pattern: /card.?(number|no)\b|\bpan\b|credit.?card|\bcardnumber\b/i,
  },
  { name: "iban", pattern: /\biban\b|account.?number|\bswift\b|\bbic\b/i },
  {
    name: "national-id",
    pattern: /national.?id|\bnin\b|\bssn\b|iqama|\bnid\b|identity.?number/i,
  },
  {
    name: "token",
    pattern: /token|api.?key|secret|bearer|private.?key|credential/i,
  },
];

/**
 * Returns the rule a field description matches, or null.
 *
 * @param identifyingText Everything that names the field - its name, id,
 *        label, placeholder, autocomplete hint, or the surrounding markup -
 *        joined into one string by the caller.
 */
export function findSensitiveFieldRule(
  identifyingText: string,
): SensitiveFieldRule | null {
  if (identifyingText === "") {
    return null;
  }
  for (let index = 0; index < SENSITIVE_FIELD_NAME_PATTERNS.length;
       index = index + 1) {
    const rule: SensitiveFieldRule = SENSITIVE_FIELD_NAME_PATTERNS[index];
    // A fresh RegExp each time: a shared object with the /g flag would carry
    // lastIndex between calls and skip matches.
    const pattern: RegExp = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (pattern.test(identifyingText)) {
      return rule;
    }
  }
  return null;
}
