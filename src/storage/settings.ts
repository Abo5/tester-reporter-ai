// =============================================================================
// src/storage/settings.ts
// chrome.storage.local wrapper for the API key and options.
//
// storage.local, NOT storage.sync, deliberately: a synced API key is a key
// sitting in Google account storage in plaintext on every device the tester
// signs into.
// =============================================================================

import type { ExtensionSettings, ReportLanguage } from "../shared/types";
import {
  DEFAULT_MODEL_ID,
  SUPPORTED_MODELS,
  DEFAULT_RETENTION_DAYS,
} from "../shared/constants";
import { currentMonthKey } from "../shared/time";

const SETTINGS_KEY: string = "extensionSettings";

/**
 * The settings a fresh install starts with.
 * WHY a function: the object is mutable and callers edit the copy they get.
 */
export function createDefaultSettings(): ExtensionSettings {
  return {
    geminiApiKey: "",
    modelId: DEFAULT_MODEL_ID,
    reportLanguage: "en",
    captureMicrophone: false,
    captureTabAudio: false,
    neverUploadVideo: false,
    videoUploadConsentGiven: false,
    customRedactionPatterns: [],
    retentionDays: DEFAULT_RETENTION_DAYS,
    monthlyRequestCount: 0,
    monthlyRequestCountMonth: currentMonthKey(),
  };
}

/**
 * Reads settings, filling in any field a previous version did not store.
 * WHY the merge: after an update, a stored object from the old version is
 * missing new keys, and reading `undefined` into a boolean check is exactly the
 * kind of bug that only shows up for existing users.
 */
export async function readSettings(): Promise<ExtensionSettings> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(SETTINGS_KEY);
  const value: unknown = stored[SETTINGS_KEY];
  const defaults: ExtensionSettings = createDefaultSettings();

  if (typeof value !== "object" || value === null) {
    return defaults;
  }

  const merged: ExtensionSettings = { ...defaults, ...(value as ExtensionSettings) };

  // A model id that is no longer supported must not silently 404 at request time.
  let modelIsSupported: boolean = false;
  for (let index = 0; index < SUPPORTED_MODELS.length; index = index + 1) {
    if (SUPPORTED_MODELS[index] === merged.modelId) {
      modelIsSupported = true;
      break;
    }
  }
  if (!modelIsSupported) {
    merged.modelId = DEFAULT_MODEL_ID;
  }

  // Reset the usage counter when the month rolls over.
  const thisMonth: string = currentMonthKey();
  if (merged.monthlyRequestCountMonth !== thisMonth) {
    merged.monthlyRequestCountMonth = thisMonth;
    merged.monthlyRequestCount = 0;
  }

  return merged;
}

/**
 * Writes a partial settings update.
 */
export async function writeSettings(
  changes: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const existing: ExtensionSettings = await readSettings();
  const updated: ExtensionSettings = { ...existing, ...changes };
  await chrome.storage.local.set({ [SETTINGS_KEY]: updated });
  return updated;
}

/**
 * Increments the monthly request counter after a real API call.
 * WHY it exists: so a team can sanity-check usage against their billing page
 * without guessing.
 */
export async function incrementRequestCount(): Promise<void> {
  const settings: ExtensionSettings = await readSettings();
  await writeSettings({
    monthlyRequestCount: settings.monthlyRequestCount + 1,
    monthlyRequestCountMonth: currentMonthKey(),
  });
}

/**
 * Removes only the API key, leaving sessions and other settings alone.
 */
export async function forgetApiKey(): Promise<void> {
  await writeSettings({ geminiApiKey: "" });
}

/**
 * Narrows a raw string to a supported report language.
 */
export function asReportLanguage(candidate: string): ReportLanguage {
  if (candidate === "ar") {
    return "ar";
  }
  return "en";
}
