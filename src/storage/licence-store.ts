// =============================================================================
// src/storage/licence-store.ts
// Reads and writes the trial/licence state, and verifies a key.
// =============================================================================

import type { LicenceState } from "../shared/licence";
import {
  createInitialLicenceState,
  advanceClock,
  normaliseLicenceState,
} from "../shared/licence";
import { LICENCE_VERIFY_ENDPOINT } from "../shared/constants";
import { logWarning } from "../shared/logger";

const LICENCE_STORAGE_KEY: string = "licenceState";

/**
 * Reads the licence state, creating it on first run and moving the clock
 * forward.
 *
 * WHY the write happens on every read: the high-water mark is the whole defence
 * against a clock set backwards, and a mark that is only saved when something
 * else happens to save it is a mark that does not exist on the run that
 * matters. It is one small object in chrome.storage.local, written a few times
 * a session.
 */
export async function readLicenceState(): Promise<LicenceState> {
  const nowMs: number = Date.now();
  const stored = await chrome.storage.local.get(LICENCE_STORAGE_KEY);
  const raw = stored[LICENCE_STORAGE_KEY] as LicenceState | undefined;

  const normalised: LicenceState = normaliseLicenceState(raw ?? null, nowMs);
  const advanced: LicenceState = advanceClock(normalised, nowMs);

  if (raw === undefined || advanced !== normalised || raw !== normalised) {
    await chrome.storage.local.set({ [LICENCE_STORAGE_KEY]: advanced });
  }

  return advanced;
}

/** Overwrites the stored state. */
export async function writeLicenceState(state: LicenceState): Promise<void> {
  await chrome.storage.local.set({ [LICENCE_STORAGE_KEY]: state });
}

/** Starts the trial if it has never been started. Safe to call repeatedly. */
export async function ensureTrialStarted(): Promise<LicenceState> {
  const state: LicenceState = await readLicenceState();
  if (state.firstRunAtMs > 0) {
    return state;
  }

  const fresh: LicenceState = createInitialLicenceState(Date.now());
  await writeLicenceState(fresh);
  return fresh;
}

/** What a verification attempt produced. */
export interface VerificationOutcome {
  accepted: boolean;
  message: string;
}

/**
 * Checks a licence key.
 *
 * TWO PATHS, and the difference is the whole security model:
 *
 *   - With LICENCE_VERIFY_ENDPOINT set, the key is checked by a server that
 *     the customer does not control. That is a real check.
 *
 *   - With it empty, the key is checked for SHAPE only, here, on the
 *     customer's machine. That is not a check, it is a formality, and the
 *     message says so rather than telling someone their key was "verified"
 *     when nothing verified anything.
 *
 * Saying which one happened is not optional. A product that reports a local
 * shape test as verification is lying to its own operator about how much
 * revenue it is protecting.
 */
export async function verifyLicenceKey(
  licenceKey: string,
): Promise<VerificationOutcome> {
  const trimmed: string = licenceKey.trim();

  if (trimmed === "") {
    return { accepted: false, message: "Enter a licence key first." };
  }

  if (LICENCE_VERIFY_ENDPOINT === "") {
    if (!looksLikeALicenceKey(trimmed)) {
      return {
        accepted: false,
        message: "That does not look like a licence key.",
      };
    }
    return {
      accepted: true,
      message:
        "Accepted on this machine. NOTE: no licence server is configured, so "
        + "this checked the key's shape and nothing else.",
    };
  }

  try {
    const response: Response = await fetch(LICENCE_VERIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenceKey: trimmed }),
    });

    if (!response.ok) {
      return {
        accepted: false,
        message: "The licence server answered " + String(response.status)
          + ". Try again, or contact support if it continues.",
      };
    }

    const body = await response.json() as { valid?: boolean; message?: string };
    if (body.valid === true) {
      return { accepted: true, message: body.message ?? "Licence verified." };
    }

    return {
      accepted: false,
      message: body.message ?? "That licence key was not accepted.",
    };
  } catch (verifyError: unknown) {
    logWarning("licence", "Could not reach the licence server.", verifyError);
    return {
      accepted: false,
      message:
        "Could not reach the licence server. Your trial and your recordings "
        + "are unaffected; try Verify again when you are back online.",
    };
  }
}

/**
 * A cheap shape test, used only when there is no server.
 *
 * Deliberately loose. Its only job is to reject an empty box or a pasted
 * sentence; it cannot and does not tell a real key from an invented one.
 */
export function looksLikeALicenceKey(candidate: string): boolean {
  if (candidate.length < 12) {
    return false;
  }
  if (candidate.indexOf(" ") !== -1) {
    return false;
  }
  return true;
}

/** Stores the result of a successful verification. */
export async function recordVerification(
  licenceKey: string,
  outcome: VerificationOutcome,
): Promise<LicenceState> {
  const state: LicenceState = await readLicenceState();

  const updated: LicenceState = {
    ...state,
    licenceKey: licenceKey.trim(),
    licenceVerifiedAtMs: outcome.accepted ? Date.now() : 0,
    lastVerificationMessage: outcome.message,
  };

  await writeLicenceState(updated);
  return updated;
}
