/**
 * Text encoding for query strings.
 *
 * apphost operations are addressed by a query string of the form
 * `op?key=value&key2=value2`. Each value is rendered to its bare text form and
 * URI-encoded; the whole string is capped at 255 bytes (UTF-8), matching the
 * node's limit.
 *
 * @module astral/encoding
 */

import { EncodingError } from './errors.js';
import { ZoneDefault } from './zone.js';

/** Query arguments: a flat map of names to values. `null`/`undefined` are skipped. */
export type QueryArgs = Record<string, unknown>;

/** The maximum length of a query string, in UTF-8 bytes. */
export const MAX_QUERY_STRING = 255;

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
 * `&` depending on whether `op` already has a query, and enforces the 255-byte
 * cap (throwing {@link EncodingError} when exceeded).
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
