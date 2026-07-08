// api/apphost — the apphost protocol client (guest registration).
// Built on the apphost WebSocket client's query. Basic op: register. Populated
// by: dev/api-settings-app.

/**
 * The `apphost` protocol client: bootstrap a guest identity on the node.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `apphost.*`
 * OPERATIONS (queries routed to the apphost module) — distinct from
 * `astral-js/apphost`, the WebSocket client library itself (whose
 * `Host.register` registers an inbound-query handler and is unrelated to the
 * `apphost.register` op below).
 *
 * Grounded in the protocol spec and the astrald server op:
 *   - Spec: `astral-docs .../protocols/apphost/ops/apphost.register.md`.
 *   - astrald server op: `mod/apphost/src/` (the register handler).
 *
 * Only the registration op lives here. The remaining `apphost.*` ops (token
 * management, app install, object holds, `whoami`, …) are ADVANCED for this
 * client and intentionally omitted.
 *
 * @module api/apphost
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { Identity } from '../../astral/identity.js';
import { ProtocolError } from '../../astral/errors.js';

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

/**
 * A client for the node's `apphost` protocol operations, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625');   // anonymous
 * const apphost = new Apphost(host);
 * const { Token, Identity } = await apphost.register();
 * // reconnect authenticated: connect(url, { token: Token })
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
   * Sends `apphost.register` (no arguments). The node generates a new keypair,
   * signs and stores an app contract between the new identity and the node,
   * and issues an access token — returned as the `value` of a single
   * `apphost.access_token` object, shaped like {@link AccessTokenValue}.
   *
   * REFUSAL PATHS. Registration is gated by the node's app-register policy
   * over the caller's web origin (`op_register.go` reads the origin from the
   * en-route query extras and checks `GetAppRegisterPolicy()`): a policy
   * refusal is the op's single reject, code `1`, surfaced as a
   * {@link QueryRejected} from {@link Host.query}. A refusal may also arrive
   * as a wire `denied` code (a {@link Denied}), and any failure past the
   * accept gate (key generation, contract signing, token minting) streams an
   * `error_message`, surfaced as a {@link RemoteError}. Callers should treat
   * all three as "refused".
   *
   * @returns The minted {@link AccessTokenValue} (`Identity`, `Token`, `ExpiresAt`).
   */
  async register(): Promise<AccessTokenValue> {
    const objs = await this.host.call(Ops.register);
    if (objs.length === 0) {
      throw new ProtocolError('apphost.register returned no access token');
    }
    return objs[0]!.value as AccessTokenValue;
  }
}
