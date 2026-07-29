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
 * @module astral/objectid
 */

import { EncodingError } from './errors.js';

/** An object id in its wire string form (`data1…`). */
export type ObjectID = string & { readonly __brand: 'ObjectID' };

/** The canonical object-id string prefix. */
export const OBJECT_ID_PREFIX = 'data1';

/** The z-base-32 alphabet the node encodes object ids with. */
const Z_BASE_32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/** The decoded payload length: an 8-byte size plus a 32-byte digest. */
const DECODED_LENGTH = 40;

/** The full encoded length: 40 bytes × 8 / 5 bits per character. */
const ENCODED_LENGTH = 64;

/** Whether `s` looks like a canonical object-id string. */
export function isObjectID(s: string): s is ObjectID {
  return (
    typeof s === 'string' &&
    s.startsWith(OBJECT_ID_PREFIX) &&
    s.length > OBJECT_ID_PREFIX.length &&
    s.length <= OBJECT_ID_PREFIX.length + ENCODED_LENGTH
  );
}

/** Validate and brand an object-id string. Throws if it is not a `data1…` id. */
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
 * Decode a `data1…` object id into its size and digest.
 *
 * Mirrors `astral-go`'s `ParseID`: strip the prefix, left-pad the remainder
 * with the alphabet's zero character (`y`) to the encoder's 64-character
 * width — the encoder trims those on output, so a small size loses leading
 * characters — z-base-32-decode to 40 bytes, and split into the 8-byte
 * big-endian size and the 32-byte digest.
 *
 * @param id The object id to decode (an {@link ObjectID} or its `data1…` string).
 * @returns The {@link DecodedObjectID} pair.
 * @throws {EncodingError} On a missing prefix, a character outside the
 *   z-base-32 alphabet, or an encoding longer than 64 characters.
 */
export function decodeObjectID(id: ObjectID | string): DecodedObjectID {
  if (!id.startsWith(OBJECT_ID_PREFIX)) throw new EncodingError('invalid prefix');
  const enc = id.slice(OBJECT_ID_PREFIX.length);
  if (enc.length > ENCODED_LENGTH) throw new EncodingError('invalid data length');
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
  return { size: view.getBigUint64(0), hash: data.slice(8) };
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
export function encodeObjectID(decoded: {
  size: bigint | number;
  hash: Uint8Array;
}): ObjectID {
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
