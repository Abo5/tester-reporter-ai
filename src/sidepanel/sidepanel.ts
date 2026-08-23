// =============================================================================
// src/sidepanel/sidepanel.ts
// Recording controls. Holds no state of its own: on open it asks the service
// worker for the current status and renders whatever it is told.
//
// WHY the side panel rather than the popup: a popup closes the instant the
// tester clicks back into the page, which is every single interaction they are
// trying to record.
// =============================================================================

import type { SessionStatus, RecordingSession } from "../shared/types";
import type { LicenceState, LicenceStatus } from "../shared/licence";
import { readLicenceStatus, describeLicenceStatus } from "../shared/licence";
import { readLicenceState } from "../storage/licence-store";
import { asExtensionMessage, sendMessageIgnoringNoReceiver } from "../shared/messages";
import { listSessions } from "../storage/sessions";
import { readSettings, writeSettings } from "../storage/settings";
import { readQuotaStatus, type QuotaStatus } from "../storage/media";
import { formatVideoTimestamp, formatDuration, formatBytes } from "../shared/time";
import { CLEANUP_PROMPT_AFTER_BYTES } from "../shared/constants";
import { logWarning } from "../shared/logger";

/** Every element we touch, looked up once so a typo fails immediately. */
interface PanelElements {
  statusCard: HTMLElement;
  statusLabel: HTMLElement;
  statusTimer: HTMLElement;
  countSteps: HTMLElement;
  countFailures: HTMLElement;
  countErrors: HTMLElement;
  errorBox: HTMLElement;
  trialLine: HTMLElement;
  lastAction: HTMLElement;
  grantCard: HTMLElement;
  grantBody: HTMLElement;
  grantButton: HTMLButtonElement;
  microphoneToggle: HTMLInputElement;
  recordButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  resumeButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  noteCard: HTMLElement;
  noteInput: HTMLInputElement;
  noteButton: HTMLButtonElement;
  sessionList: HTMLElement;
  noSessions: HTMLElement;
  optionsButton: HTMLButtonElement;
  apiKeyWarning: HTMLElement;
}

/** The last status we were told, so the local timer can keep ticking. */
let currentStatus: SessionStatus | "idle" = "idle";
let lastReportedDurationMs: number = 0;
let lastReportAtMs: number = 0;

/**
 * Looks up an element by id and throws if it is missing.
 * WHY throw: a missing element is a build mistake, and failing loudly at load
 * is far easier to debug than a button that silently does nothing.
 */
function requireElement<T extends HTMLElement>(elementId: string): T {
  const element: HTMLElement | null = document.getElementById(elementId);
  if (element === null) {
    throw new Error("Missing element in sidepanel.html: #" + elementId);
  }
  return element as T;
}

/** Collects every element the panel drives. */
function collectElements(): PanelElements {
  return {
    statusCard: requireElement("status-card"),
    statusLabel: requireElement("status-label"),
    statusTimer: requireElement("status-timer"),
    countSteps: requireElement("count-steps"),
    countFailures: requireElement("count-failures"),
    countErrors: requireElement("count-errors"),
    errorBox: requireElement("error-box"),
    trialLine: requireElement("trial-line"),
    lastAction: requireElement("last-action"),
    grantCard: requireElement("grant-card"),
    grantBody: requireElement("grant-body"),
    grantButton: requireElement<HTMLButtonElement>("grant-button"),
    microphoneToggle: requireElement<HTMLInputElement>("microphone-toggle"),
    recordButton: requireElement<HTMLButtonElement>("record-button"),
    pauseButton: requireElement<HTMLButtonElement>("pause-button"),
    resumeButton: requireElement<HTMLButtonElement>("resume-button"),
    stopButton: requireElement<HTMLButtonElement>("stop-button"),
    noteCard: requireElement("note-card"),
    noteInput: requireElement<HTMLInputElement>("note-input"),
    noteButton: requireElement<HTMLButtonElement>("note-button"),
    sessionList: requireElement("session-list"),
    noSessions: requireElement("no-sessions"),
    optionsButton: requireElement<HTMLButtonElement>("options-button"),
    apiKeyWarning: requireElement("api-key-warning"),
  };
}

const elements: PanelElements = collectElements();

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/** Human-readable label for each state. */
function statusLabelFor(status: SessionStatus | "idle"): string {
  if (status === "recording") {
    return "Recording";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "processing") {
    return "Finishing the recording…";
  }
  if (status === "ready" || status === "complete") {
    return "Session ready";
  }
  if (status === "report-failed") {
    return "Session saved, report failed";
  }
  return "Not recording";
}

/** Applies the state class that drives the status dot colour. */
function applyStatusClass(status: SessionStatus | "idle"): void {
  elements.statusCard.className = "card status-" + status;
}

/** Shows only the buttons that make sense right now. */
function renderButtons(status: SessionStatus | "idle"): void {
  const isRecording: boolean = status === "recording";
  const isPaused: boolean = status === "paused";
  const isBusy: boolean = status === "processing";
  const isActive: boolean = isRecording || isPaused;

  elements.recordButton.hidden = isActive || isBusy;
  elements.pauseButton.hidden = !isRecording;
  elements.resumeButton.hidden = !isPaused;
  elements.stopButton.hidden = !isActive;

  elements.recordButton.disabled = isBusy;
  elements.noteCard.hidden = !isActive;
  elements.microphoneToggle.disabled = isActive || isBusy;
}

/** Updates the whole panel from one status message. */
function renderStatus(
  status: SessionStatus | "idle",
  eventCount: number,
  recordedDurationMs: number,
  networkFailureCount: number,
  consoleErrorCount: number,
  errorText: string,
  lastActionLabel: string,
): void {
  currentStatus = status;
  lastReportedDurationMs = recordedDurationMs;
  lastReportAtMs = Date.now();

  if (status === "recording" && lastActionLabel !== "") {
    elements.lastAction.hidden = false;
    elements.lastAction.textContent = "Last: " + lastActionLabel;
  } else {
    elements.lastAction.hidden = true;
  }

  applyStatusClass(status);
  elements.statusLabel.textContent = statusLabelFor(status);
  elements.statusTimer.textContent = formatVideoTimestamp(recordedDurationMs);
  elements.countSteps.textContent = String(eventCount);
  elements.countFailures.textContent = String(networkFailureCount);
  elements.countErrors.textContent = String(consoleErrorCount);

  renderButtons(status);

  if (errorText === "") {
    elements.errorBox.hidden = true;
    elements.errorBox.textContent = "";
  } else {
    elements.errorBox.hidden = false;
    elements.errorBox.textContent = errorText;
  }

  if (status === "ready" || status === "complete" || status === "idle") {
    void renderSessionList();
  }
}

/**
 * Ticks the timer locally between status messages.
 *
 * WHY locally: broadcasting a status message every second just to move a clock
 * would wake the service worker constantly for no reason.
 */
function tickTimer(): void {
  if (currentStatus !== "recording") {
    return;
  }
  const elapsedSinceReport: number = Date.now() - lastReportAtMs;
  elements.statusTimer.textContent =
    formatVideoTimestamp(lastReportedDurationMs + elapsedSinceReport);
}

/** Renders the recent-sessions list with a link to each review page. */
async function renderSessionList(): Promise<void> {
  let sessions: RecordingSession[] = [];
  try {
    sessions = await listSessions();
  } catch (listError: unknown) {
    logWarning("sidepanel", "Could not read the session list.", listError);
    return;
  }

  elements.sessionList.replaceChildren();

  if (sessions.length === 0) {
    elements.noSessions.hidden = false;
    return;
  }
  elements.noSessions.hidden = true;

  const shown: number = Math.min(sessions.length, 6);
  for (let index = 0; index < shown; index = index + 1) {
    const session: RecordingSession = sessions[index];

    const listItem: HTMLLIElement = document.createElement("li");
    const openButton: HTMLButtonElement = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-open";

    const nameSpan: HTMLSpanElement = document.createElement("span");
    nameSpan.className = "session-name";
    nameSpan.textContent = session.name;

    const metaSpan: HTMLSpanElement = document.createElement("span");
    metaSpan.className = "session-meta";
    metaSpan.textContent = describeSession(session);

    openButton.append(nameSpan, metaSpan);
    openButton.addEventListener("click", function onOpen(): void {
      void sendMessageIgnoringNoReceiver({
        kind: "ui/open-review-page",
        sessionId: session.id,
      });
    });

    listItem.append(openButton);
    elements.sessionList.append(listItem);
  }
}

/** One-line summary of a stored session. */
function describeSession(session: RecordingSession): string {
  const parts: string[] = [];
  parts.push(new Date(session.startedAtMs).toLocaleString());
  parts.push(formatDuration(session.recordedDurationMs));
  parts.push(String(session.eventCount) + " steps");

  if (session.bugReport !== null) {
    parts.push("report ready");
  } else if (session.status === "report-failed") {
    parts.push("report pending");
  }
  return parts.join(" · ");
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/** Finds the tab the tester is looking at. */
async function findActiveTabId(): Promise<number | null> {
  const tabs: chrome.tabs.Tab[] =
    await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || tabs[0].id === undefined) {
    return null;
  }
  return tabs[0].id;
}

/** Shows a message in the error box without waiting for a status broadcast. */
function showLocalError(text: string): void {
  elements.errorBox.hidden = false;
  elements.errorBox.textContent = text;
}

/**
 * Starts recording on the active tab.
 *
 * The extension cannot record a chrome:// page or the Web Store, so we say so
 * plainly rather than letting tabCapture fail with an opaque error.
 */
async function startRecording(): Promise<void> {
  const tabId: number | null = await findActiveTabId();
  if (tabId === null) {
    showLocalError("Could not find the active tab.");
    return;
  }

  const tab: chrome.tabs.Tab = await chrome.tabs.get(tabId);
  const url: string = tab.url ?? "";
  const isRecordable: boolean =
    url.startsWith("http://") || url.startsWith("https://");

  if (!isRecordable) {
    showLocalError(
      "This page cannot be recorded. Open the site you want to test in a normal "
      + "http:// or https:// tab first.");
    return;
  }

  await writeSettings({ captureMicrophone: elements.microphoneToggle.checked });

  const reply: unknown = await chrome.runtime.sendMessage({
    kind: "ui/start-recording",
    tabId: tabId,
    captureMicrophone: elements.microphoneToggle.checked,
  });

  const typedReply = reply as { ok?: boolean; error?: string } | undefined;
  if (typedReply !== undefined && typedReply.ok === false) {
    showLocalError(typedReply.error ?? "Recording could not be started.");
  }
}

/** Sends the note the tester typed, then clears the box. */
async function addTesterNote(): Promise<void> {
  const text: string = elements.noteInput.value.trim();
  if (text === "") {
    return;
  }
  elements.noteInput.value = "";
  await sendMessageIgnoringNoReceiver({ kind: "ui/add-tester-note", text: text });
}

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

/** Attaches every click handler. */
function installHandlers(): void {
  elements.recordButton.addEventListener("click", function onRecord(): void {
    startRecording().catch(function onStartError(startError: unknown): void {
      showLocalError(String(startError));
    });
  });

  elements.pauseButton.addEventListener("click", function onPause(): void {
    void sendMessageIgnoringNoReceiver({ kind: "ui/pause-recording" });
  });

  elements.resumeButton.addEventListener("click", function onResume(): void {
    void sendMessageIgnoringNoReceiver({ kind: "ui/resume-recording" });
  });

  elements.stopButton.addEventListener("click", function onStop(): void {
    void sendMessageIgnoringNoReceiver({ kind: "ui/stop-recording" });
  });

  elements.noteButton.addEventListener("click", function onNote(): void {
    void addTesterNote();
  });

  elements.noteInput.addEventListener("keydown", function onNoteKey(
    event: KeyboardEvent,
  ): void {
    if (event.key === "Enter") {
      void addTesterNote();
    }
  });

  elements.optionsButton.addEventListener("click", function onOptions(): void {
    void chrome.runtime.openOptionsPage();
  });

  chrome.runtime.onMessage.addListener(function onMessage(rawMessage: unknown): void {
    const message = asExtensionMessage(rawMessage);
    if (message === null || message.kind !== "sw/status") {
      return;
    }
    renderStatus(
      message.status,
      message.eventCount,
      message.recordedDurationMs,
      message.networkFailureCount,
      message.consoleErrorCount,
      message.errorText,
      message.lastActionLabel,
    );
  });

  window.setInterval(tickTimer, 500);
}

/**
 * Warns about storage BEFORE the tester presses Record.
 *
 * WHY proactively and not just at Record time: the service worker already
 * refuses to start when space is tight, but discovering that at the moment you
 * were about to begin testing is a bad way to find out. This turns a hard
 * refusal into advance notice.
 */
async function renderStorageWarning(): Promise<void> {
  let quota: QuotaStatus;
  try {
    quota = await readQuotaStatus();
  } catch (quotaError: unknown) {
    return;   // Storage estimates are advisory; never block the panel on them.
  }

  if (quota.quotaBytes === 0) {
    return;   // The browser does not report usage. Nothing useful to say.
  }

  if (!quota.canStartRecording) {
    elements.errorBox.hidden = false;
    elements.errorBox.textContent =
      "Not enough free storage to record safely (only "
      + formatBytes(quota.freeBytes) + " left). Delete an old session below, or "
      + "free up disk space.";
    return;
  }

  if (quota.usageBytes > CLEANUP_PROMPT_AFTER_BYTES) {
    elements.errorBox.hidden = false;
    elements.errorBox.textContent =
      "This extension is using " + formatBytes(quota.usageBytes)
      + " of storage, almost all of it video. Open a session below and use "
      + "\u201cDelete video, keep report\u201d on the ones you have finished with.";
  }
}

/** Loads settings, asks for the current status, and renders. */
async function initialisePanel(): Promise<void> {
  installHandlers();

  const settings = await readSettings();
  elements.microphoneToggle.checked = settings.captureMicrophone;
  elements.apiKeyWarning.hidden = settings.geminiApiKey.trim() !== "";

  installGrantHandler();

  renderStatus("idle", 0, 0, 0, 0, "", "");
  await renderGrantWarning();
  await renderTrialLine();
  await renderSessionList();
  await renderStorageWarning();
  await sendMessageIgnoringNoReceiver({ kind: "ui/get-status" });
}

initialisePanel().catch(function onInitError(initError: unknown): void {
  showLocalError("The panel failed to start: " + String(initError));
});

// -----------------------------------------------------------------------------
// The grant warning
//
// Without a host grant the extension records the video and the page addresses
// and NOTHING the tester types or clicks. The first version of this product
// said nothing about that: a tester recorded a three-minute journey across
// Google and into the application under test, and it captured one click and
// nine navigations. They reported it as "the keyboard is not recorded".
//
// It was not a capture bug. It was a permission the extension never asked for
// and never mentioned. This panel now says so before the recording, not after.
// -----------------------------------------------------------------------------

/** The origin pattern for a tab URL, or "" when the tab cannot be recorded. */
export function originPatternForTabUrl(tabUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch (parseError: unknown) {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  return parsed.protocol + "//" + parsed.hostname + "/*";
}

/** The site currently in front of the tester, for the grant button. */
let pendingGrantPattern: string = "";

/**
 * Shows or hides the warning for whatever tab is in front of the tester.
 *
 * Runs on every status broadcast and on every tab change, because the tester
 * can move from a granted site to an ungranted one in the middle of a session
 * and the warning has to follow them.
 */
async function renderGrantWarning(): Promise<void> {
  const tabs: chrome.tabs.Tab[] =
    await chrome.tabs.query({ active: true, currentWindow: true });

  if (tabs.length === 0 || tabs[0].url === undefined) {
    elements.grantCard.hidden = true;
    return;
  }

  const pattern: string = originPatternForTabUrl(tabs[0].url);
  if (pattern === "") {
    elements.grantCard.hidden = true;   // chrome:// and friends: nothing to grant.
    return;
  }

  const granted: boolean = await chrome.permissions.contains({ origins: [pattern] });
  if (granted) {
    elements.grantCard.hidden = true;
    return;
  }

  pendingGrantPattern = pattern;
  elements.grantBody.textContent =
    "Clicks and typing on " + pattern.replace("/*", "")
    + " will not be recorded. You will get the video and the page addresses, "
    + "and nothing else. Granting takes one click and can be undone in Settings.";
  elements.grantCard.hidden = false;
}

/** Asks for the current site, then re-renders. */
function installGrantHandler(): void {
  elements.grantButton.addEventListener("click", function onGrant(): void {
    if (pendingGrantPattern === "") {
      return;
    }
    // Must be inside the click handler: chrome.permissions.request needs a
    // user gesture, and an await before it loses the gesture.
    chrome.permissions.request({ origins: [pendingGrantPattern] }).then(
      function afterRequest(): void {
        void renderGrantWarning();
      },
      function onRequestError(requestError: unknown): void {
        showLocalError("Could not ask for that site: " + String(requestError));
      },
    );
  });

  chrome.tabs.onActivated.addListener(function onTabActivated(): void {
    void renderGrantWarning();
  });
  chrome.tabs.onUpdated.addListener(function onTabUpdated(): void {
    void renderGrantWarning();
  });
  chrome.permissions.onAdded.addListener(function onAdded(): void {
    void renderGrantWarning();
  });
  chrome.permissions.onRemoved.addListener(function onRemoved(): void {
    void renderGrantWarning();
  });
}

/**
 * Shows where the trial stands, in the place the tester already looks.
 *
 * WHY here and not only in Settings: nobody opens Settings. The panel is open
 * during every session, and a customer who is told on day 12 that they have two
 * days left can decide; one who finds out on day 15 that the report button
 * stopped working has been ambushed.
 */
async function renderTrialLine(): Promise<void> {
  const state: LicenceState = await readLicenceState();
  const status: LicenceStatus = readLicenceStatus(state);

  if (status === "licensed") {
    elements.trialLine.hidden = true;
    return;
  }

  elements.trialLine.hidden = false;
  elements.trialLine.textContent = describeLicenceStatus(state);

  if (status === "trial-expired" || status === "licence-invalid") {
    elements.trialLine.classList.add("trial-over");
  } else {
    elements.trialLine.classList.remove("trial-over");
  }
}
