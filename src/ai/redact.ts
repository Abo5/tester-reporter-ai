// =============================================================================
// src/ai/redact.ts
// THE GATE. Nothing reaches Google without passing through here.
//
// Two rules define this file:
//
//  1. Redaction failure BLOCKS the API call. redactSensitiveData() throws and
//     the caller does not catch it. There is no "degraded mode" in which a
//     possibly-unredacted bundle gets sent because redaction had a bad day.
//
//  2. Redaction REPLACES, it never deletes. A password becomes
//     [REDACTED:password], not an empty string, because "the tester submitted
//     the form with a password" and "the tester submitted an empty form" are
//     different bug reports.
//
// It runs over ALL THREE text surfaces: the action trace, the page code, and
// the generated Playwright script. The script is the easiest to forget and the
// most dangerous, because it contains fill() calls with literal typed values.
// =============================================================================

import {
  findSensitiveFieldRule,
  type SensitiveFieldRule,
} from "../shared/sensitive-fields";
import type {
  AIEvidenceBundle,
  ActionTraceStep,
  BundledDomSnapshot,
  BundledElementContext,
  NetworkEntry,
  ConsoleEntry,
  PageMeta,
} from "../shared/types";

/**
 * One named redaction rule. Named so the marker tells the model what was hidden.
 *
 * `keepLabel` is for rules that match "<label>: <secret>" and must preserve the
 * label. Knowing that a password was on screen is useful evidence; knowing what
 * it was is a liability.
 */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  keepLabel?: boolean;
}

/**
 * Value patterns: applied to every text value regardless of field name.
 *
 * WHY both halves exist: a field called "reference" may still contain a card
 * number, and a field called "password" may contain something that looks like
 * ordinary text.
 *
 * These are tuned for Saudi and Gulf data shapes. They WILL over-match
 * occasionally — a 10-digit order number starting with 1 is redacted as a
 * national id. Over-matching is the correct direction to fail in, and the
 * marker still tells the model that a value was present.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RedactionRule[] = [
  // JWTs. Checked before the generic digit runs so the marker is accurate.
  { name: "token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g },
  // Google-style API keys.
  { name: "api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  // Bearer tokens anywhere in text.
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // IBANs: two letters, two check digits, then 11-30 alphanumerics.
  { name: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  // Payment card shapes: 13-19 digits, optionally space or dash separated.
  { name: "card", pattern: /\b(?:\d[ -]?){12,18}\d\b/g },
  // Saudi national id / Iqama: 10 digits starting 1 or 2.
  { name: "national-id", pattern: /\b[12]\d{9}\b/g },
  // Email addresses. Debatable in general; staging data is often real.
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A secret written out as labelled text, which is how staging environments
  // advertise their own test credentials: "Password : admin123", "API key = ...".
  // The label is kept; only the value after it is removed.
  {
    // Everything before the value is captured in group 1 and preserved, so the
    // label survives and only the secret goes.
    //
    // Two shapes broke the first version of this rule, and both are the ones
    // that matter most:
    //
    //   {"password":"admin123"}   - a quote sits between the label and the
    //                               colon, and another before the value
    //   #access_token=ya29...     - \btoken\b does not match inside
    //                               access_token, because _ is a word character
    //
    // A login request body and an OAuth callback are precisely where a real
    // secret shows up, so missing both made the rule close to decorative.
    name: "labelled-secret",
    keepLabel: true,
    pattern: new RegExp(
      "([\"'\\[]?\\b(?:"
      + "(?:access|refresh|id|auth|bearer|api|session|csrf|xsrf|private)"
      + "[ _-]?(?:token|key|secret)"
      + "|pass(?:word|wd|code|phrase)?|pwd|secret|token|otp|pin|cvv|cvc"
      + ")\\b[\"']?\\s*[:=]\\s*[\"']?)"
      + "([^\\s<>\"'`,;&\\]}]{3,200})",
      "gi",
    ),
  },
];

/** Attributes in captured HTML whose values must be scrubbed. */
const SENSITIVE_HTML_ATTRIBUTES: readonly string[] = [
  "value", "data-value", "placeholder",
];

/** Query-string parameter names that must be scrubbed out of URLs. */
const SENSITIVE_URL_PARAMETERS: readonly string[] = [
  "token", "access_token", "id_token", "refresh_token", "api_key", "apikey",
  "key", "password", "secret", "code", "auth", "signature", "sig", "session",
];

/** Request headers that must never be forwarded, even if somehow collected. */
const FORBIDDEN_HEADERS: readonly string[] = [
  "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
  "proxy-authorization",
];

/** Accumulates a count per rule name so the tester can see what was caught. */
export type RedactionCounter = Record<string, number>;

/** Increments the counter for one rule. */
function countRedaction(counter: RedactionCounter, ruleName: string): void {
  if (counter[ruleName] === undefined) {
    counter[ruleName] = 0;
  }
  counter[ruleName] = counter[ruleName] + 1;
}

/**
 * Applies every value pattern to a string, replacing matches with markers.
 *
 * @param extraPatterns User-supplied regex sources from the options page.
 */
export function redactValuePatterns(
  text: string,
  counter: RedactionCounter,
  extraPatterns: readonly RedactionRule[],
): string {
  if (text === "") {
    return "";
  }

  let result: string = text;

  const allRules: RedactionRule[] = [];
  for (let index = 0; index < SENSITIVE_VALUE_PATTERNS.length; index = index + 1) {
    allRules.push(SENSITIVE_VALUE_PATTERNS[index]);
  }
  for (let index = 0; index < extraPatterns.length; index = index + 1) {
    allRules.push(extraPatterns[index]);
  }

  for (let index = 0; index < allRules.length; index = index + 1) {
    const rule: RedactionRule = allRules[index];
    // Fresh RegExp each time: /g patterns carry lastIndex state between calls,
    // which silently skips matches on the second string you pass in.
    const pattern: RegExp = new RegExp(rule.pattern.source, rule.pattern.flags);

    if (rule.keepLabel === true) {
      // The pattern captures EVERYTHING before the value in group 1 - label,
      // any quotes, the separator - and the value alone in group 2. Keeping
      // group 1 and dropping group 2 preserves the label while removing the
      // secret, and it stays correct when the shape of group 1 changes.
      result = result.replace(
        pattern,
        function onLabelledMatch(_whole: string, beforeValue: string): string {
          countRedaction(counter, rule.name);
          return beforeValue + "[REDACTED:" + rule.name + "]";
        },
      );
      continue;
    }

    result = result.replace(pattern, function onMatch(): string {
      countRedaction(counter, rule.name);
      return "[REDACTED:" + rule.name + "]";
    });
  }

  return result;
}

/**
 * Compiles the tester's own patterns from the options page.
 * An invalid pattern is skipped rather than throwing, because a typo in
 * settings must not block every future report.
 */
export function compileCustomPatterns(sources: readonly string[]): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (let index = 0; index < sources.length; index = index + 1) {
    const source: string = sources[index].trim();
    if (source === "") {
      continue;
    }
    try {
      rules.push({ name: "custom", pattern: new RegExp(source, "g") });
    } catch (compileError: unknown) {
      // Deliberately skipped; the options page validates and warns separately.
    }
  }
  return rules;
}

/**
 * Scrubs sensitive query parameters out of a URL, keeping the rest readable.
 *
 * WHY we keep the parameter NAME: "?token=[REDACTED:url-parameter]" tells the
 * model a token was present, and a 401 with a token is a different bug from a
 * 401 without one.
 */
export function redactUrl(
  url: string,
  counter: RedactionCounter,
  extraPatterns: readonly RedactionRule[],
): string {
  if (url === "") {
    return "";
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (invalidUrlError: unknown) {
    return redactValuePatterns(url, counter, extraPatterns);
  }

  const parameterNames: string[] = [];
  parsedUrl.searchParams.forEach(function collect(
    _value: string,
    name: string,
  ): void {
    parameterNames.push(name);
  });

  for (let index = 0; index < parameterNames.length; index = index + 1) {
    const name: string = parameterNames[index];
    const lowerName: string = name.toLowerCase();
    let isSensitive: boolean = false;
    for (let checkIndex = 0; checkIndex < SENSITIVE_URL_PARAMETERS.length;
         checkIndex = checkIndex + 1) {
      if (lowerName === SENSITIVE_URL_PARAMETERS[checkIndex]) {
        isSensitive = true;
        break;
      }
    }
    if (isSensitive) {
      parsedUrl.searchParams.set(name, "[REDACTED:url-parameter]");
      countRedaction(counter, "url-parameter");
    }
  }

  // The fragment is not part of searchParams and routinely carries tokens.
  if (parsedUrl.hash !== "") {
    parsedUrl.hash = redactValuePatterns(parsedUrl.hash, counter, extraPatterns);
  }

  return redactValuePatterns(parsedUrl.toString(), counter, extraPatterns);
}

/**
 * Scrubs value/placeholder attributes and text content out of captured HTML.
 *
 * WHY a regex and not a DOM parse: this code must run in the service worker and
 * in a page context alike, and the service worker has no DOMParser. A targeted
 * tag-level regex is the honest trade-off, and the blanket value scrub
 * afterwards catches what the attribute scrub misses.
 *
 * This is NOT a proof. It handles the realistic cases. See the limitations note
 * at the bottom of this file.
 */
export function redactHtml(
  html: string,
  counter: RedactionCounter,
  extraPatterns: readonly RedactionRule[],
): string {
  if (html === "") {
    return "";
  }

  // Rewrite every tag whose own attributes suggest a sensitive field.
  const tagPattern: RegExp = /<[^>]*>/g;
  let result: string = html.replace(tagPattern, function onTag(tagText: string): string {
    const isPasswordInput: boolean = /type\s*=\s*"password"/i.test(tagText);
    const rule: SensitiveFieldRule | null = findSensitiveFieldRule(tagText);

    if (!isPasswordInput && rule === null) {
      return tagText;
    }

    const ruleName: string = rule === null ? "password" : rule.name;
    let rewritten: string = tagText;

    for (let index = 0; index < SENSITIVE_HTML_ATTRIBUTES.length; index = index + 1) {
      const attributeName: string = SENSITIVE_HTML_ATTRIBUTES[index];
      const attributePattern: RegExp =
        new RegExp(attributeName + '\\s*=\\s*"[^"]*"', "gi");
      if (attributePattern.test(rewritten)) {
        countRedaction(counter, ruleName);
        rewritten = rewritten.replace(
          new RegExp(attributeName + '\\s*=\\s*"[^"]*"', "gi"),
          attributeName + '="[REDACTED:' + ruleName + ']"',
        );
      }
    }
    return rewritten;
  });

  result = redactValuePatterns(result, counter, extraPatterns);
  return result;
}

/**
 * Redacts the generated Playwright script.
 *
 * WHY this is its own function: the script is the highest-risk surface, because
 * fill() calls contain literal typed values, and it is the surface a developer
 * is most likely to forget.
 */
export function redactPlaywrightScript(
  script: string,
  counter: RedactionCounter,
  extraPatterns: readonly RedactionRule[],
): string {
  if (script === "") {
    return "";
  }

  // Redact fill() arguments by the FIELD they are being typed into, as well as
  // by what they look like.
  //
  // The action trace is redacted by field name, but the script was only ever
  // redacted by value pattern. A value typed into a field the content script
  // did not flag - "Verification Code", "Account Number" - was therefore
  // stripped from the trace and left sitting in the fill() call beside it. A
  // six-digit verification code matches no value pattern at all.
  const lines: string[] = script.split("\n");
  const fillPattern: RegExp = /(\.\s*fill\s*\(\s*)'((?:[^'\\]|\\.)*)'(\s*\))/g;

  for (let index = 0; index < lines.length; index = index + 1) {
    const line: string = lines[index];
    if (!line.includes(".fill(")) {
      continue;
    }

    // Everything before .fill( names the control: getByLabel('Account Number'),
    // getByRole('textbox', { name: 'CVV' }), getByPlaceholder('OTP') ...
    const fillIndex: number = line.indexOf(".fill(");
    const locatorPart: string = line.slice(0, fillIndex);
    const fieldRule: SensitiveFieldRule | null = findSensitiveFieldRule(locatorPart);

    lines[index] = line.replace(
      fillPattern,
      function onFill(
        _whole: string,
        prefix: string,
        value: string,
        suffix: string,
      ): string {
        if (fieldRule !== null) {
          countRedaction(counter, fieldRule.name);
          return prefix + "'[REDACTED:" + fieldRule.name + "]'" + suffix;
        }
        const redactedValue: string =
          redactValuePatterns(value, counter, extraPatterns);
        return prefix + "'" + redactedValue + "'" + suffix;
      },
    );
  }

  let result: string = lines.join("\n");

  // Then blanket patterns over the whole file, which also catches URLs in goto().
  result = redactValuePatterns(result, counter, extraPatterns);
  return result;
}

/**
 * Redacts one action-trace step, returning a copy.
 */
function redactActionTraceStep(
  step: ActionTraceStep,
  counter: RedactionCounter,
  extraPatterns: readonly RedactionRule[],
): ActionTraceStep {
  const copy: ActionTraceStep = { ...step };

  const fieldRule: RedactionRule | null =
    findSensitiveFieldRule(copy.elementDescription);

  if (copy.inputValue !== "" && !copy.inputValue.startsWith("[REDACTED:")) {
    if (fieldRule !== null) {
      copy.inputValue = "[REDACTED:" + fieldRule.name + "]";
      copy.wasRedacted = true;
      countRedaction(counter, fieldRule.name);
    } else {
      const redactedValue: string =
        redactValuePatterns(copy.inputValue, counter, extraPatterns);
      if (redactedValue !== copy.inputValue) {
        copy.inputValue = redactedValue;
        copy.wasRedacted = true;
      }
    }
  }

  copy.pageUrl = redactUrl(copy.pageUrl, counter, extraPatterns);
  copy.elementDescription =
    redactValuePatterns(copy.elementDescription, counter, extraPatterns);
  return copy;
}

/**
 * Throws unless every field the gate has to walk is the shape it expects.
 *
 * This is deliberately strict: a bundle that does not match is a programming
 * error, and the correct response to a programming error in a security gate is
 * to stop, not to guess.
 */
function assertBundleShape(bundle: AIEvidenceBundle): void {
  if (typeof bundle !== "object" || bundle === null) {
    throw new Error("The evidence bundle is not an object.");
  }

  const arrayFields: [string, unknown][] = [
    ["actionTrace", bundle.actionTrace],
    ["domSnapshots", bundle.domSnapshots],
    ["elementContext", bundle.elementContext],
    ["networkFailures", bundle.networkFailures],
    ["consoleErrors", bundle.consoleErrors],
  ];

  for (let index = 0; index < arrayFields.length; index = index + 1) {
    const [name, value] = arrayFields[index];
    if (!Array.isArray(value)) {
      throw new Error(
        "The evidence bundle field '" + name + "' is not an array, so it could "
        + "not be inspected for sensitive data.",
      );
    }
  }

  // An image is pixels: the gate cannot inspect it, and the ONLY thing it can
  // guarantee is that the field is what it claims to be. Whether it is sent at
  // all is decided by the video consent, in buildEvidenceBundle.
  if (typeof bundle.finalScreenshotBase64 !== "string") {
    throw new Error(
      "The evidence bundle field 'finalScreenshotBase64' is not a string, so "
      + "what would be sent to the model could not be established.",
    );
  }

  if (typeof bundle.playwrightScript !== "string") {
    throw new Error(
      "The evidence bundle field 'playwrightScript' is not a string, so it "
      + "could not be inspected for sensitive data.",
    );
  }

  if (typeof bundle.pageMeta !== "object" || bundle.pageMeta === null) {
    throw new Error("The evidence bundle field 'pageMeta' is not an object.");
  }
}

/**
 * THE GATE.
 *
 * Redacts every text surface in the bundle and returns a new bundle. Throws if
 * anything goes wrong — and the caller MUST NOT catch it and continue, because
 * the whole point is that an un-redacted bundle can never be sent.
 *
 * WHY it is synchronous: an async gate invites a caller to fire the API request
 * in parallel by mistake. Synchronous makes that ordering error impossible.
 */
export function redactSensitiveData(
  bundle: AIEvidenceBundle,
  customPatternSources: readonly string[],
): AIEvidenceBundle {
  const counter: RedactionCounter = {};
  const extraPatterns: RedactionRule[] = compileCustomPatterns(customPatternSources);

  try {
    // Fail closed on a malformed bundle.
    //
    // WHY this check exists: without it, a field that is not the array we
    // expect simply never gets iterated, so the loop body never runs, nothing
    // throws, and the bundle is marked redacted while its contents were never
    // inspected. A gate that silently passes unexamined data is worse than no
    // gate.
    //
    // It sits INSIDE the try so that every way this function can refuse
    // produces the same caller-facing message: nothing was sent.
    assertBundleShape(bundle);

    // --- Action trace -------------------------------------------------------
    const redactedTrace: ActionTraceStep[] = [];
    for (let index = 0; index < bundle.actionTrace.length; index = index + 1) {
      redactedTrace.push(
        redactActionTraceStep(bundle.actionTrace[index], counter, extraPatterns),
      );
    }

    // --- Page code: full-page snapshots -------------------------------------
    const redactedSnapshots: BundledDomSnapshot[] = [];
    for (let index = 0; index < bundle.domSnapshots.length; index = index + 1) {
      const snapshot: BundledDomSnapshot = { ...bundle.domSnapshots[index] };
      snapshot.prunedHtml = redactHtml(snapshot.prunedHtml, counter, extraPatterns);
      snapshot.pageUrl = redactUrl(snapshot.pageUrl, counter, extraPatterns);
      // Free text written by this extension, but scrubbed anyway: a future edit
      // that puts captured data back into it must not silently reopen a hole.
      snapshot.significanceReason =
        redactValuePatterns(snapshot.significanceReason, counter, extraPatterns);
      redactedSnapshots.push(snapshot);
    }

    // --- Page code: element contexts ----------------------------------------
    const redactedContexts: BundledElementContext[] = [];
    for (let index = 0; index < bundle.elementContext.length; index = index + 1) {
      const context: BundledElementContext = { ...bundle.elementContext[index] };
      context.elementHtml = redactHtml(context.elementHtml, counter, extraPatterns);
      context.ancestorHtml = redactHtml(context.ancestorHtml, counter, extraPatterns);

      const redactedSiblings: string[] = [];
      for (let siblingIndex = 0; siblingIndex < context.siblingHtml.length;
           siblingIndex = siblingIndex + 1) {
        redactedSiblings.push(
          redactHtml(context.siblingHtml[siblingIndex], counter, extraPatterns),
        );
      }
      context.siblingHtml = redactedSiblings;

      context.ariaState = {
        ...context.ariaState,
        ariaLabel: redactValuePatterns(context.ariaState.ariaLabel, counter, extraPatterns),
        ariaDescribedByText: redactValuePatterns(
          context.ariaState.ariaDescribedByText, counter, extraPatterns),
        validationMessage: redactValuePatterns(
          context.ariaState.validationMessage, counter, extraPatterns),
      };

      context.elementDescription =
        redactValuePatterns(context.elementDescription, counter, extraPatterns);
      redactedContexts.push(context);
    }

    // --- Network failures ---------------------------------------------------
    const redactedNetwork: NetworkEntry[] = [];
    for (let index = 0; index < bundle.networkFailures.length; index = index + 1) {
      const entry: NetworkEntry = { ...bundle.networkFailures[index] };
      entry.url = redactUrl(entry.url, counter, extraPatterns);
      entry.initiatorPageUrl =
        redactUrl(entry.initiatorPageUrl, counter, extraPatterns);
      entry.requestBodyExcerpt =
        redactValuePatterns(entry.requestBodyExcerpt, counter, extraPatterns);
      entry.responseBodyExcerpt =
        redactValuePatterns(entry.responseBodyExcerpt, counter, extraPatterns);

      const safeHeaders: Record<string, string> = {};
      const headerNames: string[] = Object.keys(entry.requestHeaders);
      for (let headerIndex = 0; headerIndex < headerNames.length;
           headerIndex = headerIndex + 1) {
        const headerName: string = headerNames[headerIndex];
        const lowerName: string = headerName.toLowerCase();
        let isForbidden: boolean = false;
        for (let checkIndex = 0; checkIndex < FORBIDDEN_HEADERS.length;
             checkIndex = checkIndex + 1) {
          if (lowerName === FORBIDDEN_HEADERS[checkIndex]) {
            isForbidden = true;
            break;
          }
        }
        if (isForbidden) {
          safeHeaders[headerName] = "[REDACTED:header]";
          countRedaction(counter, "header");
        } else {
          safeHeaders[headerName] = redactValuePatterns(
            entry.requestHeaders[headerName], counter, extraPatterns);
        }
      }
      entry.requestHeaders = safeHeaders;
      redactedNetwork.push(entry);
    }

    // --- Console errors -----------------------------------------------------
    const redactedConsole: ConsoleEntry[] = [];
    for (let index = 0; index < bundle.consoleErrors.length; index = index + 1) {
      const entry: ConsoleEntry = { ...bundle.consoleErrors[index] };
      entry.message = redactValuePatterns(entry.message, counter, extraPatterns);
      entry.stackExcerpt =
        redactValuePatterns(entry.stackExcerpt, counter, extraPatterns);
      entry.pageUrl = redactUrl(entry.pageUrl, counter, extraPatterns);
      redactedConsole.push(entry);
    }

    // --- The generated script -----------------------------------------------
    const redactedScript: string =
      redactPlaywrightScript(bundle.playwrightScript, counter, extraPatterns);

    // --- Page metadata ------------------------------------------------------
    const redactedMeta: PageMeta = { ...bundle.pageMeta };
    redactedMeta.url = redactUrl(redactedMeta.url, counter, extraPatterns);
    redactedMeta.title = redactValuePatterns(redactedMeta.title, counter, extraPatterns);

    return {
      ...bundle,
      actionTrace: redactedTrace,
      playwrightScript: redactedScript,
      domSnapshots: redactedSnapshots,
      elementContext: redactedContexts,
      networkFailures: redactedNetwork,
      consoleErrors: redactedConsole,
      pageMeta: redactedMeta,
      redactionCompleted: true,
      redactionSummary: counter,
    };
  } catch (redactionError: unknown) {
    // Deliberately re-thrown. Redaction failure BLOCKS the request.
    throw new Error(
      "Redaction failed, so nothing was sent to the AI service. "
      + "The video and the Playwright script are still available. "
      + "Underlying error: " + String(redactionError),
    );
  }
}

// -----------------------------------------------------------------------------
// KNOWN LIMITATIONS, written down so nobody is surprised later:
//
//  - The HTML scrub is regex-based, not a DOM parse. It handles the realistic
//    cases but it is not a proof.
//  - PII that looks like ordinary text is NOT caught. A customer's name typed
//    into a "Tenant name" field will be sent. Emails are caught; names and
//    street addresses are not. If the team tests against real customer data,
//    that is a policy problem this file cannot solve.
//  - The video CANNOT be redacted at all. That is handled by explicit tester
//    consent in the review page, not by code.
// -----------------------------------------------------------------------------
