// api/services/names — service-name lists as the `services` query argument.

import { MAX_NAMES } from './consts.js';

const MAX_NAME_BYTES = 255;

/**
 * Throw unless `name` is a valid service name: non-empty, no comma, no leading
 * or trailing whitespace, at most 255 UTF-8 bytes (it travels as a `string8`).
 */
export function validateName(name: string): void {
  if (name === '') throw new Error('empty service name');
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    throw new Error(`service name longer than ${MAX_NAME_BYTES} bytes`);
  }
  if (name.includes(',')) throw new Error(`service name "${name}" contains a comma`);
  if (name.trim() !== name) throw new Error(`service name "${name}" has surrounding whitespace`);
}

/**
 * Validate a service list and join it into the comma-separated `services`
 * argument. A list holds at least one name, at most {@link MAX_NAMES}, and no
 * name twice.
 */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) throw new Error('no service names');
  if (names.length > MAX_NAMES) throw new Error(`more than ${MAX_NAMES} service names`);
  const seen = new Set<string>();
  for (const name of names) {
    validateName(name);
    if (seen.has(name)) throw new Error(`service "${name}" named twice`);
    seen.add(name);
  }
  return names.join(',');
}
