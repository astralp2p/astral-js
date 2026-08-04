/**
 * Text encoding for query strings.
 *
 * apphost operations are addressed by a query string of the form
 * `op?key=value&key2=value2`. Each value is rendered to its bare text form and
 * URI-encoded; the whole string is capped at the width of the field that
 * carries it — see {@link MAX_QUERY_STRING}.
 *
 * @module astral/encoding
 */

import { EncodingError } from './errors.js';
import { ZoneDefault } from './zone.js';

/** Query arguments: a flat map of names to values. `null`/`undefined` are skipped. */
export type QueryArgs = Record<string, unknown>;

/**
 * The maximum length of a query string, in UTF-8 bytes.
 *
 * A query string reaches the node in one field of one message — `Query` of
 * `mod.apphost.route_query_msg` — and the spec declares that field `String16`
 * (`.ai/system/topics/astral-ipc.md`), so the wire carries 65535 bytes of it.
 * The cap here is that width and nothing narrower: a client-side limit below
 * the field's own only refuses queries the node would have answered.
 *
 * The distinction is not academic for ops whose arguments carry identities. An
 * identity is 66 characters, and an argument carrying a set joins it with a
 * comma, so an op naming one identity and a set of three is already past 255.
 */
export const MAX_QUERY_STRING = 65535;

/** The default zone applied to queries when none is given. */
export const DEFAULT_ZONE = ZoneDefault;

/**
 * Render a single argument value to its bare wire text form. Booleans render as
 * `'true'`/`'false'` (checked before numbers); numbers/bigints as decimal;
 * strings verbatim; `null`/`undefined` as the empty string.
 */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Assemble the query string for an operation and its arguments. Skips
 * `null`/`undefined` values, URI-encodes keys and values, appends with `?` or
 * `&` depending on whether `op` already has a query, and enforces
 * {@link MAX_QUERY_STRING} (throwing {@link EncodingError} when exceeded).
 */
export function buildQueryString(op: string, args?: QueryArgs): string {
  let result = op;
  if (args) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (value === null || value === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(toText(value))}`);
    }
    if (parts.length > 0) {
      result += (op.includes('?') ? '&' : '?') + parts.join('&');
    }
  }
  if (utf8ByteLength(result) > MAX_QUERY_STRING) {
    throw new EncodingError(`query string exceeds ${MAX_QUERY_STRING} bytes: ${op}`);
  }
  return result;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
