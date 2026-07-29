/**
 * Reading the `{ Type, Object }` JSON envelope strictly.
 *
 * The envelope is the only thing naming an object's type, and the spec fixes it
 * to exactly two keys ([JSON Encoding](../../.ai/system/topics/json-encoding.md)).
 * Reading it by property access instead ignored any key it did not recognise, so
 * a misspelled `Object` left the payload unread and produced a well-formed
 * object carrying nothing — `{ "Type": "…slice_spec", "Obejct": { "Type":
 * "uint32" } }` decoded to a heterogeneous slice rather than the `uint32` slice
 * meant. astral-go and astral-py carried the identical defect and reject the
 * same shapes now.
 *
 * This module lives apart from `object.ts` because `errors.ts` imports that
 * one; importing {@link EncodingError} there would close a runtime cycle.
 *
 * @module astral/envelope
 */

import { EncodingError } from './errors.js';
import type { WireEnvelope } from './object.js';

/** The container's two keys, folded — lookup is case-insensitive. */
const TYPE_KEY = 'type';
const OBJECT_KEY = 'object';

/**
 * Read a parsed JSON value as a {@link WireEnvelope}.
 *
 * Accepts the two keys under any casing and in any order. Rejects a key that is
 * neither, two keys whose names differ only in case, and a missing or empty
 * `Type`. A missing `Object` key is an absent payload — the spec treats it as
 * equivalent to an explicit `null`, and every SDK emits both keys regardless.
 *
 * @param value - a `JSON.parse` result, or any nested envelope value
 * @param what - what to call the container in an error message
 * @throws {EncodingError} if `value` is not a conforming envelope
 */
export function readEnvelope(value: unknown, what = 'envelope'): WireEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EncodingError(`invalid ${what}: ${JSON.stringify(value)}`);
  }

  let type: unknown;
  let object: unknown = null;
  let haveType = false;
  let haveObject = false;

  for (const [key, entry] of Object.entries(value)) {
    switch (key.toLowerCase()) {
      case TYPE_KEY:
        if (haveType) {
          throw new EncodingError(`${what} has two Type keys differing only in case`);
        }
        type = entry;
        haveType = true;
        break;
      case OBJECT_KEY:
        if (haveObject) {
          throw new EncodingError(`${what} has two Object keys differing only in case`);
        }
        object = entry;
        haveObject = true;
        break;
      default:
        throw new EncodingError(`unknown ${what} key: ${JSON.stringify(key)}`);
    }
  }

  if (typeof type !== 'string' || type === '') {
    throw new EncodingError(`${what} has no Type: ${JSON.stringify(value)}`);
  }

  return { Type: type, Object: object };
}
