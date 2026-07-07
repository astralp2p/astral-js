/**
 * Node identities.
 *
 * On `astral.json.v1` an identity is its JSON string form: 66 lowercase hex
 * characters (a 33-byte compressed secp256k1 public key), or the literal
 * `'anyone'` for the zero/anonymous identity. This SDK treats identities as
 * opaque strings — the node validates the key material — so there is no
 * secp256k1 math here.
 *
 * @module astral/identity
 */

/** A node identity in its wire string form (66-hex or `'anyone'`). */
export type Identity = string & { readonly __brand: 'Identity' };

/** The number of hex characters in a full identity (33 bytes). */
export const IDENTITY_HEX_LENGTH = 66;

/** The JSON literal for the zero/anonymous identity. */
export const ANYONE = 'anyone';

/** The all-zero identity key (66 hex zeros), the other accepted form of `anyone`. */
export const ANYONE_KEY = '0'.repeat(IDENTITY_HEX_LENGTH);

/** The zero/anonymous identity sentinel. */
export const Anyone = ANYONE as Identity;

const HEX_RE = /^[0-9a-f]+$/;

/**
 * Parse and normalize an identity string. Accepts 66-hex, the all-zero key, or
 * `'anyone'`; the latter two normalize to {@link Anyone}. Throws on any other shape.
 */
export function parseIdentity(s: string): Identity {
  if (s === ANYONE || s === ANYONE_KEY) return Anyone;
  const lower = s.toLowerCase();
  if (lower.length !== IDENTITY_HEX_LENGTH || !HEX_RE.test(lower)) {
    throw new TypeError(`invalid identity: ${JSON.stringify(s)}`);
  }
  return lower as Identity;
}

/** Whether `id` is the zero/anonymous identity. */
export function isAnyone(id: Identity | string): boolean {
  return id === ANYONE || id === ANYONE_KEY;
}

/** A short `xxxxxxxx:xxxxxxxx` fingerprint of an identity, for logs/UX. */
export function fingerprint(id: Identity | string): string {
  if (isAnyone(id)) return ANYONE;
  const hex = id.toLowerCase();
  return `${hex.slice(0, 8)}:${hex.slice(-8)}`;
}
