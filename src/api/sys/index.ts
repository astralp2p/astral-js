// api/sys — the sys protocol client (the node's manager appointment).
// Built on the apphost WebSocket client's query. Ops: registerManager.

/**
 * The `sys` protocol client: appoint the node's manager.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `sys.*`
 * operations. The sys protocol holds the node's lifecycle: its state
 * (`fresh`, `unclaimed`, `claimed`, read with `user.info`) and its manager.
 * The manager is the App identity {@link Sys.registerManager} appoints. It is
 * the delegate of each policy its appointment binds, holds
 * `mod.auth.configure_node_state_action` in every node state (so it may call
 * every policy setter, which requires that action), and may claim the node
 * with `user.bootstrap` or `user.join` under its App token.
 *
 * Grounded in the protocol spec under `.ai/system/protocols/sys/`:
 *   - `ops/sys.register_manager.md` with
 *     `types/mod.sys.{register_manager_request,policy_binding}.md`.
 *
 * @module api/sys
 */

import type { Host } from '../../apphost/host.js';
import { isError, obj } from '../../astral/object.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';
import { toPermit } from '../auth/types.js';
import type { RegisterOptions } from '../apphost/index.js';
import { durationNs, type AccessTokenValue } from '../apphost/types.js';
import { Ops, Types, type PolicyName } from './consts.js';
import type { PolicyBindingValue, RegisterManagerRequestValue } from './types.js';

export { Ops, Types, Refusals, Policies } from './consts.js';
export type { PolicyName } from './consts.js';
export type { PolicyBindingValue, RegisterManagerRequestValue } from './types.js';
export type { AccessTokenValue } from '../apphost/types.js';

/** One policy the manager decides, for {@link RegisterManagerOptions.policies}. */
export interface PolicyBinding {
  /** The policy, one of the {@link Policies} names; sent as `Policy`. */
  policy: PolicyName;
  /** The op the node queries on the manager for each decision; sent as `Operation`. */
  operation: string;
  /**
   * How long the node waits for one answer, in milliseconds, sent as
   * nanoseconds in `Timeout`. Absent or `0` waits 10 minutes; the node refuses
   * a value above 10 minutes.
   */
  timeoutMs?: number;
}

/**
 * Options for {@link Sys.registerManager}. `name`, `permits` and
 * `contractPermits` mean what they mean for `Apphost.register`.
 */
export interface RegisterManagerOptions extends RegisterOptions {
  /**
   * The policies the manager decides, sent as `Policies`. The node stores a
   * delegate for each, with the new identity as delegate identity, and clears
   * the stored delegate of every policy left out.
   */
  policies?: PolicyBinding[];
}

/**
 * A client for the node's `sys` protocol operations, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625');   // a fresh node
 * const manager = await new Sys(host).registerManager({
 *   name: 'control-plane',
 *   policies: [{ policy: Policies.appRegister, operation: 'cp.approve_app' }],
 * });
 * ```
 */
export class Sys {
  private readonly host: Host;

  /** Bind a `sys` protocol client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Provision a fresh App identity as `Apphost.register` does and appoint it
   * the node's manager; return its credentials.
   *
   * Opens `sys.register_manager` with no arguments and streams one
   * `mod.sys.register_manager_request` carrying {@link RegisterManagerOptions.name},
   * {@link RegisterManagerOptions.permits} (as `GrantPermits`),
   * {@link RegisterManagerOptions.contractPermits} (as `ContractPermits`) and
   * {@link RegisterManagerOptions.policies} (as `Policies`, one
   * `mod.sys.policy_binding` value each), also for a bare `registerManager()`,
   * because the op reads one object. The app register policy is not asked. The
   * node stores a delegate for each named policy with the new identity as
   * delegate identity, clears the delegate of every policy left out, records
   * the appointment, and returns the manager's token as the `value` of a single
   * `apphost.access_token` object. The node is then `unclaimed`; the manager
   * may claim it with `user.bootstrap` or `user.join` under this token, and
   * holds `mod.auth.configure_node_state_action` in every node state. Only a
   * `fresh` node appoints a manager. The query must come from a local origin.
   *
   * REFUSAL PATHS. A node that is not fresh (it has a manager, has an active
   * contract, or has held one before) answers a {@link RemoteError} "node is not fresh"
   * ({@link Refusals}.notFresh). The node checks the request first: an invalid
   * permit gets a {@link RemoteError} whose message starts with
   * "invalid permit"; an unknown or repeated policy, a binding without an
   * operation, a timeout above 10 minutes, or a `user` policy on a node without
   * the `user` module gets a {@link RemoteError} naming the policy. A query
   * from a network origin gets an `error_message`, a {@link RemoteError}. The
   * node's gate answers a wire `denied`, a {@link Denied}, where it does not
   * admit the op: by default on an `unclaimed` node (the default
   * `gate.tokenless` and the `fresh` list of `gate.states` hold
   * `sys.register_manager`). Any later failure streams an `error_message`, a
   * {@link RemoteError}, and leaves the node `fresh`.
   *
   * @param opts Optional {@link RegisterManagerOptions}.
   * @returns The manager's {@link AccessTokenValue} (`Identity`, `Token`, `ExpiresAt`).
   * @throws {TypeError} If a permit is malformed; nothing is routed then.
   * @throws {RangeError} On a negative or fractional timeout; nothing is
   *   routed then.
   */
  async registerManager(opts: RegisterManagerOptions = {}): Promise<AccessTokenValue> {
    const value: RegisterManagerRequestValue = {
      Name: opts.name ?? '',
      GrantPermits: (opts.permits ?? []).map(toPermit),
      ContractPermits: (opts.contractPermits ?? []).map(toPermit),
      Policies: (opts.policies ?? []).map((b): PolicyBindingValue => ({
        Policy: b.policy,
        Operation: b.operation,
        Timeout: durationNs(b.timeoutMs ?? 0),
      })),
    };
    const request = obj(Types.registerManagerRequest, value);

    const op = Ops.registerManager;
    const stream = await this.host.query(op);
    try {
      // No eos: the op reads exactly one object.
      stream.send(request);

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (o.type === Types.accessToken) return o.value as AccessTokenValue;
        throw new ProtocolError(`${op}: unexpected object type ${o.type}`);
      }
      throw new ProtocolError(`${op} returned no access token`);
    } finally {
      stream.close();
    }
  }
}
