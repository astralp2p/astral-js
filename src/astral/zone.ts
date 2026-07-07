/**
 * Reachability zones.
 *
 * A zone is a subset of the letters `d` (device), `v` (virtual), and `n`
 * (network); the canonical order is `d`, `v`, `n`, and the default is all
 * three (`'dvn'`). On `astral.json.v1` a zone is this subset string.
 *
 * @module astral/zone
 */

/** A zone as its wire subset string (e.g. `'d'`, `'dv'`, `'dvn'`). */
export type Zone = string;

/** Device-local reachability. */
export const ZoneDevice = 'd';
/** Virtual (in-process/loopback) reachability. */
export const ZoneVirtual = 'v';
/** Network reachability. */
export const ZoneNetwork = 'n';
/** The default zone: all three (`'dvn'`). */
export const ZoneDefault = 'dvn';
/** Alias for {@link ZoneDefault}. */
export const ZoneAll = ZoneDefault;

/**
 * Canonicalize a zone string: keep only `d`/`v`/`n`, de-duplicate, and order
 * them `d`, `v`, `n`. An empty/invalid input yields `''`.
 */
export function parseZone(s: string): Zone {
  let out = '';
  for (const letter of [ZoneDevice, ZoneVirtual, ZoneNetwork]) {
    if (s.includes(letter)) out += letter;
  }
  return out;
}

/** Format a zone to its canonical string (alias of {@link parseZone}). */
export function formatZone(zone: string): Zone {
  return parseZone(zone);
}
