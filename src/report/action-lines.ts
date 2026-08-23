// =============================================================================
// src/report/action-lines.ts
//
// The raw record: every captured event, in order, in words.
//
// WHY it is separate from the report generators: the report's numbered steps
// are an INSTRUCTION to follow, so they leave out pointer movement and hovers.
// This is the EVIDENCE of what happened, and its whole value is that nothing
// was filtered out of it. Two different jobs, two different lists.
//
// Pure, and in its own file so the tests can import it without pulling in a
// page module that expects a DOM.
// =============================================================================

import type { ElementLocator, RecordedEvent } from "../shared/types";
import { formatVideoTimestamp } from "../shared/time";

/** One line of the action list. */
export interface ActionLine {
  stamp: string;
  text: string;
}

/** The shortest useful description of a locator. */
function describeLocatorBriefly(locator: ElementLocator): string {
  if (locator.accessibleName !== "") {
    return '"' + locator.accessibleName + '"'
      + (locator.ariaRole === "" ? "" : " (" + locator.ariaRole + ")");
  }
  if (locator.visibleText !== "") {
    return '"' + locator.visibleText.slice(0, 40) + '"';
  }
  return locator.primary.value.slice(0, 60);
}

/** A short, readable sentence for one event. */
export function describeActionLine(event: RecordedEvent): string {
  const target: string =
    event.locator === null ? "" : describeLocatorBriefly(event.locator);
  const where: string = target === "" ? "" : " \u2014 " + target;

  if (event.type === "mouse-path") {
    const points: number = event.value === "" ? 0 : event.value.split(" ").length;
    return "moved the pointer (" + String(points) + " points)";
  }
  if (event.type === "input") {
    const shown: string =
      event.valueWasRedacted ? "a hidden value" : '"' + event.value + '"';
    const corrections: string =
      event.keystrokes.length === 0 ? "" : "  [" + event.keystrokes.join(" ") + "]";
    return "typed " + shown + where + corrections;
  }
  if (event.type === "paste" || event.type === "copy" || event.type === "cut") {
    const shown: string =
      event.valueWasRedacted ? "a hidden value" : '"' + event.value + '"';
    return event.type + " " + shown + where;
  }
  if (event.type === "press-key") {
    return "pressed " + event.value + where;
  }
  if (event.type === "navigate" || event.type === "url-change") {
    return "went to " + event.pageUrl;
  }
  if (event.type === "scroll") {
    return "scrolled to " + event.value;
  }
  if (event.type === "drag-drop") {
    return "dragged " + event.value + where;
  }
  if (event.type === "select-option") {
    return 'selected "' + event.value + '"' + where;
  }

  return event.type.replace("-", " ") + where;
}

/** Every recorded event, in order, in words. Nothing is filtered out. */
export function buildActionLines(events: RecordedEvent[]): ActionLine[] {
  const lines: ActionLine[] = [];

  for (let index = 0; index < events.length; index = index + 1) {
    const event: RecordedEvent = events[index];
    lines.push({
      stamp: formatVideoTimestamp(event.videoOffsetMs),
      text: describeActionLine(event),
    });
  }

  return lines;
}
