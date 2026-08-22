// =============================================================================
// src/shared/ids.ts
// Unique ids that work on insecure origins.
//
// WHY this file exists: crypto.randomUUID() is defined as [SecureContext] in
// the Web Crypto spec, so it is UNDEFINED on an http:// page. Staging
// environments are routinely served over plain http, and a content script
// shares the page's secure-context status — so calling crypto.randomUUID()
// directly would throw a TypeError on exactly the sites this extension exists
// to test.
//
// crypto.getRandomValues() carries no such restriction and is available
// everywhere, so the fallback is still cryptographically random; it is just
// assembled by hand.
// =============================================================================

/** Hex digits, indexed by nibble. */
const HEX_DIGITS: string = "0123456789abcdef";

/**
 * Formats 16 random bytes as an RFC 4122 version 4 UUID string.
 */
function formatUuidFromBytes(bytes: Uint8Array): string {
  // Set the version (4) and variant (10xx) bits, as the UUID format requires.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex: string = "";
  for (let index = 0; index < bytes.length; index = index + 1) {
    const byte: number = bytes[index];
    hex = hex + HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 0x0f);
  }

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Returns a unique id, on secure and insecure origins alike.
 *
 * Every id in this extension goes through here. Never call crypto.randomUUID()
 * directly: it works in the service worker and in extension pages, and then
 * throws in a content script on the one http:// staging site the team uses.
 */
export function createId(): string {
  const cryptoObject: Crypto | undefined =
    typeof crypto === "undefined" ? undefined : crypto;

  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    try {
      return cryptoObject.randomUUID();
    } catch (secureContextError: unknown) {
      // Falls through to getRandomValues below.
    }
  }

  if (cryptoObject !== undefined
      && typeof cryptoObject.getRandomValues === "function") {
    const bytes: Uint8Array = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    return formatUuidFromBytes(bytes);
  }

  // Last resort. Not cryptographic, but an id collision here only mislabels one
  // artifact within one session, and refusing to record would be far worse.
  let fallback: string = "id-" + String(Date.now()) + "-";
  for (let index = 0; index < 16; index = index + 1) {
    fallback = fallback + HEX_DIGITS.charAt(Math.floor(Math.random() * 16));
  }
  return fallback;
}
