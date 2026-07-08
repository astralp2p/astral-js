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
import { eos, isError } from '../../astral/object.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

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
 * const key = await crypto.publicKey();                 // 'bip137:03ab…'
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
   * Derive the caller's public key in compact `<scheme>:<hex>` text form.
   *
   * Sends `crypto.public_key` (folding `scheme` into the query string when
   * given) and returns the single string result.
   *
   * DIVERGENCE — needs live-node confirmation. The Go op
   * (`op_public_key.go`) takes no query arguments and instead reads a streamed
   * `crypto.PrivateKey` object off the channel, replying with the derived
   * public key. The Python client (`crypto.py`) instead sends a plain
   * `crypto.public_key?scheme=…` query via `call_one`. This client follows the
   * Python `{scheme?}` query form; whether a live node honours the query-arg
   * `scheme` (versus expecting a streamed private-key object) has NOT been
   * confirmed against a running node and should be verified before release.
   *
   * @param opts.scheme The scheme to derive for; node default when omitted.
   * @returns The public key as `<scheme>:<hex>`.
   */
  async publicKey(opts: PublicKeyOptions = {}): Promise<string> {
    const value = await this.host.callOne(Ops.publicKey, {
      args: { scheme: opts.scheme },
    });
    return value as string;
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
    const value = await this.host.callOne(Ops.signText, {
      args: { text, key: opts.key, scheme: opts.scheme },
    });
    return value as string;
  }

  /**
   * Verify `sig` over `text` for the public key `key`.
   *
   * Sends `crypto.verify_text_signature` with `{ text, sig, key }`. The node
   * acks on a valid signature and streams an `error_message` on an invalid one
   * (Go `OpVerifyTextSignature`), so a resolved {@link Host.callOne} — whose
   * value is `null` for the ack — means valid, and a {@link RemoteError} thrown
   * for the streamed error means invalid. This matches the Python client's
   * "any non-error result is valid" reading, made explicit here by catching the
   * error object rather than propagating it.
   *
   * DIVERGENCE — needs live-node confirmation. The Go op
   * (`op_verify_text_signature.go`) reads the signature as a streamed
   * `crypto.Signature` object off the channel and silently ignores unknown query
   * args, so the `sig=` query-arg form used here (inherited from astral-py) is
   * unverified against a running node.
   *
   * @param text The text that was signed.
   * @param sig The signature (`<scheme>:<base64>`) to check.
   * @param key The signer's public key (`<scheme>:<key>`).
   * @returns `true` if the signature is valid, `false` otherwise.
   */
  async verifyTextSignature(text: string, sig: string, key: string): Promise<boolean> {
    try {
      await this.host.callOne(Ops.verifyTextSignature, {
        args: { text, sig, key },
      });
      return true;
    } catch (err) {
      if (err instanceof RemoteError) return false;
      throw err;
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
