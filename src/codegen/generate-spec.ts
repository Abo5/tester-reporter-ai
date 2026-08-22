// =============================================================================
// src/codegen/generate-spec.ts
// RecordedEvent[] -> a complete, runnable .spec.ts source string.
//
// The GENERATED code follows the same long-explicit-boring rules as this
// project, because a junior tester has to read and edit it.
// =============================================================================

import type {
  RecordedEvent,
  RecordingSession,
  NetworkEntry,
} from "../shared/types";
import {
  locatorToPlaywrightExpression,
  buildLocatorComments,
  quote,
} from "./locator-to-playwright";
import { coalesceEventsForCodegen, nextEventAfter } from "./coalesce-events";
import { buildFailureComment, buildClosingAssertions } from "./assertions";
import { formatVideoTimestamp } from "../shared/time";

const INDENT: string = "  ";

/**
 * Emits the statements for one recorded event. Returns zero or more lines.
 *
 * One big explicit chain of conditions rather than a clever table: adding an
 * event type makes the compiler complain in shared/types.ts and a reader can
 * see every mapping in one place.
 */
function generateStatementsForEvent(
  event: RecordedEvent,
  nextEvent: RecordedEvent | null,
  stepNumber: number,
  networkEntries: NetworkEntry[],
  allEvents: RecordedEvent[],
  alreadyAwaitedUrl: string,
): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(
    INDENT + "// [" + formatVideoTimestamp(event.videoOffsetMs) + "] step "
    + String(stepNumber),
  );

  if (event.locator !== null) {
    const comments: string[] = buildLocatorComments(event.locator);
    for (let index = 0; index < comments.length; index = index + 1) {
      lines.push(INDENT + comments[index]);
    }
  }

  const locatorExpression: string =
    event.locator === null ? "page" : locatorToPlaywrightExpression(event.locator);

  if (event.type === "navigate" || event.type === "url-change") {
    // The previous step already emitted a waitForURL for exactly this URL
    // because it caused this navigation. Emitting a goto as well would do a
    // full page load and throw away the state the previous action established.
    if (alreadyAwaitedUrl === event.pageUrl) {
      return [];
    }
    if (event.type === "navigate") {
      lines.push(INDENT + "await page.goto(" + quote(event.pageUrl) + ");");
    } else {
      lines.push(INDENT + "await page.waitForURL(" + quote(event.pageUrl) + ");");
    }
  } else if (event.type === "reload") {
    lines.push(INDENT + "await page.reload();");
  } else if (event.type === "click") {
    lines.push(INDENT + "await " + locatorExpression + ".click();");
  } else if (event.type === "dblclick") {
    lines.push(INDENT + "await " + locatorExpression + ".dblclick();");
  } else if (event.type === "input") {
    if (event.value === "[FILE_UPLOAD]") {
      lines.push(
        INDENT + "// The tester chose a file here. A recording cannot replay a "
        + "file from their machine, so supply one yourself:");
      lines.push(
        INDENT + "// await " + locatorExpression
        + ".setInputFiles('path/to/your/file');");
    } else if (event.valueWasRedacted) {
      lines.push(
        INDENT + "// The recorded value was redacted because the field looked "
        + "sensitive. Supply it from the environment instead.");
      lines.push(
        INDENT + "await " + locatorExpression
        + ".fill(process.env.TEST_SECRET_VALUE ?? '');");
    } else {
      lines.push(
        INDENT + "await " + locatorExpression + ".fill(" + quote(event.value) + ");");
    }
  } else if (event.type === "select-option") {
    lines.push(
      INDENT + "await " + locatorExpression + ".selectOption("
      + quote(event.value) + ");");
  } else if (event.type === "check") {
    lines.push(INDENT + "await " + locatorExpression + ".check();");
  } else if (event.type === "uncheck") {
    lines.push(INDENT + "await " + locatorExpression + ".uncheck();");
  } else if (event.type === "press-key") {
    if (event.locator === null) {
      lines.push(INDENT + "await page.keyboard.press(" + quote(event.value) + ");");
    } else {
      lines.push(
        INDENT + "await " + locatorExpression + ".press(" + quote(event.value) + ");");
    }
  } else if (event.type === "hover") {
    lines.push(INDENT + "await " + locatorExpression + ".hover();");
  } else if (event.type === "scroll") {
    lines.push(
      INDENT + "// The tester scrolled to " + event.value + " here. Playwright "
      + "scrolls elements into view automatically, so no statement is needed.");
  } else if (event.type === "tab-activated") {
    lines.push(
      INDENT + "// The tester switched browser tabs here (" + event.value + "). "
      + "Multi-tab replay is not generated automatically; add it by hand if the "
      + "journey needs it.");
  } else if (event.type === "tester-note") {
    lines.push(INDENT + "// TESTER NOTE: " + event.value.split("\n").join(" "));
  } else {
    lines.push(INDENT + "// Unhandled recorded event type: " + event.type);
  }

  // A click or key press that caused a navigation gets a real wait, never a sleep.
  const causedNavigation: boolean =
    nextEvent !== null
    && (event.type === "click" || event.type === "press-key"
      || event.type === "dblclick")
    && (nextEvent.type === "navigate" || nextEvent.type === "url-change")
    && nextEvent.wallClockMs - event.wallClockMs < 5000;

  if (causedNavigation && nextEvent !== null) {
    lines.push(INDENT + "await page.waitForURL(" + quote(nextEvent.pageUrl) + ");");
  }

  const failureComment: string =
    buildFailureComment(event, networkEntries, allEvents);
  if (failureComment !== "") {
    lines.push(INDENT + failureComment);
  }

  return lines;
}

/**
 * Builds the file header, which tells the reader what this file is and is not.
 */
function buildHeaderLines(
  session: RecordingSession,
  stepCount: number,
): string[] {
  const lines: string[] = [];
  lines.push("// ---------------------------------------------------------------");
  lines.push("// Generated by Tester-Reporter-AI from a recorded QA session.");
  lines.push("// Session:  " + session.name);
  lines.push("// Recorded: " + new Date(session.startedAtMs).toISOString());
  lines.push("// Steps:    " + String(stepCount));
  lines.push("//");
  lines.push("// This file is a starting point, not a finished test. Read it, check");
  lines.push("// the locators, and add the assertions your test actually needs.");
  lines.push("// ---------------------------------------------------------------");
  lines.push("");
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("");
  return lines;
}

/**
 * Generates the whole .spec.ts file.
 *
 * @param session       The session being replayed, for the header and title.
 * @param events        Every recorded event, in order.
 * @param networkEntries Used only to annotate failing steps.
 */
export function generatePlaywrightSpec(
  session: RecordingSession,
  events: RecordedEvent[],
  networkEntries: NetworkEntry[],
): string {
  const usableEvents: RecordedEvent[] = coalesceEventsForCodegen(events);
  const lines: string[] = buildHeaderLines(session, usableEvents.length);

  const testTitle: string =
    session.name.trim() === "" ? "Recorded QA session" : session.name.trim();
  lines.push("test(" + quote(testTitle) + ", async ({ page }) => {");

  // The first statement is always an explicit goto, so the spec is runnable
  // from a clean browser even when the recording began mid-journey.
  const startUrl: string =
    session.originUrl !== ""
      ? session.originUrl
      : (usableEvents.length > 0 ? usableEvents[0].pageUrl : "");

  if (startUrl !== "") {
    lines.push("");
    lines.push(INDENT + "// [00:00] step 1");
    lines.push(INDENT + "await page.goto(" + quote(startUrl) + ");");
  }

  let stepNumber: number = startUrl === "" ? 1 : 2;

  // The URL the previous step already waited for, so the next step does not
  // navigate to it a second time.
  let alreadyAwaitedUrl: string = "";

  for (let index = 0; index < usableEvents.length; index = index + 1) {
    const event: RecordedEvent = usableEvents[index];
    const nextEvent: RecordedEvent | null = nextEventAfter(usableEvents, index);

    // Skip a leading navigation to the URL we already opened above.
    if (index === 0 && event.type === "navigate" && event.pageUrl === startUrl) {
      alreadyAwaitedUrl = "";
      continue;
    }

    const statementLines: string[] = generateStatementsForEvent(
      event,
      nextEvent,
      stepNumber,
      networkEntries,
      usableEvents,
      alreadyAwaitedUrl,
    );

    // Remember whether THIS step emitted a wait the next one should honour.
    const emittedWait: boolean = statementLines.some(
      function isWait(line: string): boolean {
        return line.includes("await page.waitForURL(");
      });
    alreadyAwaitedUrl = emittedWait && nextEvent !== null ? nextEvent.pageUrl : "";

    if (statementLines.length === 0) {
      continue;   // Nothing emitted, so this is not a step the reader counts.
    }

    for (let lineIndex = 0; lineIndex < statementLines.length; lineIndex = lineIndex + 1) {
      lines.push(statementLines[lineIndex]);
    }
    stepNumber = stepNumber + 1;
  }

  const assertionLines: string[] = buildClosingAssertions(usableEvents, INDENT);
  for (let index = 0; index < assertionLines.length; index = index + 1) {
    lines.push(assertionLines[index]);
  }

  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

/**
 * Builds a safe file name for downloading the generated spec.
 */
export function buildSpecFileName(session: RecordingSession): string {
  let safeName: string = "";
  const source: string = session.name.trim() === "" ? "qa-session" : session.name.trim();

  for (let index = 0; index < source.length && safeName.length < 50; index = index + 1) {
    const character: string = source.charAt(index);
    const isSafe: boolean =
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9");
    if (isSafe) {
      safeName = safeName + character.toLowerCase();
    } else if (safeName.length > 0 && !safeName.endsWith("-")) {
      safeName = safeName + "-";
    }
  }

  if (safeName === "" || safeName === "-") {
    safeName = "qa-session";
  }
  while (safeName.endsWith("-")) {
    safeName = safeName.slice(0, safeName.length - 1);
  }

  return safeName + ".spec.ts";
}
