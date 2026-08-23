// =============================================================================
// src/options/options.ts
// Settings: API key, model, report language, microphone grant, video privacy,
// redaction patterns, storage and retention.
//
// The microphone grant lives HERE and not in the recorder for a specific
// reason: an offscreen document cannot raise a permission prompt, so the grant
// has to be obtained once from a normal extension page where a prompt can be
// shown. VERIFY that constraint against current documentation; if an offscreen
// document can prompt directly, this button becomes optional rather than
// required.
// =============================================================================

import type { ExtensionSettings } from "../shared/types";
import type { LicenceState } from "../shared/licence";
import { describeLicenceStatus } from "../shared/licence";
import {
  readLicenceState,
  verifyLicenceKey,
  recordVerification,
} from "../storage/licence-store";
import {
  PAYPAL_CHECKOUT_URL,
  LICENCE_PRICE_DISPLAY,
} from "../shared/constants";
import {
  readSettings,
  writeSettings,
  forgetApiKey,
  asReportLanguage,
} from "../storage/settings";
import { readQuotaStatus, type QuotaStatus } from "../storage/media";
import { clearAllData } from "../storage/db";
import { applyRetentionPolicy } from "../storage/sessions";
import { compileCustomPatterns } from "../ai/redact";
import { SUPPORTED_MODELS } from "../shared/constants";
import { formatBytes } from "../shared/time";
import { logWarning } from "../shared/logger";

/** Looks up an element by id and throws if it is missing. */
function requireElement<T extends HTMLElement>(elementId: string): T {
  const element: HTMLElement | null = document.getElementById(elementId);
  if (element === null) {
    throw new Error("Missing element in options.html: #" + elementId);
  }
  return element as T;
}

const apiKeyInput = requireElement<HTMLInputElement>("api-key-input");
const toggleKeyButton = requireElement<HTMLButtonElement>("toggle-key-button");
const forgetKeyButton = requireElement<HTMLButtonElement>("forget-key-button");
const apiKeyStatus = requireElement<HTMLElement>("api-key-status");
const modelSelect = requireElement<HTMLSelectElement>("model-select");
const languageSelect = requireElement<HTMLSelectElement>("language-select");
const enableMicrophoneButton =
  requireElement<HTMLButtonElement>("enable-microphone-button");
const microphoneStatus = requireElement<HTMLElement>("microphone-status");
const captureTabAudio = requireElement<HTMLInputElement>("capture-tab-audio");
const neverUploadVideo = requireElement<HTMLInputElement>("never-upload-video");
const resetConsentButton = requireElement<HTMLButtonElement>("reset-consent-button");
const consentStatus = requireElement<HTMLElement>("consent-status");
const redactionPatterns = requireElement<HTMLTextAreaElement>("redaction-patterns");
const patternStatus = requireElement<HTMLElement>("pattern-status");
const storageLine = requireElement<HTMLElement>("storage-line");
const retentionSelect = requireElement<HTMLSelectElement>("retention-select");
const clearDataButton = requireElement<HTMLButtonElement>("clear-data-button");
const clearStatus = requireElement<HTMLElement>("clear-status");
const usageLine = requireElement<HTMLElement>("usage-line");
const savedNote = requireElement<HTMLElement>("saved-note");

/** Timer id for hiding the "Saved." note. */
let savedNoteTimerId: number = 0;

/** Briefly confirms that a change was persisted. */
function flashSaved(): void {
  savedNote.hidden = false;
  window.clearTimeout(savedNoteTimerId);
  savedNoteTimerId = window.setTimeout(function hideNote(): void {
    savedNote.hidden = true;
  }, 1500);
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/** Fills the model dropdown from the supported list. */
function renderModelOptions(selectedModelId: string): void {
  modelSelect.replaceChildren();
  for (let index = 0; index < SUPPORTED_MODELS.length; index = index + 1) {
    const option: HTMLOptionElement = document.createElement("option");
    option.value = SUPPORTED_MODELS[index];
    option.textContent = SUPPORTED_MODELS[index];
    if (SUPPORTED_MODELS[index] === selectedModelId) {
      option.selected = true;
    }
    modelSelect.append(option);
  }
}

/** Describes whether a key is present, without ever showing it by accident. */
function renderApiKeyStatus(key: string): void {
  if (key.trim() === "") {
    apiKeyStatus.textContent =
      "No key set. Recording still works — you will get the video and the "
      + "Playwright script, just not the written report.";
    return;
  }
  const visibleTail: string = key.slice(Math.max(0, key.length - 4));
  apiKeyStatus.textContent =
    "A key ending in …" + visibleTail + " is stored on this machine.";
}

/** Reports whether the microphone permission has already been granted. */
async function renderMicrophoneStatus(): Promise<void> {
  if (navigator.permissions === undefined) {
    microphoneStatus.textContent = "Unknown";
    return;
  }
  try {
    const result: PermissionStatus = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (result.state === "granted") {
      microphoneStatus.textContent = "Granted";
      microphoneStatus.classList.add("ok");
      enableMicrophoneButton.disabled = true;
    } else if (result.state === "denied") {
      microphoneStatus.textContent = "Blocked in browser settings";
      microphoneStatus.classList.remove("ok");
    } else {
      microphoneStatus.textContent = "Not granted yet";
      microphoneStatus.classList.remove("ok");
    }
  } catch (queryError: unknown) {
    logWarning("options", "Could not query the microphone permission.", queryError);
    microphoneStatus.textContent = "Unknown";
  }
}

/** Shows how much space the extension is using. */
async function renderStorage(): Promise<void> {
  let quota: QuotaStatus;
  try {
    quota = await readQuotaStatus();
  } catch (quotaError: unknown) {
    storageLine.textContent = "Could not read the storage estimate.";
    return;
  }

  if (quota.quotaBytes === 0) {
    storageLine.textContent = "Storage usage is not reported by this browser.";
    return;
  }

  storageLine.textContent =
    "Using " + formatBytes(quota.usageBytes) + " of about "
    + formatBytes(quota.quotaBytes) + " available ("
    + formatBytes(quota.freeBytes) + " free).";

  if (!quota.canStartRecording) {
    storageLine.textContent = storageLine.textContent
      + " That is not enough headroom to start a new recording safely.";
  }
}

/** Validates the custom redaction patterns and reports what was rejected. */
function renderPatternStatus(rawText: string): void {
  const lines: string[] = rawText.split("\n");
  const nonEmpty: string[] = [];
  for (let index = 0; index < lines.length; index = index + 1) {
    if (lines[index].trim() !== "") {
      nonEmpty.push(lines[index].trim());
    }
  }

  if (nonEmpty.length === 0) {
    patternStatus.textContent = "No extra patterns. The built-in ones still apply.";
    return;
  }

  const compiled = compileCustomPatterns(nonEmpty);
  const rejected: number = nonEmpty.length - compiled.length;

  if (rejected === 0) {
    patternStatus.textContent =
      String(compiled.length) + " extra pattern(s) will be applied.";
    return;
  }
  patternStatus.textContent =
    String(compiled.length) + " pattern(s) will be applied. " + String(rejected)
    + " line(s) are not valid regular expressions and will be ignored.";
}

/** Renders the local request counter. */
function renderUsage(settings: ExtensionSettings): void {
  usageLine.textContent =
    String(settings.monthlyRequestCount) + " report request(s) in "
    + settings.monthlyRequestCountMonth + ".";
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Persists the API key as it is typed, debounced by the blur event. */
function installApiKeyHandlers(): void {
  apiKeyInput.addEventListener("change", function onKeyChange(): void {
    const key: string = apiKeyInput.value.trim();
    void writeSettings({ geminiApiKey: key }).then(function afterWrite(): void {
      renderApiKeyStatus(key);
      flashSaved();
    });
  });

  toggleKeyButton.addEventListener("click", function onToggle(): void {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleKeyButton.textContent = "Hide";
    } else {
      apiKeyInput.type = "password";
      toggleKeyButton.textContent = "Show";
    }
  });

  forgetKeyButton.addEventListener("click", function onForget(): void {
    void forgetApiKey().then(function afterForget(): void {
      apiKeyInput.value = "";
      renderApiKeyStatus("");
      flashSaved();
    });
  });
}

/**
 * Requests the microphone permission from this page.
 *
 * The stream is stopped immediately: we only wanted the grant, not the audio.
 */
async function requestMicrophonePermission(): Promise<void> {
  try {
    const stream: MediaStream =
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const tracks: MediaStreamTrack[] = stream.getTracks();
    for (let index = 0; index < tracks.length; index = index + 1) {
      tracks[index].stop();
    }
    await renderMicrophoneStatus();
    flashSaved();
  } catch (permissionError: unknown) {
    microphoneStatus.textContent = "Refused: " + String(permissionError);
    microphoneStatus.classList.remove("ok");
  }
}

/** Wires everything that is not the API key. */
function installRemainingHandlers(): void {
  modelSelect.addEventListener("change", function onModel(): void {
    void writeSettings({ modelId: modelSelect.value }).then(flashSaved);
  });

  languageSelect.addEventListener("change", function onLanguage(): void {
    void writeSettings({
      reportLanguage: asReportLanguage(languageSelect.value),
    }).then(flashSaved);
  });

  enableMicrophoneButton.addEventListener("click", function onMicrophone(): void {
    void requestMicrophonePermission();
  });

  captureTabAudio.addEventListener("change", function onTabAudio(): void {
    void writeSettings({ captureTabAudio: captureTabAudio.checked })
      .then(flashSaved);
  });

  neverUploadVideo.addEventListener("change", function onNeverUpload(): void {
    void writeSettings({ neverUploadVideo: neverUploadVideo.checked })
      .then(flashSaved);
  });

  resetConsentButton.addEventListener("click", function onResetConsent(): void {
    void writeSettings({ videoUploadConsentGiven: false })
      .then(function afterReset(): void {
        consentStatus.textContent = "Not given";
        consentStatus.classList.remove("ok");
        flashSaved();
      });
  });

  redactionPatterns.addEventListener("input", function onPatternInput(): void {
    renderPatternStatus(redactionPatterns.value);
  });

  redactionPatterns.addEventListener("change", function onPatternChange(): void {
    const lines: string[] = redactionPatterns.value.split("\n");
    const cleaned: string[] = [];
    for (let index = 0; index < lines.length; index = index + 1) {
      if (lines[index].trim() !== "") {
        cleaned.push(lines[index].trim());
      }
    }
    void writeSettings({ customRedactionPatterns: cleaned }).then(flashSaved);
  });

  retentionSelect.addEventListener("change", function onRetention(): void {
    const days: number = Number.parseInt(retentionSelect.value, 10);
    const retentionDays: number = Number.isFinite(days) ? days : 0;

    void writeSettings({ retentionDays: retentionDays })
      .then(async function afterWrite(): Promise<void> {
        flashSaved();
        if (retentionDays <= 0) {
          storageLine.textContent =
            "Automatic deletion is off. Nothing will be removed without you "
            + "choosing it.";
          return;
        }
        // Apply it now rather than only at the next browser start, so the
        // tester can see that the setting does something.
        const deletedCount: number =
          await applyRetentionPolicy(retentionDays, Date.now());
        if (deletedCount > 0) {
          storageLine.textContent =
            "Deleted " + String(deletedCount) + " session(s) older than "
            + String(retentionDays) + " days.";
        }
        await renderStorage();
      });
  });

  clearDataButton.addEventListener("click", function onClear(): void {
    const confirmed: boolean = window.confirm(
      "Delete every recorded session, including every video, every generated "
      + "script and every report?\n\nThis cannot be undone. Your API key and "
      + "settings are kept.");
    if (!confirmed) {
      return;
    }
    clearStatus.textContent = "Deleting…";
    clearAllData()
      .then(function afterClear(): void {
        clearStatus.textContent = "All sessions and recordings deleted.";
        void renderStorage();
      })
      .catch(function onClearError(clearError: unknown): void {
        clearStatus.textContent = "Could not delete everything: " + String(clearError);
      });
  });
}

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

/** Loads settings into the form and attaches every handler. */
async function initialiseOptions(): Promise<void> {
  const settings: ExtensionSettings = await readSettings();

  apiKeyInput.value = settings.geminiApiKey;
  renderApiKeyStatus(settings.geminiApiKey);
  renderModelOptions(settings.modelId);
  languageSelect.value = settings.reportLanguage;
  captureTabAudio.checked = settings.captureTabAudio;
  neverUploadVideo.checked = settings.neverUploadVideo;
  redactionPatterns.value = settings.customRedactionPatterns.join("\n");
  retentionSelect.value = String(settings.retentionDays);
  renderPatternStatus(redactionPatterns.value);
  renderUsage(settings);

  if (settings.videoUploadConsentGiven) {
    consentStatus.textContent = "Given";
    consentStatus.classList.add("ok");
  } else {
    consentStatus.textContent = "Not given";
    consentStatus.classList.remove("ok");
  }

  installApiKeyHandlers();
  installRemainingHandlers();

  await renderMicrophoneStatus();
  await renderStorage();
}

initialiseOptions().catch(function onInitError(initError: unknown): void {
  apiKeyStatus.textContent = "Settings failed to load: " + String(initError);
});

// -----------------------------------------------------------------------------
// Site access
//
// The extension ships with no page access at all. This section is how a tester
// grants the sites they test, and how they take it back.
// -----------------------------------------------------------------------------

/**
 * Turns whatever the tester typed into an origin pattern Chrome will accept.
 *
 * WHAT: "staging.example.com", "https://staging.example.com",
 * "https://staging.example.com/login?x=1" all become
 * "https://staging.example.com/*".
 * WHY be this forgiving: the correct string has a scheme, a host, and a literal
 * "/*" on the end, and nobody types that from memory. Rejecting a URL a tester
 * pasted from their address bar would be a pointless obstacle.
 *
 * Returns null when there is no host to be found.
 */
export function toOriginPattern(typedText: string): string | null {
  const trimmed: string = typedText.trim();
  if (trimmed === "") {
    return null;
  }

  let withScheme: string = trimmed;
  if (!withScheme.startsWith("http://") && !withScheme.startsWith("https://")) {
    withScheme = "https://" + withScheme;
  }

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (parseError: unknown) {
    return null;
  }

  if (parsed.hostname === "") {
    return null;
  }

  return parsed.protocol + "//" + parsed.hostname + "/*";
}

/** Redraws the list of granted origins, each with its own revoke button. */
async function renderGrantedOrigins(): Promise<void> {
  const list = document.getElementById("granted-origins") as HTMLUListElement;
  const permissions: chrome.permissions.Permissions =
    await chrome.permissions.getAll();
  const origins: string[] = permissions.origins ?? [];

  const pageOrigins: string[] = [];
  for (const origin of origins) {
    if (origin.indexOf("generativelanguage.googleapis.com") === -1) {
      pageOrigins.push(origin);
    }
  }

  list.textContent = "";

  if (pageOrigins.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No sites granted yet.";
    list.appendChild(empty);
    return;
  }

  for (const origin of pageOrigins) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = origin;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "secondary";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", function onRevoke(): void {
      void chrome.permissions
        .remove({ origins: [origin] })
        .then(function afterRemove(): Promise<void> {
          return renderGrantedOrigins();
        });
    });
    row.appendChild(label);
    row.appendChild(revoke);
    list.appendChild(row);
  }
}

/** Wires the grant button and draws the initial list. */
function installSiteAccessSection(): void {
  const input = document.getElementById("origin-input") as HTMLInputElement;
  const button = document.getElementById("grant-origin-button") as HTMLButtonElement;
  const status = document.getElementById("origin-status") as HTMLParagraphElement;

  button.addEventListener("click", function onGrant(): void {
    const pattern: string | null = toOriginPattern(input.value);
    if (pattern === null) {
      status.textContent =
        "That does not look like a site address. Try https://staging.example.com";
      return;
    }

    // chrome.permissions.request must be called from a user gesture, which is
    // why this lives in a click handler and not in a saved-settings routine.
    chrome.permissions.request({ origins: [pattern] }).then(
      function afterRequest(granted: boolean): void {
        if (granted) {
          status.textContent = "Granted " + pattern;
          input.value = "";
        } else {
          status.textContent = "Not granted. " + pattern + " was left alone.";
        }
        void renderGrantedOrigins();
      },
      function onRequestError(requestError: unknown): void {
        status.textContent = "Could not ask for that site: " + String(requestError);
      },
    );
  });

  void renderGrantedOrigins();
}

installSiteAccessSection();

// -----------------------------------------------------------------------------
// Licence
//
// Read src/shared/licence.ts before changing anything here. The short version:
// this UI is honest about a trial it cannot actually enforce, and the honesty
// is the point. It never tells a customer their key was "verified" when no
// server verified anything.
// -----------------------------------------------------------------------------

/** Draws the current trial or licence state. */
async function renderLicence(): Promise<void> {
  const status = document.getElementById("licence-status") as HTMLElement;
  const message = document.getElementById("licence-message") as HTMLElement;
  const input = document.getElementById("licence-input") as HTMLInputElement;
  const price = document.getElementById("licence-price") as HTMLElement;
  const buyNote = document.getElementById("licence-buy-note") as HTMLElement;
  const buyButton = document.getElementById("licence-buy-button") as HTMLButtonElement;

  const state: LicenceState = await readLicenceState();

  status.textContent = describeLicenceStatus(state);
  message.textContent = state.lastVerificationMessage;
  input.value = state.licenceKey;

  if (LICENCE_PRICE_DISPLAY !== "") {
    price.textContent = LICENCE_PRICE_DISPLAY;
    price.hidden = false;
  } else {
    price.hidden = true;
  }

  // No payment link configured. Saying so beats a button that goes nowhere.
  if (PAYPAL_CHECKOUT_URL === "") {
    buyButton.disabled = true;
    buyNote.textContent =
      "No payment link is configured in this build. Set PAYPAL_CHECKOUT_URL in "
      + "src/shared/constants.ts to your own PayPal link before distributing "
      + "it.";
    return;
  }

  buyButton.disabled = false;
  buyNote.textContent =
    "Opens PayPal in a new tab. Your licence key is emailed to you after "
    + "payment; paste it above and press Verify.";
}

/** Wires the Verify and Buy buttons. */
function installLicenceHandlers(): void {
  const input = document.getElementById("licence-input") as HTMLInputElement;
  const verifyButton =
    document.getElementById("licence-verify-button") as HTMLButtonElement;
  const buyButton =
    document.getElementById("licence-buy-button") as HTMLButtonElement;
  const message = document.getElementById("licence-message") as HTMLElement;

  verifyButton.addEventListener("click", function onVerify(): void {
    verifyButton.disabled = true;
    message.textContent = "Checking…";

    void verifyLicenceKey(input.value)
      .then(function afterVerify(outcome): Promise<void> {
        return recordVerification(input.value, outcome).then(
          function afterRecord(): Promise<void> {
            return renderLicence();
          });
      })
      .catch(function onVerifyError(verifyError: unknown): void {
        message.textContent = "Verification failed: " + String(verifyError);
      })
      .finally(function reEnable(): void {
        verifyButton.disabled = false;
      });
  });

  buyButton.addEventListener("click", function onBuy(): void {
    if (PAYPAL_CHECKOUT_URL === "") {
      return;
    }
    void chrome.tabs.create({ url: PAYPAL_CHECKOUT_URL });
  });

  void renderLicence();
}

installLicenceHandlers();
