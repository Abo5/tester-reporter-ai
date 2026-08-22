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
import {
  DEFAULT_STEP_PAUSE_MS,
  TYPING_DELAY_MS,
  MAX_REPLAYED_GAP_MS,
  MIN_REPLAYED_GAP_MS,
} from "../shared/constants";

/**
 * Escapes a recorded URL for waitForURL, which treats a string as a GLOB.
 *
 * A recorded URL routinely contains ? and *, and both are glob wildcards there:
 * waitForURL('/x?tenant=TN-1') would also match '/xAtenant=TN-1'. Passing a
 * regular expression instead means the spec waits for the URL that was actually
 * recorded.
 */
function urlAsRegExpLiteral(url: string): string {
  let escaped: string = "";
  const specials: string = "\\^$.*+?()[]{}|/";
  for (let index = 0; index < url.length; index = index + 1) {
    const character: string = url.charAt(index);
    if (specials.includes(character)) {
      escaped = escaped + "\\" + character;
    } else {
      escaped = escaped + character;
    }
  }
  return "/^" + escaped + "$/";
}

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
  previousEvent: RecordedEvent | null,
  stepNumber: number,
  networkEntries: NetworkEntry[],
  allEvents: RecordedEvent[],
  alreadyAwaitedUrl: string,
  preAwaitedNextUrl: { value: string },
): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(
    INDENT + "// [" + formatVideoTimestamp(event.videoOffsetMs) + "] step "
    + String(stepNumber),
  );

  // The tester's own pause before this action, reproduced.
  const gapLines: string[] = buildRealGapLines(event, previousEvent);
  for (let index = 0; index < gapLines.length; index = index + 1) {
    lines.push(gapLines[index]);
  }

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
      lines.push(INDENT + "await page.waitForURL("
        + urlAsRegExpLiteral(event.pageUrl) + ");");
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
        + ".pressSequentially(process.env.TEST_SECRET_VALUE ?? '', "
        + "{ delay: " + String(TYPING_DELAY_MS) + " });");
    } else {
      // pressSequentially, not fill.
      //
      // fill() sets the value directly and fires ONE input event. That is fast
      // and it is what a normal test wants - and it is exactly wrong for
      // reproducing a bug. A field that validates on keyup, an autocomplete
      // that fires on the third character, a mask that rejects the tenth, a
      // debounce that only misbehaves while the tester is still typing: none of
      // those happen under fill(), so a spec built from fill() can pass on the
      // very defect it was recorded to demonstrate.
      //
      // pressSequentially sends real key events, one per character, which is
      // what the tester did.
      lines.push(
        INDENT + "await " + locatorExpression + ".pressSequentially("
        + quote(event.value) + ", { delay: " + String(TYPING_DELAY_MS) + " });");

      const keystrokeNote: string = describeKeystrokeCorrections(event.keystrokes);
      if (keystrokeNote !== "") {
        lines.push(INDENT + "// " + keystrokeNote);
      }
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
    const browserLevelNote: string = describeBrowserLevelShortcut(event.value);
    if (browserLevelNote !== "") {
      lines.push(INDENT + "// " + browserLevelNote);
    }
    if (event.locator === null) {
      lines.push(INDENT + "await page.keyboard.press(" + quote(event.value) + ");");
    } else {
      lines.push(
        INDENT + "await " + locatorExpression + ".press(" + quote(event.value) + ");");
    }
  } else if (event.type === "right-click") {
    lines.push(
      INDENT + "await " + locatorExpression + ".click({ button: 'right' });");
    lines.push(
      INDENT + "// The context menu this opens is browser chrome, not part of "
      + "the page, so nothing after this line can interact with it.");
  } else if (event.type === "middle-click") {
    lines.push(
      INDENT + "await " + locatorExpression + ".click({ button: 'middle' });");
    lines.push(
      INDENT + "// A middle-click on a link opens a new tab. Playwright will "
      + "not follow it; add a context.waitForEvent('page') if the journey "
      + "continues there.");
  } else if (event.type === "paste") {
    if (event.valueWasRedacted) {
      lines.push(
        INDENT + "// The tester pasted a value that looked sensitive. Supply it "
        + "from the environment.");
      lines.push(
        INDENT + "await " + locatorExpression
        + ".fill(process.env.TEST_SECRET_VALUE ?? '');");
    } else {
      lines.push(
        INDENT + "// The tester PASTED this rather than typing it. fill() is "
        + "the closest replay: it sets the value in one step, the way a paste "
        + "does, which is the point - a field that validates on keyup and not "
        + "on paste behaves differently here than under pressSequentially.");
      lines.push(
        INDENT + "await " + locatorExpression + ".fill(" + quote(event.value) + ");");
    }
  } else if (event.type === "copy" || event.type === "cut") {
    lines.push(
      INDENT + "// The tester " + event.type + "-ed here. The clipboard is not "
      + "part of the page and Playwright does not replay it; this line records "
      + "what happened.");
    lines.push(
      INDENT + "await " + locatorExpression + ".press("
      + quote(event.type === "copy" ? "Control+c" : "Control+x") + ");");
  } else if (event.type === "drag-drop") {
    const dropExpression: string =
      event.dropTargetLocator === null
        ? ""
        : locatorToPlaywrightExpression(event.dropTargetLocator);
    if (dropExpression === "") {
      lines.push(
        INDENT + "// The tester dragged from here to " + event.value + ", but "
        + "the element they dropped onto could not be identified. Add the "
        + "target by hand.");
    } else {
      lines.push(
        INDENT + "await " + locatorExpression + ".dragTo(" + dropExpression + ");");
    }
  } else if (event.type === "mouse-path") {
    lines.push(
      INDENT + "// The tester moved the pointer here (" + describeMousePath(event.value)
      + "). Movement is recorded as evidence for the report - it shows where "
      + "they looked - but it changes nothing on the page, so there is no "
      + "statement to replay.");
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
    lines.push(INDENT + "await page.waitForURL("
      + urlAsRegExpLiteral(nextEvent.pageUrl) + ");");
    preAwaitedNextUrl.value = nextEvent.pageUrl;
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
 * A short note when the tester corrected themselves while typing, or "".
 *
 * WHY this is in the script and not only the report: a field whose final value
 * is right but which was typed, deleted and retyped is often a field that
 * rejected something. The reader of the spec should know that the clean
 * pressSequentially line above is a simplification of what happened.
 */
export function describeKeystrokeCorrections(keystrokes: string[]): string {
  if (keystrokes.length === 0) {
    return "";
  }

  let corrections: number = 0;
  for (let index = 0; index < keystrokes.length; index = index + 1) {
    if (keystrokes[index] === "Backspace" || keystrokes[index] === "Delete") {
      corrections = corrections + 1;
    }
  }

  if (corrections === 0) {
    return "";
  }

  return "The tester corrected themselves " + String(corrections)
    + " time(s) while typing this. The line above types the final value in one "
    + "go; if the defect involves what the field did DURING typing, replay the "
    + "recorded keys instead: " + keystrokes.join(" ");
}

/**
 * Turns a sampled mouse path into a sentence.
 *
 * WHAT: "8 points, 640px travelled". WHY not the raw points: forty coordinate
 * pairs in a comment is something a reader skips, and the number that carries
 * meaning is how far the pointer went - a long path before a click says the
 * tester could not find the control.
 */
export function describeMousePath(pathValue: string): string {
  const parts: string[] = pathValue.split(" ");
  if (parts.length < 2) {
    return "no movement";
  }

  let travelled: number = 0;
  let previousX: number = 0;
  let previousY: number = 0;

  for (let index = 0; index < parts.length; index = index + 1) {
    const pair: string[] = parts[index].split(",");
    const x: number = Number(pair[0]);
    const y: number = Number(pair[1]);
    if (index > 0) {
      const deltaX: number = x - previousX;
      const deltaY: number = y - previousY;
      travelled = travelled + Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    }
    previousX = x;
    previousY = y;
  }

  return String(parts.length) + " points, " + String(Math.round(travelled))
    + "px travelled";
}


/**
 * The lines that reproduce how long the tester actually waited before an
 * action.
 *
 * WHY the recorded gap and not a fixed pause: a replay at machine speed is a
 * different test from the one that was recorded. A token that expires after ten
 * seconds, a debounce that settles after two, a toast that vanishes after five,
 * a poll that only fires once a minute - none of them reproduce when every step
 * runs 40 milliseconds after the last. The tester's pace is part of the
 * evidence.
 *
 * The gap is capped: someone who answered the phone mid-session should not turn
 * their spec into a four-minute pause. When it is capped the real figure goes
 * in a comment, so a reader who needs it can put it back.
 *
 * Scaled by REPLAY_SPEED so the same file can be run at full speed in CI
 * without editing it.
 */
export function buildRealGapLines(
  event: RecordedEvent,
  previousEvent: RecordedEvent | null,
): string[] {
  if (previousEvent === null) {
    return [];
  }

  const gapMs: number = event.wallClockMs - previousEvent.wallClockMs;
  if (gapMs < MIN_REPLAYED_GAP_MS) {
    return [];
  }

  const lines: string[] = [];

  if (gapMs > MAX_REPLAYED_GAP_MS) {
    lines.push(
      INDENT + "// The tester actually waited "
      + String(Math.round(gapMs / 1000))
      + "s here. Capped to " + String(Math.round(MAX_REPLAYED_GAP_MS / 1000))
      + "s so one interruption does not stall the whole replay; restore the "
      + "real figure if the defect depends on the wait.");
    lines.push(
      INDENT + "await waitLikeTheTesterDid(" + String(MAX_REPLAYED_GAP_MS) + ");");
    return lines;
  }

  lines.push(
    INDENT + "await waitLikeTheTesterDid(" + String(Math.round(gapMs)) + ");");
  return lines;
}

/**
 * The lines that let a person WATCH the replay.
 *
 * A script that replays a three-minute session in nine seconds is correct and
 * useless to look at: the tester who recorded it cannot tell whether the click
 * landed on the right row, because the row was on screen for 40 milliseconds.
 * A pause between steps turns the script into a demonstration.
 *
 * WHY a helper reading an environment variable rather than a literal
 * waitForTimeout after every line:
 *   - the same file has to be watchable on a desk AND fast in CI, and a
 *     hard-coded three-second sleep in fifty steps is two and a half minutes of
 *     nothing on every build;
 *   - one constant is one place to change it;
 *   - and a fixed sleep is an anti-pattern to a Playwright reader, so being
 *     explicit that it is a viewing aid, not a synchronisation device, stops
 *     the next person deleting it as a mistake.
 *
 * It defaults to three seconds because the person who most wants to run this is
 * the tester who just recorded it, and they want to see it. Set STEP_PAUSE_MS=0
 * in CI.
 */
export function buildPaceHelperLines(): string[] {
  const lines: string[] = [];

  lines.push(INDENT + "// Slow enough to watch. This is a VIEWING AID, not a");
  lines.push(INDENT + "// synchronisation device - every step above already");
  lines.push(INDENT + "// waits properly on its own. Set STEP_PAUSE_MS=0 to run");
  lines.push(INDENT + "// at full speed in CI.");
  lines.push(INDENT + "const stepPauseMs = Number(process.env.STEP_PAUSE_MS ?? "
    + String(DEFAULT_STEP_PAUSE_MS) + ");");
  lines.push(INDENT + "const pause = async (): Promise<void> => {");
  lines.push(INDENT + "  if (stepPauseMs > 0) {");
  lines.push(INDENT + "    await page.waitForTimeout(stepPauseMs);");
  lines.push(INDENT + "  }");
  lines.push(INDENT + "};");
  lines.push("");
  lines.push(INDENT + "// Reproduces how long the TESTER waited before each");
  lines.push(INDENT + "// step. A defect that needs a token to expire, a");
  lines.push(INDENT + "// debounce to settle or a toast to vanish does not");
  lines.push(INDENT + "// appear at machine speed. REPLAY_SPEED=0 skips all of");
  lines.push(INDENT + "// it; REPLAY_SPEED=2 replays at double speed.");
  lines.push(INDENT + "const replaySpeed = Number(process.env.REPLAY_SPEED ?? 1);");
  lines.push(INDENT + "const waitLikeTheTesterDid = async (ms: number): Promise<void> => {");
  lines.push(INDENT + "  if (replaySpeed <= 0) {");
  lines.push(INDENT + "    return;");
  lines.push(INDENT + "  }");
  lines.push(INDENT + "  await page.waitForTimeout(Math.round(ms / replaySpeed));");
  lines.push(INDENT + "};");
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
  lines.push("");

  // The pause helper. See buildPaceHelperLines for why it is a helper and not a
  // waitForTimeout after every statement.
  const paceLines: string[] = buildPaceHelperLines();
  for (let index = 0; index < paceLines.length; index = index + 1) {
    lines.push(paceLines[index]);
  }

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
    lines.push(INDENT + "await pause();");
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
      continue;
    }

    // The generator reports back which URL it pre-awaited FOR THE NEXT STEP.
    //
    // An earlier version worked this out by looking for "waitForURL(" in the
    // emitted text, which was wrong: a url-change step emits a waitForURL for
    // ITSELF, and the flag was then set to the following step's URL, silently
    // deleting a navigation nobody had waited for.
    const preAwaitedNextUrl: { value: string } = { value: "" };

    const statementLines: string[] = generateStatementsForEvent(
      event,
      nextEvent,
      index === 0 ? null : usableEvents[index - 1],
      stepNumber,
      networkEntries,
      usableEvents,
      alreadyAwaitedUrl,
      preAwaitedNextUrl,
    );

    alreadyAwaitedUrl = preAwaitedNextUrl.value;

    if (statementLines.length === 0) {
      continue;   // Nothing emitted, so this is not a step the reader counts.
    }

    for (let lineIndex = 0; lineIndex < statementLines.length; lineIndex = lineIndex + 1) {
      lines.push(statementLines[lineIndex]);
    }
    lines.push(INDENT + "await pause();");
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

/**
 * A warning for shortcuts the browser handles itself, or "" for the rest.
 *
 * WHY this is worth a line of generated comment: a tester pressed Ctrl+F to
 * find a record they had just created. Recording it is right - the report
 * should say how they found the row - but replaying it is not. Playwright sends
 * the key to the PAGE, and the browser's find bar is not part of the page, so
 * the line runs, passes, and does nothing. Without the comment the next person
 * to read the spec would believe the search was covered.
 */
export function describeBrowserLevelShortcut(keyCombination: string): string {
  const browserShortcuts: Record<string, string> = {
    "Control+f": "the browser's find bar",
    "Control+F": "the browser's find bar",
    "Control+p": "the browser's print dialog",
    "Control+t": "a new browser tab",
    "Control+w": "closing the browser tab",
    "Control+l": "the address bar",
    "Control+d": "the bookmark dialog",
    "F5": "a browser reload",
    "F12": "DevTools",
  };

  const description: string | undefined = browserShortcuts[keyCombination];
  if (description === undefined) {
    return "";
  }

  return "The tester pressed " + keyCombination + ", which opens "
    + description + " - browser chrome, not part of the page. Playwright sends "
    + "this key to the page, so this line will pass without reproducing what "
    + "the tester did. Replace it with the equivalent page action if the "
    + "journey depends on it.";
}
