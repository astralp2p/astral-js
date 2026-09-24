/**
 * Object ids.
 *
 * On `astral.json.v1` an object id is a string in the canonical `data1…` form:
 * the z-base-32 encoding of an 8-byte big-endian size followed by the 32-byte
 * sha256 digest of the object's content, with the encoder's leading zero
 * characters trimmed. This SDK decodes an id into that pair
 * ({@link decodeObjectID}) and encodes the pair back ({@link encodeObjectID}),
 * mirroring the reference `astral-go` `ParseID` / `ObjectID.String`; the node
 * remains the authority that produces and validates ids.
 *
 * A second input form, `data0…`, names an object by its digest with no size —
 * a partial object id, which a repository matches by digest alone. It is
 * accepted wherever an id is read and never produced: the two forms are not
 * symmetric, and every id this SDK emits is `data1`, a size of 0 included.
 * `.ai/system/primitive-types/object_id.sha256.md` specifies both.
 *
 * @module astral/objectid
 */

import { EncodingError } from './errors.js';

/** An object id in a wire string form (`data1…`, or `data0…` for a partial id). */
export type ObjectID = string & { readonly __brand: 'ObjectID' };

/** The canonical object-id string prefix. */
export const OBJECT_ID_PREFIX = 'data1';

/**
 * The prefix of a partial object id — one that names an object by digest alone.
 *
 * A partial id carries no size, so it decodes to a size of 0 and a repository
 * matches it by digest. It is an input form only: {@link encodeObjectID} emits
 * `data1` for every id, a size of 0 included.
 */
export const PARTIAL_OBJECT_ID_PREFIX = 'data0';

/** The z-base-32 alphabet the node encodes object ids with. */
const Z_BASE_32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/** The decoded payload length: an 8-byte size plus a 32-byte digest. */
const DECODED_LENGTH = 40;

/** The full encoded length: 40 bytes × 8 / 5 bits per character. */
const ENCODED_LENGTH = 64;

/**
 * The encoded length of a `data0` body: the last 52 of those 64 characters.
 *
 * The 12 dropped characters span bits 0–59, which are size bits alone, so a
 * zero size makes every one of them the alphabet's zero character. Unlike
 * `data1`, which trims whatever leading zero characters a value happens to
 * have, `data0` always drops exactly these 12 — so its width is fixed.
 */
const PARTIAL_ENCODED_LENGTH = 52;

/**
 * The characters a `data0` body may open with.
 *
 * Its first character spans bits 60–64: the last four size bits, which a
 * partial id has as zero, and the first digest bit. Only two of the 32
 * characters encode four leading zeros, and which one appears says nothing
 * beyond that first digest bit. Derived from the alphabet rather than written
 * out, so the two stay in step if the alphabet is ever restated.
 */
const PARTIAL_FIRST_CHARS = Z_BASE_32.slice(0, 2);

/**
 * Whether `s` looks like an object-id string, in either form.
 *
 * The bare prefix is the zero id and is valid: the encoder trims leading zero
 * characters, so a zero size and a zero digest encode to `data1` and nothing
 * more. Requiring a character after the prefix rejected the one string
 * {@link encodeObjectID} is guaranteed to produce, and rejects what a node
 * sends — `astral-go` emits `data1` for the zero id in JSON.
 *
 * A `data0` body is a fixed 52 characters rather than a maximum, because its
 * 12 dropped characters are always the same ones, and it must open on `y` or
 * `b`. The spec states both as acceptance rules, so both are checked here:
 * 30 of the 32 alphabet characters cannot open a partial body, and admitting
 * them would brand as an {@link ObjectID} a majority of `data0`-shaped strings
 * that {@link decodeObjectID} goes on to reject.
 *
 * This remains a shape check and not a decode. The one divergence left is the
 * alphabet, for both forms alike: a body of the right width holding characters
 * outside it passes here and is rejected by {@link decodeObjectID}.
 */
export function isObjectID(s: string): s is ObjectID {
  if (typeof s !== 'string') return false;
  if (s.startsWith(PARTIAL_OBJECT_ID_PREFIX)) {
    const enc = s.slice(PARTIAL_OBJECT_ID_PREFIX.length);
    return enc.length === PARTIAL_ENCODED_LENGTH && PARTIAL_FIRST_CHARS.includes(enc[0]!);
  }
  return s.startsWith(OBJECT_ID_PREFIX) && s.length <= OBJECT_ID_PREFIX.length + ENCODED_LENGTH;
}

/** Validate and brand an object-id string. Throws if it is neither form. */
export function parseObjectID(s: string): ObjectID {
  if (!isObjectID(s)) throw new TypeError(`invalid object id: ${JSON.stringify(s)}`);
  return s;
}

/** An object id decoded into its two fixed-width parts. */
export interface DecodedObjectID {
  /** The object's content size in bytes (a `uint64` on the wire). */
  size: bigint;
  /** The 32-byte sha256 digest of the object's content. */
  hash: Uint8Array;
}

/**
 * Decode an object id, in either form, into its size and digest.
 *
 * Mirrors `astral-go`'s `ParseID`: strip the prefix, left-pad the remainder
 * with the alphabet's zero character (`y`) to the encoder's 64-character
 * width — the encoder trims those on output, so a small size loses leading
 * characters — z-base-32-decode to 40 bytes, and split into the 8-byte
 * big-endian size and the 32-byte digest.
 *
 * A `data0` id decodes the same way and differs only in what is padded back:
 * its body is a fixed 52 characters, so the 12 restored characters are always
 * the size's, and the result carries a size of 0. The width is checked before
 * the pad, because a short body is a different digest rather than a smaller
 * number and padding one would invent an id.
 *
 * @param id The object id to decode (an {@link ObjectID} or its `data1…` or
 *   `data0…` string).
 * @returns The {@link DecodedObjectID} pair.
 * @throws {EncodingError} On a missing prefix, a character outside the
 *   z-base-32 alphabet, a `data1` encoding longer than 64 characters, or a
 *   `data0` body that is not 52 characters or does not open on `y` or `b`.
 */
export function decodeObjectID(id: ObjectID | string): DecodedObjectID {
  const partial = id.startsWith(PARTIAL_OBJECT_ID_PREFIX);
  if (!partial && !id.startsWith(OBJECT_ID_PREFIX)) throw new EncodingError('invalid prefix');
  const enc = id.slice(partial ? PARTIAL_OBJECT_ID_PREFIX.length : OBJECT_ID_PREFIX.length);
  if (partial) {
    if (enc.length !== PARTIAL_ENCODED_LENGTH) {
      throw new EncodingError('invalid partial data length');
    }
    const first = enc[0]!;
    if (!PARTIAL_FIRST_CHARS.includes(first)) {
      throw new EncodingError(`invalid partial object id first character ${JSON.stringify(first)}`);
    }
  } else if (enc.length > ENCODED_LENGTH) {
    throw new EncodingError('invalid data length');
  }
  const padded = Z_BASE_32[0]!.repeat(ENCODED_LENGTH - enc.length) + enc;

  const data = new Uint8Array(DECODED_LENGTH);
  let acc = 0; // bit accumulator, big-endian: 5 bits enter per character
  let bits = 0;
  let n = 0;
  for (const c of padded) {
    const v = Z_BASE_32.indexOf(c);
    if (v < 0) throw new EncodingError(`invalid character ${JSON.stringify(c)} in object id`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      data[n++] = (acc >> bits) & 0xff;
    }
  }

  const view = new DataView(data.buffer);
  const size = view.getBigUint64(0);
  if (partial && size !== 0n) {
    // Unreachable through the width and first-character checks above, and
    // asserted rather than assumed so a later change to either cannot admit a
    // `data0` string that carries a size.
    throw new EncodingError(`partial object id decoded a size: ${size}`);
  }
  return { size, hash: data.slice(8) };
}

/**
 * Encode a size/digest pair back to its canonical `data1…` id string.
 *
 * The inverse of {@link decodeObjectID}, mirroring `astral-go`'s
 * `ObjectID.String`: write the 8-byte big-endian size and the 32-byte digest,
 * z-base-32-encode the 40 bytes, trim the leading zero characters (`y`), and
 * prepend the prefix. A decoded id reproduces its own string.
 *
 * @param decoded The size (`bigint` or a safe non-negative `number`) and the
 *   32-byte digest.
 * @returns The canonical {@link ObjectID}.
 * @throws {EncodingError} On a digest that is not 32 bytes or a size outside
 *   the `uint64` range.
 */
export function encodeObjectID(decoded: { size: bigint | number; hash: Uint8Array }): ObjectID {
  const size = typeof decoded.size === 'bigint' ? decoded.size : BigInt(decoded.size);
  if (size < 0n || size >= 1n << 64n) throw new EncodingError(`size out of uint64 range: ${size}`);
  if (decoded.hash.length !== 32) {
    throw new EncodingError(`invalid hash length: ${decoded.hash.length}`);
  }

  const data = new Uint8Array(DECODED_LENGTH);
  new DataView(data.buffer).setBigUint64(0, size);
  data.set(decoded.hash, 8);

  let enc = '';
  let acc = 0; // bit accumulator, big-endian: 8 bits enter per byte, 5 leave per character
  let bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      enc += Z_BASE_32[(acc >> bits) & 0x1f]!;
    }
  }

  let start = 0;
  while (start < enc.length && enc[start] === Z_BASE_32[0]) start++;
  return (OBJECT_ID_PREFIX + enc.slice(start)) as ObjectID;
}
