// api/crypto — the crypto protocol client (signing / keys).
// Built on the apphost WebSocket client's query. Basic ops: publicKey,
// signText, verifyTextSignature. Populated by: dev/api-crypto.

/**
 * The `crypto` protocol client: public-key derivation, text signing, and
 * signature verification over `astral.json.v1`.
 *
 * Signatures and public keys travel in the compact text form
 * `<scheme>:<base64-or-hex>` (e.g. `bip137:…`), so the basic ops return and
 * accept plain strings — there is no per-scheme decoding here. The node holds
 * the private key material; this client only names the key/scheme.
 *
 * Grounded in the reference implementations:
 *   - Go: `mod/crypto/src/op_{public_key,sign_text,verify_text_signature}.go`
 *   - Python: `astral-py/.../protocols/crypto.py` (class `Crypto`)
 *
 * Only the BASIC ops are implemented; the hash-signing ops
 * (`crypto.sign_hash` / `crypto.verify_hash_signature`) are ADVANCED and out of
 * scope for this client.
 *
 * @module api/crypto
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { obj, eos, isAck, isError } from '../../astral/object.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

/** The astral type name of a signature object streamed to/from the crypto ops. */
const SIGNATURE_TYPE = 'mod.crypto.signature';
/** The key-type prefix of a secp256k1 public key; an astral Identity IS one. */
const SECP256K1 = 'secp256k1';

/** The wire shape of a `mod.crypto.signature` object (`{ Data, Scheme }`). */
interface SignatureValue {
  Data: string;
  Scheme: string;
}

/**
 * Split a compact `<scheme>:<base64>` signature into a `mod.crypto.signature`
 * object value. A missing scheme defaults to `bip137`.
 */
function parseSignature(sig: string): SignatureValue {
  const i = sig.indexOf(':');
  if (i < 0) return { Scheme: 'bip137', Data: sig };
  return { Scheme: sig.slice(0, i), Data: sig.slice(i + 1) };
}

/** Render a `mod.crypto.signature` object value to compact `<scheme>:<base64>`. */
function formatSignature(v: SignatureValue): string {
  return `${v.Scheme}:${v.Data}`;
}

/** Options for {@link Crypto.publicKey}. */
export interface PublicKeyOptions {
  /** The signature/key scheme to derive for (e.g. `'bip137'`). Node default when omitted. */
  scheme?: string;
}

/** Options for {@link Crypto.signText}. */
export interface SignTextOptions {
  /** A specific public key (compact `<scheme>:<key>` text) to sign under, instead of the caller's identity. */
  key?: string;
  /** The signature scheme (e.g. `'bip137'`). Node default when omitted. */
  scheme?: string;
}

/**
 * A client for the node's `crypto` protocol, bound to a connected {@link Host}.
 *
 * Each method wraps a single apphost query: it folds its arguments into the
 * query string and drives the request/response shape via {@link Host.callOne}.
 *
 * @example
 * ```ts
 * const crypto = new Crypto(host);
 * const key = await crypto.publicKey();                 // 'secp256k1:03ab…'
 * const sig = await crypto.signText('hello');           // 'bip137:H9f…'
 * const ok  = await crypto.verifyTextSignature('hello', sig, key); // true
 * ```
 */
export class Crypto {
  private readonly host: Host;

  /** Bind a crypto client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Return the acting identity's public key in compact `<scheme>:<hex>` text
   * form (e.g. `secp256k1:03ab…`) — the key `signText` signs under by default,
   * and the key that verifies those signatures.
   *
   * This is a LOCAL derivation, not a node round-trip: on astral a secp256k1
   * public key IS the identity (a 33-byte compressed point rendered as 66 hex),
   * so the caller's public key is `secp256k1:<acting identity>`. The node's
   * `crypto.public_key` op does NOT derive "my" key from a query arg — it reads
   * a streamed `mod.crypto.private_key` and returns that key's public half
   * (see {@link Crypto.publicKeyOf}); calling it with only args hangs the node,
   * so the caller-key case is answered here without a query.
   *
   * @param opts.scheme Reserved; secp256k1 is the only key type an apphost
   *   identity carries, so the returned prefix is always `secp256k1`.
   * @returns The acting identity's public key as `secp256k1:<hex>`.
   */
  async publicKey(opts: PublicKeyOptions = {}): Promise<string> {
    void opts; // scheme is reserved; an apphost identity is always a secp256k1 key
    const id = this.host.guestID ?? this.host.identity;
    if (!id) throw new ProtocolError('no acting identity to derive a public key from');
    return `${SECP256K1}:${id}`;
  }

  /**
   * Sign `text` with a node-held key and return the compact signature
   * `<scheme>:<base64>`.
   *
   * Sends `crypto.sign_text` with `text` and, when given, `key` / `scheme`
   * folded into the query string. Signs under the caller's identity unless
   * `opts.key` names a specific public key. Mirrors Go `OpSignText`
   * (default scheme `bip137`) and Python `Crypto.sign_text`.
   *
   * @param text The text to sign.
   * @param opts.key A specific public key (`<scheme>:<key>`) to sign under.
   * @param opts.scheme The signature scheme; node default (`bip137`) when omitted.
   * @returns The signature as `<scheme>:<base64>`.
   */
  async signText(text: string, opts: SignTextOptions = {}): Promise<string> {
    // The node replies with a `mod.crypto.signature` object `{ Data, Scheme }`
    // (text/key/scheme travel as query args). Render it to compact text.
    const value = await this.host.callOne(Ops.signText, {
      args: { text, key: opts.key, scheme: opts.scheme },
    });
    if (typeof value === 'string') return value; // tolerate an already-compact reply
    return formatSignature(value as SignatureValue);
  }

  /**
   * Verify `sig` over `text` for the public key `key`.
   *
   * The node op (`op_verify_text_signature.go`) `AcceptRaw()`s and reads the
   * signature as a **streamed** `mod.crypto.signature` object — there is no
   * `sig` query arg — so this opens the query with `{ text, key }` as args,
   * streams the parsed signature object followed by `eos`, then reads the reply:
   * an `ack` means valid, an `error_message` means invalid. (A prior version
   * folded `sig` into the query string and streamed nothing, which hung the node
   * forever while it waited for the signature object.)
   *
   * @param text The text that was signed.
   * @param sig The signature (`<scheme>:<base64>`) to check.
   * @param key The signer's public key (`<scheme>:<key>`).
   * @returns `true` if the signature is valid, `false` otherwise.
   */
  async verifyTextSignature(text: string, sig: string, key: string): Promise<boolean> {
    const stream = await this.host.query(Ops.verifyTextSignature, { args: { text, key } });
    try {
      stream.send(obj(SIGNATURE_TYPE, parseSignature(sig)));
      stream.send(eos());
      for await (const o of stream) {
        if (isError(o)) return false; // node streams an error_message on an invalid signature
        if (isAck(o)) return true; // ack means the signature verified
      }
      return false; // stream ended without an ack — treat as not verified
    } finally {
      stream.close();
    }
  }

  /**
   * Derive the public key of a specific `privateKey` object.
   *
   * The Go op's NATIVE form: `op_public_key.go` reads a streamed private-key
   * object off the channel and replies with its public key. Opens
   * `crypto.public_key` with no arguments, *streams* `privateKey`
   * (`mod.crypto.private_key`) followed by `eos`, then reads the single reply
   * — the public-key object — returned verbatim as an {@link AstralObject}
   * (its `value` carries the key material; the JSON `Key` encoding is the
   * node's). Exercised end-to-end by the settings app's setup ceremony
   * (mnemonic → seed → derive_key → public_key), unlike the query-arg
   * {@link Crypto.publicKey} form above, whose live behavior is unconfirmed.
   *
   * A wrong input type or a derivation failure streams an `error_message`,
   * surfaced as a {@link RemoteError}; an empty reply rejects with a
   * {@link ProtocolError}.
   *
   * @param privateKey The `mod.crypto.private_key` object to derive from.
   * @returns The public-key {@link AstralObject}.
   */
  async publicKeyOf(privateKey: AstralObject): Promise<AstralObject> {
    const stream = await this.host.query(Ops.publicKey);
    try {
      stream.send(privateKey);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        return o;
      }
      throw new ProtocolError('crypto.public_key returned no public key');
    } finally {
      stream.close();
    }
  }
}
