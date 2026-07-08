// api/bip137sig — the bip137sig protocol client (BIP-39 key ceremony).
// Built on the apphost WebSocket client's query. Basic ops: newEntropy,
// mnemonic, seed, deriveKey. Populated by: dev/api-settings-app.

/**
 * The `bip137sig` protocol client: the BIP-39 key ceremony — fresh entropy, the
 * mnemonic phrase, the seed, and BIP-32 key derivation. All key material is
 * generated and held NODE-SIDE; this client only relays the ceremony's objects
 * between ops (entropy → mnemonic → seed → private key), so chaining steps
 * never requires decoding them.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `bip137sig.*`
 * operations exactly as the reference node serves them. Grounded in the
 * protocol spec and the astrald server ops:
 *   - Spec: `astral-docs .../protocols/bip137sig/ops/bip137sig.{new_entropy,
 *     mnemonic,seed,derive_key}.md`.
 *   - astrald server ops: `mod/bip137sig/src/` (the four op handlers).
 *
 * Three of the four ops read their payload as a STREAMED object (not a query
 * arg): open the query, stream the input object, send `eos`, then read the
 * single reply. Unlike `tree.set` (which drains input until `eos`), each of
 * these server ops reads exactly ONE object (`ch.Receive()`, per
 * `op_{mnemonic,seed,derive_key}.go`) and answers a wrong input type with an
 * `error_message`; the trailing `eos` is the end-of-input idiom and is simply
 * never read. The ceremony objects (`bip137sig.entropy`, `bip137sig.seed`,
 * `mod.crypto.private_key`) pass through as raw {@link AstralObject}s — their
 * byte payloads stay in the node's JSON form (hex for entropy/seed, base64
 * for the key), and this client imposes no schema on them.
 *
 * @module api/bip137sig
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { ObjectTypes, eos, isError } from '../../astral/object.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

/**
 * BIP-39 entropy (`bip137sig.entropy`) as a pass-through {@link AstralObject}.
 * Its `value` is the entropy bytes as a hex string (the Go `Entropy` marshals
 * text/JSON as hex).
 */
export type Entropy = AstralObject;

/**
 * A BIP-39 seed (`bip137sig.seed`) as a pass-through {@link AstralObject}.
 * Its `value` is the 64 seed bytes as a hex string (the Go `Seed` marshals
 * text/JSON as hex).
 */
export type Seed = AstralObject;

/**
 * A derived private key as a pass-through {@link AstralObject}. Its wire tag
 * is `mod.crypto.private_key` (the Go `crypto.PrivateKey`'s `ObjectType()`;
 * the spec's example shows `crypto.private_key` — a doc gap). Its `value`
 * carries the Go struct's JSON shape: `Type` — the scheme, `"secp256k1"` —
 * and `Key` — the raw 32 key bytes as base64 (`astral.Bytes16` marshals JSON
 * as base64, not hex).
 */
export type PrivateKey = AstralObject;

/** Options for {@link Bip137sig.newEntropy}. */
export interface NewEntropyOptions {
  /**
   * Entropy size in bits — one of `128`, `160`, `192`, `224`, `256` (→ 12, 15,
   * 18, 21, 24 mnemonic words). Node default (`128`) when omitted.
   */
  bits?: number;
}

/** Options for {@link Bip137sig.seed}. */
export interface SeedOptions {
  /** The optional BIP-39 passphrase ("25th word"). Empty when omitted. */
  passphrase?: string;
}

/** Options for {@link Bip137sig.deriveKey}. */
export interface DeriveKeyOptions {
  /**
   * BIP-32 derivation path, e.g. `m/44'/0'/0'/0/0`. The leading `m/` is
   * optional; hardened indices may use `'` or `h`. An empty/omitted path (or
   * `m`) returns the master key. NOTE — the server arg (`op_derive_key.go`)
   * lacks the `optional` tag, yet an omitted path resolves to the master key
   * on a live node (exercised by the settings-app setup ceremony); this
   * client therefore folds `path` only when given.
   */
  path?: string;
}

/**
 * A client for the node's `bip137sig` protocol, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const bip = new Bip137sig(host);
 *
 * // New identity: entropy → mnemonic (for the user to back up).
 * const entropy = await bip.newEntropy({ bits: 256 });
 * const words = (await bip.mnemonic(entropy)).split(' ');
 *
 * // New or restored: mnemonic → seed → private key.
 * const seed = await bip.seed(words.join(' '));
 * const key = await bip.deriveKey(seed);            // master key
 * ```
 */
export class Bip137sig {
  private readonly host: Host;

  /** Bind a `bip137sig` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Generate fresh random entropy for a BIP-39 mnemonic.
   *
   * Sends `bip137sig.new_entropy` (folding `bits` into the query string when
   * given) and returns the node's single result — a `bip137sig.entropy` object
   * — verbatim. An invalid `bits` or an RNG failure streams an
   * `error_message`, surfaced as a {@link RemoteError} by {@link Host.call}.
   *
   * @param opts.bits Entropy size in bits (`128`–`256` in 32-bit steps).
   * @returns The fresh `bip137sig.entropy` {@link AstralObject}.
   */
  async newEntropy(opts: NewEntropyOptions = {}): Promise<Entropy> {
    const objs = await this.host.call(Ops.newEntropy, {
      args: { bits: opts.bits !== undefined ? String(opts.bits) : undefined },
    });
    if (objs.length === 0) {
      throw new ProtocolError('bip137sig.new_entropy returned no entropy');
    }
    return objs[0]!;
  }

  /**
   * Convert `entropy` into a BIP-39 mnemonic phrase.
   *
   * Opens `bip137sig.mnemonic`, *streams* the `entropy` object followed by
   * `eos`, then reads the single reply: a `string16` holding the words joined
   * by single spaces (12–24 words by entropy size; the checksum word is
   * appended by the node). An invalid entropy size streams an `error_message`,
   * surfaced as a {@link RemoteError}.
   *
   * @param entropy The `bip137sig.entropy` object to encode.
   * @returns The mnemonic phrase (words joined by single spaces).
   */
  async mnemonic(entropy: Entropy): Promise<string> {
    const reply = await this.sendAndReadOne(Ops.mnemonic, [entropy]);
    return String(reply.value);
  }

  /**
   * Convert a BIP-39 mnemonic phrase into its 64-byte seed.
   *
   * Opens `bip137sig.seed` (folding `passphrase` into the query string when
   * given), *streams* the phrase as a `string16` object followed by `eos`, then
   * reads the single reply — a `bip137sig.seed` object — returned verbatim.
   * The node validates the phrase first: a wrong word count, an unknown word,
   * or a checksum mismatch streams an `error_message`, surfaced as a
   * {@link RemoteError}.
   *
   * @param phrase The mnemonic words separated by whitespace.
   * @param opts.passphrase The optional BIP-39 passphrase ("25th word").
   * @returns The `bip137sig.seed` {@link AstralObject}.
   */
  async seed(phrase: string, opts: SeedOptions = {}): Promise<Seed> {
    return this.sendAndReadOne(Ops.seed, [{ type: ObjectTypes.String16, value: phrase }], {
      passphrase: opts.passphrase,
    });
  }

  /**
   * Derive a `secp256k1` private key from `seed` along a BIP-32 path.
   *
   * Opens `bip137sig.derive_key` (folding `path` into the query string when
   * given), *streams* the `seed` object followed by `eos`, then reads the
   * single reply — a `mod.crypto.private_key` object — returned verbatim. The node
   * treats the seed as the root for BIP-32 master-key derivation on Bitcoin
   * MainNet parameters; an omitted path returns the master key. A malformed
   * path or a derivation failure streams an `error_message`, surfaced as a
   * {@link RemoteError}.
   *
   * @param seed The `bip137sig.seed` object to derive from.
   * @param opts.path The BIP-32 derivation path; master key when omitted.
   * @returns The `crypto.private_key` {@link AstralObject}.
   */
  async deriveKey(seed: Seed, opts: DeriveKeyOptions = {}): Promise<PrivateKey> {
    return this.sendAndReadOne(Ops.deriveKey, [seed], { path: opts.path });
  }

  /**
   * The shared streamed-input request/response shape: open `op` (with `args`
   * folded into the query string), stream `inputs` then `eos`, and return the
   * first non-error reply. A streamed `error_message` rejects with a
   * {@link RemoteError}; an empty reply rejects with a {@link ProtocolError}.
   */
  private async sendAndReadOne(
    op: string,
    inputs: AstralObject[],
    args?: Record<string, string | undefined>,
  ): Promise<AstralObject> {
    const stream = await this.host.query(op, args ? { args } : {});
    try {
      for (const input of inputs) stream.send(input);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        return o;
      }
      throw new ProtocolError(`${op} returned no result`);
    } finally {
      stream.close();
    }
  }
}
