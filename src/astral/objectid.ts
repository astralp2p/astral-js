/**
 * Object ids.
 *
 * On `astral.json.v1` an object id is an opaque string in the canonical
 * `data1…` form. This SDK carries it as an opaque string and does no decoding,
 * zBase32, or hashing — the node produces and validates ids. Validation here is
 * limited to the recognizable prefix and a sane length.
 *
 * @module astral/objectid
 */

/** An object id in its wire string form (`data1…`). */
export type ObjectID = string & { readonly __brand: 'ObjectID' };

/** The canonical object-id string prefix. */
export const OBJECT_ID_PREFIX = 'data1';

/** Whether `s` looks like a canonical object-id string. */
export function isObjectID(s: string): s is ObjectID {
  return (
    typeof s === 'string' &&
    s.startsWith(OBJECT_ID_PREFIX) &&
    s.length > OBJECT_ID_PREFIX.length &&
    s.length <= OBJECT_ID_PREFIX.length + 64
  );
}

/** Validate and brand an object-id string. Throws if it is not a `data1…` id. */
export function parseObjectID(s: string): ObjectID {
  if (!isObjectID(s)) throw new TypeError(`invalid object id: ${JSON.stringify(s)}`);
  return s;
}
