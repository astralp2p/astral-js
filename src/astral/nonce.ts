/**
 * Query nonces.
 *
 * On `astral.json.v1` a nonce is a 64-bit value in its JSON string form: 16
 * lowercase hex characters. Nonces pair a query with its response and identify
 * pending inbound queries.
 *
 * @module astral/nonce
 */

/** A 64-bit nonce in its wire string form (16-hex). */
export type Nonce = string & { readonly __brand: 'Nonce' };

/** The number of hex characters in a nonce (8 bytes). */
export const NONCE_HEX_LENGTH = 16;

const HEX_RE = /^[0-9a-f]{16}$/;

/** Generate a fresh random nonce (8 random bytes → 16 hex chars). */
export function newNonce(): Nonce {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as Nonce;
}

/** Validate and brand a nonce string. Throws if it is not 16 lowercase hex chars. */
export function parseNonce(s: string): Nonce {
  const lower = s.toLowerCase();
  if (!HEX_RE.test(lower)) throw new TypeError(`invalid nonce: ${JSON.stringify(s)}`);
  return lower as Nonce;
}
