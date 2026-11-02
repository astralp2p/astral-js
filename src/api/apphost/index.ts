// api/apphost — the apphost protocol client (guest registration and grants).
// Built on the apphost WebSocket client's query. Ops: register, grant,
// requestGrant, listGrants, revoke. Populated by: dev/api-settings-app,
// dev/apphost-grant-clients.

/**
 * The `apphost` protocol client: bootstrap a guest identity on the node and
 * manage its node-local grants.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `apphost.*`
 * OPERATIONS (queries routed to the apphost module) — distinct from
 * `astral-js/apphost`, the WebSocket client library itself (whose
 * `Host.register` registers an inbound-query handler and is unrelated to the
 * `apphost.register` op below).
 *
 * Grounded in the protocol spec under `.ai/system/protocols/apphost/`:
 *   - `ops/apphost.register.md` with `types/mod.apphost.register_request.md`;
 *   - `ops/apphost.grant.md` with `types/mod.apphost.grant_request.md`;
 *   - `ops/apphost.request_grant.md` with `types/mod.apphost.request_grant_request.md`;
 *   - `ops/apphost.list_grants.md` with `types/mod.apphost.grant.md`;
 *   - `ops/apphost.revoke.md`.
 *
 * `register`, `grant` and `request_grant` read one input object on the stream
 * after accept; `list_grants` and `revoke` take query arguments. Grants
 * accumulate: a new grant never replaces an earlier one, and narrowing is
 * granting the narrow permit, then revoking the wide one. The remaining
 * `apphost.*` ops (token management, app install, object holds, `whoami`, …)
 * are ADVANCED for this client and intentionally omitted.
 *
 * @module api/apphost
 */

import type { Host } from '../../apphost/host.js';
import type { Identity } from '../../astral/identity.js';
import { isAnyone, parseIdentity } from '../../astral/identity.js';
import type { AstralObject } from '../../astral/object.js';
import { isAck, isError, obj } from '../../astral/object.js';
import type { QueryArgs } from '../../astral/encoding.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';
import { toPermit, type PermitInput, type PermitValue } from '../auth/types.js';
import { Ops, Types } from './consts.js';
import { durationNs, parseGrant, type AccessTokenValue, type GrantValue } from './types.js';

export { Ops, Types, Refusals } from './consts.js';
export { durationNs, grantExpiresAt, parseGrant } from './types.js';
export type {
  AccessTokenValue,
  GrantRequestValue,
  GrantValue,
  RegisterRequestValue,
  RequestGrantRequestValue,
} from './types.js';

/**
 * Options for {@link Apphost.register}.
 */
export interface RegisterOptions {
  /** The name the app gives itself, sent as `Name`; the node does not verify it. */
  name?: string;
  /**
   * The permits the new identity asks to hold as node-local grants, sent as
   * `GrantPermits`, e.g. `['mod.auth.see_objects_action']`. A string is an
   * action without constraints; a {@link PermitValue} carries its constraints.
   * A grant is revocable and worthless off this node.
   *
   * Asking is not receiving. The node's app-register policy decides what the
   * new identity actually holds — a caller learns what it holds by using it,
   * not from the reply, which carries a token and no statement of what was
   * granted.
   */
  permits?: PermitInput[];
  /**
   * The permits the new identity asks to hold in a signed node→app contract,
   * sent as `ContractPermits`. A contract is portable evidence another node
   * verifies, and cannot be revoked.
   */
  contractPermits?: PermitInput[];
}

/** The lifetime option of {@link Apphost.grant} and {@link Apphost.requestGrant}. */
export interface DurationOptions {
  /**
   * The lifetime of each grant in milliseconds, sent as nanoseconds. Absent or
   * `0`: the grants last until revoked.
   */
  durationMs?: number;
}

/** Which grants {@link Apphost.revoke} removes: one grant by `id`, or every grant for `action`. */
export type RevokeTarget = { id: number; action?: never } | { action: string; id?: never };

/**
 * A client for the node's `apphost` protocol operations, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625');   // anonymous
 * const apphost = new Apphost(host);
 * const { Token, Identity } = await apphost.register({
 *   name: 'My App',
 *   permits: ['mod.auth.see_objects_action'],
 * });
 *
 * // reconnect with the token, then ask for a scoped grant:
 * const app = new Apphost(await connect(url, { token: Token }));
 * await app.requestGrant([discoveryPermit(['inference'])]);
 * ```
 */
export class Apphost {
  private readonly host: Host;

  /** Bind an `apphost` protocol client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Provision a fresh guest identity end-to-end and return its credentials.
   *
   * Opens `apphost.register` with no arguments and streams one
   * `mod.apphost.register_request` carrying {@link RegisterOptions.name},
   * {@link RegisterOptions.permits} (as `GrantPermits`) and
   * {@link RegisterOptions.contractPermits} (as `ContractPermits`), also for a
   * bare `register()`, because the op reads one object. The node generates a
   * new keypair, signs and stores an app contract between the new identity and
   * the node, and issues an access token — returned as the `value` of a single
   * `apphost.access_token` object, shaped like {@link AccessTokenValue}. Grants
   * accumulate; the node's register policy (default: accept all) decides which
   * asked-for permits are written.
   *
   * REFUSAL PATHS. A policy refusal arrives after accept as a
   * {@link RemoteError} "registration declined". A query from a network origin
   * gets an `error_message`, a {@link RemoteError}. An invalid permit gets a
   * {@link RemoteError} whose message starts with "invalid permit". A node
   * whose anonymous allowlist excludes the op answers a wire `denied`, a
   * {@link Denied}. Any other failure past accept (key generation, contract
   * signing, token minting) streams an `error_message`, a {@link RemoteError}.
   *
   * @param opts Optional {@link RegisterOptions}.
   * @returns The minted {@link AccessTokenValue} (`Identity`, `Token`, `ExpiresAt`).
   * @throws {TypeError} If a permit is malformed; nothing is routed then.
   */
  async register(opts: RegisterOptions = {}): Promise<AccessTokenValue> {
    const request = obj(Types.registerRequest, {
      Name: opts.name ?? '',
      GrantPermits: (opts.permits ?? []).map(toPermit),
      ContractPermits: (opts.contractPermits ?? []).map(toPermit),
    });

    const stream = await this.host.query(Ops.register);
    try {
      stream.send(request);

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (o.type === Types.accessToken) return o.value as AccessTokenValue;
        throw new ProtocolError(`${Ops.register}: unexpected object type ${o.type}`);
      }
      throw new ProtocolError(`${Ops.register} returned no access token`);
    } finally {
      stream.close();
    }
  }

  /**
   * Write node-local grants of `permits` for `identity`.
   *
   * Opens `apphost.grant` with no arguments, streams one
   * `mod.apphost.grant_request` and resolves on the node's `ack`. The caller
   * needs `mod.auth.admin_manage_apps_action`, and the query must come from a
   * local origin. Grants accumulate: each permit becomes its own grant, and an
   * identical permit (same identity, action and constraints) keeps one grant
   * and takes the newer expiry. Narrowing is granting the narrow permit, then
   * revoking the wide one. Grant IDs come from {@link Apphost.listGrants}.
   * Constraints on an action that ignores them are stored as sent and have no
   * effect.
   *
   * Refusals arrive as a {@link RemoteError}: "not permitted", or
   * "invalid permit: <action>: <reason>".
   *
   * @param identity The identity that receives the grants (66-hex; aliases are
   *   not accepted).
   * @param permits The permits to write; at least one.
   * @param opts {@link DurationOptions}; absent or `0` lasts until revoked.
   * @throws {TypeError} On an alias or `anyone` identity, an empty or malformed
   *   permit list; nothing is routed then.
   * @throws {RangeError} On a negative or fractional duration.
   */
  async grant(
    identity: Identity | string,
    permits: PermitInput[],
    opts: DurationOptions = {},
  ): Promise<void> {
    const id = parseIdentity(identity);
    if (isAnyone(id)) throw new TypeError('cannot grant to anyone');
    const request = obj(Types.grantRequest, {
      Identity: id,
      Duration: durationNs(opts.durationMs ?? 0),
      Permits: toPermits(permits),
    });
    await this.sendForAck(Ops.grant, request);
  }

  /**
   * Ask the node to grant `permits` to this session's own identity.
   *
   * Opens `apphost.request_grant` with no arguments, streams one
   * `mod.apphost.request_grant_request` and resolves on the node's `ack`. The
   * host must be connected with the requester's access token: the grantee is
   * the session's identity. Any requester may ask. The node always asks its
   * grant-request policy (`accept_all`, `reject_all`, or a delegate; unset is
   * `reject_all`), even for permits already held. The call waits while a
   * delegate decides, so the stream stays open until the answer. An approval
   * writes each permit with its constraints and the requested expiry.
   *
   * Refusals arrive as a {@link RemoteError}: "grant declined" from the policy,
   * or "invalid permit: <action>: <reason>", which the node answers before it
   * asks the policy.
   *
   * @param permits The permits to ask for; at least one.
   * @param opts {@link DurationOptions}; absent or `0` asks for grants that
   *   last until revoked.
   * @throws {TypeError} On an empty or malformed permit list; nothing is routed
   *   then.
   * @throws {RangeError} On a negative or fractional duration.
   */
  async requestGrant(permits: PermitInput[], opts: DurationOptions = {}): Promise<void> {
    const request = obj(Types.requestGrantRequest, {
      Permits: toPermits(permits),
      Duration: durationNs(opts.durationMs ?? 0),
    });
    await this.sendForAck(Ops.requestGrant, request);
  }

  /**
   * List the unexpired node-local grants of `identity`, one {@link GrantValue}
   * per grant.
   *
   * Sends `apphost.list_grants?identity=<identity>`; the node streams one
   * `mod.apphost.grant` per grant, then `eos`. The caller needs
   * `mod.auth.admin_manage_apps_action`, and the query must come from a local
   * origin.
   *
   * @param identity The identity whose grants to list (66-hex or an alias the
   *   node resolves).
   * @throws {TypeError} On an empty identity; nothing is routed then.
   * @throws {ProtocolError} On a reply that is not a well-formed
   *   `mod.apphost.grant`.
   */
  async listGrants(identity: Identity | string): Promise<GrantValue[]> {
    if (identity === '') throw new TypeError('empty identity');
    const objs = await this.host.call(Ops.listGrants, { args: { identity } });
    return objs.map(parseGrant);
  }

  /**
   * Remove node-local grants of `identity`: one grant by `target.id`, or every
   * grant for `target.action`.
   *
   * Sends `apphost.revoke?identity=<identity>&id=<id>` or
   * `…&action=<action>` and resolves on the node's `ack`. A grant named by
   * `id` must belong to `identity`. The caller needs
   * `mod.auth.admin_manage_apps_action`.
   *
   * @param identity The identity whose grants to remove.
   * @param target Exactly one of `id` (from {@link Apphost.listGrants}) or
   *   `action`.
   * @throws {TypeError} On an empty identity, or unless exactly one of a
   *   non-negative safe-integer `id` or a non-empty `action` is given; nothing
   *   is routed then.
   */
  async revoke(identity: Identity | string, target: RevokeTarget): Promise<void> {
    if (identity === '') throw new TypeError('empty identity');
    const { id, action } = target as { id?: number; action?: string };
    let args: QueryArgs;
    if (id !== undefined && action === undefined) {
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new TypeError(`grant id is not a non-negative safe integer: ${id}`);
      }
      args = { identity, id };
    } else if (action !== undefined && id === undefined) {
      if (typeof action !== 'string' || action === '') throw new TypeError('empty action');
      args = { identity, action };
    } else {
      throw new TypeError('revoke takes exactly one of id or action');
    }
    await this.sendForAck(Ops.revoke, null, args);
  }

  /**
   * Open `op`, stream `input` when given (no `eos`: the op reads exactly one
   * object), and resolve on the node's `ack`.
   */
  private async sendForAck(
    op: string,
    input: AstralObject | null,
    args?: QueryArgs,
  ): Promise<void> {
    const stream = await this.host.query(op, args ? { args } : {});
    try {
      if (input !== null) stream.send(input);

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (isAck(o)) return;
        throw new ProtocolError(`${op} expected an ack, got ${o.type}`);
      }
      throw new ProtocolError(`${op} was not acknowledged`);
    } finally {
      stream.close();
    }
  }
}

/** Check a non-empty permit list. */
function toPermits(permits: PermitInput[]): PermitValue[] {
  if (permits.length === 0) throw new TypeError('no permits');
  return permits.map(toPermit);
}
