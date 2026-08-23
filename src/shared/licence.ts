// =============================================================================
// src/shared/licence.ts
//
// The 14-day trial, and what happens after it.
//
// READ THIS BEFORE TRUSTING IT.
//
// Everything in this file runs on the customer's machine, inside an extension
// whose source they can read and edit. A trial enforced here is a SPEED BUMP,
// not a lock. Someone who wants to bypass it can clear the extension's storage,
// edit dist/ and reload the unpacked extension, or install a fresh profile. No
// amount of obfuscation changes that, and pretending otherwise in code comments
// is how a product ends up with a security model nobody can reason about.
//
// What this layer DOES achieve, which is worth having:
//   - an honest customer knows exactly where they stand and when to pay;
//   - the trial cannot be extended by accident (a clock set backwards, a
//     re-install on the same profile, a settings reset);
//   - the paid state is a signed token the extension can check, so the moment a
//     licence server exists the enforcement becomes real without touching the
//     UI, the storage shape, or anything else here.
//
// The one thing that makes it real is LICENCE_VERIFY_ENDPOINT. Until that is
// set, verification is local and the honest description of this product is
// "trial with a payment request", not "licensed software". Section 24 of
// PLAN.md sets out the server contract.
// =============================================================================

import { TRIAL_DAYS } from "./constants";

/** Where the customer stands right now. */
export type LicenceStatus =
  | "trial-active"
  | "trial-expired"
  | "licensed"
  | "licence-invalid";

/** Everything persisted about the trial and the licence. */
export interface LicenceState {
  /** Epoch ms of the first run. 0 until the extension has run once. */
  firstRunAtMs: number;
  /**
   * The furthest point in time this installation has ever seen.
   *
   * WHY it is stored: a trial measured only against Date.now() is reset by
   * setting the system clock back, which is the first thing anyone tries. The
   * high-water mark cannot go backwards, so the trial cannot either.
   */
  highWaterMarkMs: number;
  /** The licence key the customer entered, or "". */
  licenceKey: string;
  /** Epoch ms the key was last verified successfully. 0 if never. */
  licenceVerifiedAtMs: number;
  /** What the last verification said, for the UI to show. */
  lastVerificationMessage: string;
}

/** A fresh installation. */
export function createInitialLicenceState(nowMs: number): LicenceState {
  return {
    firstRunAtMs: nowMs,
    highWaterMarkMs: nowMs,
    licenceKey: "",
    licenceVerifiedAtMs: 0,
    lastVerificationMessage: "",
  };
}

/**
 * Moves the high-water mark forward, never back.
 *
 * WHAT: returns the state with the latest time this installation has observed.
 * WHY: see highWaterMarkMs. Winding the clock back now buys nothing, because
 * the trial is measured against the furthest point ever seen rather than
 * against the present.
 */
export function advanceClock(state: LicenceState, nowMs: number): LicenceState {
  if (nowMs <= state.highWaterMarkMs) {
    return state;
  }

  return { ...state, highWaterMarkMs: nowMs };
}

/** Whole days used of the trial, counted from the high-water mark. */
export function trialDaysUsed(state: LicenceState): number {
  if (state.firstRunAtMs === 0) {
    return 0;
  }

  const elapsedMs: number = state.highWaterMarkMs - state.firstRunAtMs;
  if (elapsedMs <= 0) {
    return 0;
  }

  return Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
}

/** Whole days left, never negative. */
export function trialDaysRemaining(state: LicenceState): number {
  const remaining: number = TRIAL_DAYS - trialDaysUsed(state);
  if (remaining < 0) {
    return 0;
  }
  return remaining;
}

/**
 * Where the customer stands.
 *
 * A verified licence wins over everything: a paying customer whose trial ran
 * out months ago is licensed, not expired.
 */
export function readLicenceStatus(state: LicenceState): LicenceStatus {
  if (state.licenceKey !== "" && state.licenceVerifiedAtMs > 0) {
    return "licensed";
  }
  if (state.licenceKey !== "" && state.licenceVerifiedAtMs === 0) {
    return "licence-invalid";
  }
  if (trialDaysRemaining(state) > 0) {
    return "trial-active";
  }
  return "trial-expired";
}

/**
 * What the customer is told, in one sentence.
 *
 * WHY the wording matters more than it looks: this is the only thing most
 * customers will ever read about the licence, and a sentence that hides the
 * deadline until the last day is a sentence that loses the sale AND annoys the
 * customer. It says the number every time.
 */
export function describeLicenceStatus(state: LicenceState): string {
  const status: LicenceStatus = readLicenceStatus(state);

  if (status === "licensed") {
    return "Licensed. Thank you.";
  }
  if (status === "licence-invalid") {
    return "That licence key has not been verified yet. Check it, or use "
      + "Verify again if you were offline when you entered it.";
  }
  if (status === "trial-expired") {
    return "Your " + String(TRIAL_DAYS) + "-day trial has ended. Recording and "
      + "the Playwright script still work; the AI report needs a licence.";
  }

  const remaining: number = trialDaysRemaining(state);
  if (remaining === 1) {
    return "Last day of your trial.";
  }
  return String(remaining) + " days left in your trial.";
}

/**
 * Whether the AI report may be generated.
 *
 * WHAT IS AND IS NOT GATED, deliberately: recording, the video and the
 * generated Playwright script keep working forever. Only the AI report - the
 * part that costs the customer's own Gemini quota AND is the reason to buy - is
 * behind the licence.
 *
 * WHY not gate everything: a tester whose trial ends mid-session would lose the
 * recording they had already made, which is a way of making someone angry
 * rather than making a sale. They keep their work; they just cannot get the
 * written report until they pay.
 */
export function mayGenerateReport(state: LicenceState): boolean {
  const status: LicenceStatus = readLicenceStatus(state);
  return status === "trial-active" || status === "licensed";
}

/**
 * Fills in fields an older version did not store.
 *
 * Same reason as normaliseSession: undefined is not 0, and a guard written
 * against 0 passes on undefined. See PLAN.md 19.t for what that cost once.
 */
export function normaliseLicenceState(
  stored: LicenceState | null,
  nowMs: number,
): LicenceState {
  if (stored === null || typeof stored !== "object") {
    return createInitialLicenceState(nowMs);
  }

  const state: LicenceState = { ...stored };

  if (typeof state.firstRunAtMs !== "number" || state.firstRunAtMs <= 0) {
    state.firstRunAtMs = nowMs;
  }
  if (typeof state.highWaterMarkMs !== "number"
      || state.highWaterMarkMs < state.firstRunAtMs) {
    state.highWaterMarkMs = state.firstRunAtMs;
  }
  if (typeof state.licenceKey !== "string") {
    state.licenceKey = "";
  }
  if (typeof state.licenceVerifiedAtMs !== "number") {
    state.licenceVerifiedAtMs = 0;
  }
  if (typeof state.lastVerificationMessage !== "string") {
    state.lastVerificationMessage = "";
  }

  return state;
}
