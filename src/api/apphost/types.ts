// api/apphost/types — the JSON values of the apphost protocol objects.
//
// Spec: .ai/system/protocols/apphost/types/. Field names are the Go struct's
// exported names (astral-go api/apphost).

import type { AstralObject } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';
import { ProtocolError } from '../../astral/errors.js';
import { toPermit, type PermitValue } from '../auth/types.js';
import { Ops, Types } from './consts.js';

/**
 * The JSON `value` of an `apphost.access_token` {@link AstralObject}: the fresh
 * guest credentials minted by `apphost.register`.
 */
export interface AccessTokenValue {
  /** The new guest identity (66-hex string). */
  Identity: Identity;
  /** The access token to authenticate future connections with. */
  Token: string;
  /** The token's expiry timestamp (RFC 3339 string). */
  ExpiresAt: string;
}

/** One node-local grant: the JSON `value` of a `mod.apphost.grant`. */
export interface GrantValue {
  /** The grant's number on this node; names the grant to `apphost.revoke`. */
  ID: number;
  /** The recorded permit, with its constraints as written. */
  Permit: PermitValue;
  /** The instant the grant lapses (RFC 3339 string); `null` until revoked. */
  ExpiresAt: string | null;
}

/** The input of `apphost.register`: the JSON `value` of a `mod.apphost.register_request`. */
export interface RegisterRequestValue {
  /** The name the app gives itself; the node does not verify it. */
  Name: string;
  /** The permits the app asks to hold as node-local grants. */
  GrantPermits: PermitValue[];
  /** The permits the app asks to hold in a signed node→app contract. */
  ContractPermits: PermitValue[];
}

/** The input of `apphost.grant`: the JSON `value` of a `mod.apphost.grant_request`. */
export interface GrantRequestValue {
  /** The identity that receives the grants (a public key, never an alias). */
  Identity: Identity;
  /** The lifetime of each grant in nanoseconds; `0` lasts until revoked. */
  Duration: number;
  /** The permits to write. */
  Permits: PermitValue[];
}

/**
 * The input of `apphost.request_grant`: the JSON `value` of a
 * `mod.apphost.request_grant_request`.
 */
export interface RequestGrantRequestValue {
  /** The permits the session asks to hold as node-local grants. */
  Permits: PermitValue[];
  /** The lifetime asked for each grant in nanoseconds; `0` lasts until revoked. */
  Duration: number;
}

/** The largest whole number of milliseconds below 2^63 nanoseconds (Go `Duration`). */
const MAX_DURATION_MS = 9223372036854;

/**
 * Convert milliseconds to the nanoseconds of an `astral.Duration`, which
 * travels as a JSON integer.
 *
 * Above 2^53 ns (about 104 days) the JSON number can differ from the exact
 * product by under a microsecond: a JavaScript number is an IEEE 754 double.
 *
 * @throws {RangeError} Unless `ms` is a whole number from 0 to 9223372036854.
 */
export function durationNs(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DURATION_MS) {
    throw new RangeError(
      `duration is not a whole number of milliseconds from 0 to ${MAX_DURATION_MS}: ${ms}`,
    );
  }
  return ms * 1e6;
}

/** The instant `g` lapses, or `null` when it lasts until revoked. */
export function grantExpiresAt(g: GrantValue): Date | null {
  return g.ExpiresAt === null ? null : new Date(g.ExpiresAt);
}

/**
 * Check a `mod.apphost.grant` object and return its value. An absent
 * `ExpiresAt` reads as `null`.
 *
 * @throws {ProtocolError} On another type, an `ID` that is not a non-negative
 *   safe integer, a malformed `Permit`, or an `ExpiresAt` that is neither a
 *   string nor `null`.
 */
export function parseGrant(o: AstralObject): GrantValue {
  const fail = (what: string) => new ProtocolError(`${Ops.listGrants}: ${what}`);
  if (o.type !== Types.grant) throw fail(`unexpected object type ${o.type}`);
  const v = o.value as Partial<GrantValue> | null;
  if (typeof v !== 'object' || v === null) throw fail('grant is not an object');
  if (!Number.isSafeInteger(v.ID) || (v.ID as number) < 0) {
    throw fail(`grant ID is not a non-negative safe integer: ${String(v.ID)}`);
  }
  let permit: PermitValue;
  try {
    permit = toPermit(v.Permit as PermitValue);
  } catch (err) {
    throw fail(`grant ${v.ID}: ${(err as Error).message}`);
  }
  const expiresAt = v.ExpiresAt ?? null;
  if (expiresAt !== null && typeof expiresAt !== 'string') {
    throw fail(`grant ${v.ID}: ExpiresAt is neither a string nor null`);
  }
  return { ID: v.ID as number, Permit: permit, ExpiresAt: expiresAt };
}
