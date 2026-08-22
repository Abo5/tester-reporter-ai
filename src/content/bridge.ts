// =============================================================================
// src/content/bridge.ts
// The window.postMessage protocol between the MAIN world and the ISOLATED
// world.
//
// WHY a bridge is needed at all: only a MAIN-world script can patch the page's
// own fetch and console, but a MAIN-world script has no chrome.runtime and
// therefore cannot talk to the service worker. The isolated content script is
// the only context that can do both.
// =============================================================================

import { BRIDGE_CHANNEL } from "../shared/constants";

export type BridgePayloadKind = "network" | "console" | "url-change";

export interface BridgeEnvelope {
  channel: string;
  payloadKind: BridgePayloadKind;
  payload: Record<string, unknown>;
}

/**
 * Sends one finding from the MAIN world to the isolated content script.
 *
 * WHY the target origin is "*": the page may be sandboxed or have an opaque
 * origin, in which case a specific target origin silently drops the message.
 * The payload contains no secrets beyond what the page already has, and the
 * receiver validates the channel name, so a wildcard target is safe here.
 */
export function postToBridge(
  payloadKind: BridgePayloadKind,
  payload: Record<string, unknown>,
): void {
  const envelope: BridgeEnvelope = {
    channel: BRIDGE_CHANNEL,
    payloadKind: payloadKind,
    payload: payload,
  };
  window.postMessage(envelope, "*");
}

/**
 * Narrows an incoming message event to one of our envelopes, or null.
 *
 * WHY the strict checks: every page on the internet posts messages to itself,
 * and a page under test may deliberately post hostile shapes. Nothing that
 * fails these checks reaches our handlers.
 */
export function readBridgeEnvelope(event: MessageEvent): BridgeEnvelope | null {
  if (event.source !== window) {
    return null;
  }
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const candidate = data as Partial<BridgeEnvelope>;
  if (candidate.channel !== BRIDGE_CHANNEL) {
    return null;
  }
  if (candidate.payloadKind !== "network"
      && candidate.payloadKind !== "console"
      && candidate.payloadKind !== "url-change") {
    return null;
  }
  if (typeof candidate.payload !== "object" || candidate.payload === null) {
    return null;
  }
  return candidate as BridgeEnvelope;
}

/**
 * Reads a string field out of an untrusted bridge payload.
 * WHY: the payload came through the page's own realm, so every field has to be
 * treated as attacker-controlled, not merely as possibly-missing.
 */
export function readStringField(
  payload: Record<string, unknown>,
  fieldName: string,
): string {
  const value: unknown = payload[fieldName];
  if (typeof value === "string") {
    return value;
  }
  return "";
}

/**
 * Reads a numeric field out of an untrusted bridge payload.
 */
export function readNumberField(
  payload: Record<string, unknown>,
  fieldName: string,
  fallback: number,
): number {
  const value: unknown = payload[fieldName];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}
