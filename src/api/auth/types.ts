// api/auth/types — the JSON value of a mod.auth.permit and its constraints bundle.

import type { WireEnvelope } from '../../astral/object.js';

/** Wire type tag of a permit. */
export const PERMIT_TYPE = 'mod.auth.permit';

/**
 * A bundle as JSON: an array of `{ Type, Object }` envelopes (astral-go
 * `astral.Bundle` `MarshalJSON`).
 */
export type BundleValue = WireEnvelope[];

/**
 * The JSON value of a `mod.auth.permit`: a flat object keyed by the Go field
 * names (astral-go `api/auth/contract.go`).
 */
export interface PermitValue {
  /** The action type the permit authorizes, e.g. `mod.auth.see_objects_action`. */
  Action: string;
  /** The constraints that narrow the permit; `null` when it has none. */
  Constraints: BundleValue | null;
  /** How many times the permit may be delegated further (Go `Uint8`). */
  Delegation: number;
}

/** A permit, or an action name standing for a permit without constraints. */
export type PermitInput = string | PermitValue;

/**
 * Build a permit for `action`, narrowed by `constraints` when given.
 *
 * @throws {TypeError} On an empty action, a malformed constraints bundle or a
 *   delegation outside 0–255.
 */
export function permit(
  action: string,
  constraints: BundleValue | null = null,
  opts: { delegation?: number } = {},
): PermitValue {
  return toPermit({ Action: action, Constraints: constraints, Delegation: opts.delegation ?? 0 });
}

/**
 * Check a {@link PermitInput} and return it as a fresh {@link PermitValue}
 * holding exactly `Action`, `Constraints` and `Delegation`.
 *
 * A string is an action without constraints. Absent or empty constraints become
 * `null`, the form astral-go marshals a bundle without objects to; an absent
 * delegation becomes `0`. Whether an action needs constraints is for the node
 * to judge.
 *
 * @throws {TypeError} On an empty action, a constraints value that is not an
 *   array of `{ Type, Object }` envelopes, or a delegation that is not an
 *   integer from 0 to 255.
 */
export function toPermit(p: PermitInput): PermitValue {
  if (typeof p === 'string') {
    if (p === '') throw new TypeError('empty permit action');
    return { Action: p, Constraints: null, Delegation: 0 };
  }
  if (typeof p !== 'object' || p === null) throw new TypeError('permit is not an object');

  const { Action, Constraints, Delegation } = p as Partial<PermitValue>;
  if (typeof Action !== 'string' || Action === '') {
    throw new TypeError('permit Action is not a non-empty string');
  }
  if (Constraints !== null && Constraints !== undefined) {
    if (!Array.isArray(Constraints)) {
      throw new TypeError(`permit ${Action}: Constraints is not an array`);
    }
    for (const c of Constraints as unknown[]) {
      const env = c as WireEnvelope | null;
      if (
        typeof env !== 'object' ||
        env === null ||
        typeof env.Type !== 'string' ||
        env.Type === ''
      ) {
        throw new TypeError(`permit ${Action}: a constraint is not a { Type, Object } envelope`);
      }
    }
  }
  if (
    Delegation !== undefined &&
    (!Number.isInteger(Delegation) || Delegation < 0 || Delegation > 255)
  ) {
    throw new TypeError(`permit ${Action}: Delegation is not an integer from 0 to 255`);
  }

  return {
    Action,
    Constraints: Constraints && Constraints.length > 0 ? Constraints : null,
    Delegation: Delegation ?? 0,
  };
}
