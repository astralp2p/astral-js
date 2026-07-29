// api/crypto/consts — apphost op strings for the crypto protocol, one source of truth.

/** The `crypto.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  publicKey: 'crypto.public_key',
  signText: 'crypto.sign_text',
  verifyTextSignature: 'crypto.verify_text_signature',
  signHash: 'crypto.sign_hash',
  verifyHashSignature: 'crypto.verify_hash_signature',
} as const;
