// =============================================================================
// src/ai/credentials.ts
// Where the Gemini credential comes from, now that the tester does not supply
// one.
// =============================================================================

import {
  BUILT_IN_GEMINI_API_KEY,
  GEMINI_PROXY_ENDPOINT,
} from "../shared/constants";

/** How this build talks to the model. */
export type CredentialMode = "proxy" | "built-in-key" | "unconfigured";

/**
 * Which of the two routes this build uses.
 *
 * The proxy wins when both are set, because it is the one that does not put a
 * key on the customer's disk. A build with both configured is almost certainly
 * mid-migration, and migrating towards the safer route is the right default.
 */
export function readCredentialMode(): CredentialMode {
  if (GEMINI_PROXY_ENDPOINT.trim() !== "") {
    return "proxy";
  }
  if (BUILT_IN_GEMINI_API_KEY.trim() !== "") {
    return "built-in-key";
  }
  return "unconfigured";
}

/**
 * What to tell a tester when no route is configured.
 *
 * WHY it is worded for the TESTER and not the developer: they are the one
 * looking at it, they did not build it, and "set BUILT_IN_GEMINI_API_KEY" tells
 * them nothing they can act on. It says what they still have, which is most of
 * the product.
 */
export const UNCONFIGURED_MESSAGE: string =
  "This build has no AI access configured, so the written report is "
  + "unavailable. Your video, your Playwright script and the plain report are "
  + "unaffected. Contact whoever gave you this extension.";
