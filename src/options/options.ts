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
