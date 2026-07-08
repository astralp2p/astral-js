// api/nearby — the nearby protocol client (LAN presence + discovery).
// Built on the apphost WebSocket client's query. Basic ops: broadcast, list.
// Populated by: dev/api-settings-app.

/**
 * The `nearby` protocol client: announce the local node's presence on the LAN
 * and read the cached set of nearby peers.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `nearby.*`
 * operations exactly as the reference node serves them. Grounded in the
 * protocol spec and the astrald server ops:
 *   - Spec: `astral-docs .../protocols/nearby/ops/nearby.{broadcast,list}.md`.
 *   - astrald server ops: `mod/nearby/src/op_{broadcast,list}.go`.
 *
 * The `mod.nearby.status` objects that `nearby.list` streams carry an
 * `Attachments` bundle — a JSON array of `{ Type, Object }` adapters. The
 * peer's alias travels inside it (as a `dir.Alias` object and as the
 * `NodeAlias` field of a `mod.nearby.public_profile` attachment,
 * `mod/nearby/{identity_resolver,public_profile}.go`), not as a top-level
 * field; the bundle is not fully typed and passes through as raw
 * {@link AstralObject}s with the {@link NearbyStatusValue} alias naming the
 * documented top-level fields.
 *
 * @module api/nearby
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';

/**
 * The JSON `value` of a `mod.nearby.status` {@link AstralObject}: one cached
 * nearby peer. `Attachments` is a bundle of `{ Type, Object }` adapters
 * (endpoints, public profile, …) and is intentionally left untyped.
 */
export interface NearbyStatusValue {
  /** The peer's node identity (66-hex string). */
  Identity: Identity;
  /** The peer's attachment bundle — pass-through, shape not imposed. */
  Attachments?: unknown;
}

/**
 * A client for the node's `nearby` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const nearby = new Nearby(host);
 *
 * await nearby.broadcast();                    // announce our presence
 * for (const status of await nearby.list()) {  // read the peer cache
 *   const v = status.value as NearbyStatusValue;
 *   console.log(v.Identity);
 * }
 * ```
 */
export class Nearby {
  private readonly host: Host;

  /** Bind a `nearby` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Trigger an immediate broadcast of the local node's status to nearby peers.
   *
   * Sends `nearby.broadcast` and drains the reply. The node answers with a
   * single `ack` on success; in silent mode the op is a no-op, and in stealth
   * mode the broadcast is suppressed unless at least one attachment is present
   * — both still resolve. A broadcast failure streams an `error_message`,
   * surfaced as a {@link RemoteError} by {@link Host.call}.
   */
  async broadcast(): Promise<void> {
    await this.host.call(Ops.broadcast);
  }

  /**
   * Read the current cached set of nearby peers.
   *
   * Sends `nearby.list`; the node prunes expired cache entries, then streams
   * one `mod.nearby.status` object per known peer, terminated by `eos`. Each
   * status is returned verbatim as an {@link AstralObject} whose `value` is
   * shaped like {@link NearbyStatusValue}. An encoding failure streams an
   * `error_message`, surfaced as a {@link RemoteError} by {@link Host.call}.
   *
   * The cache is passive: a fresh scan is `broadcast()` (peers answer with
   * their own status), a short settle wait, then `list()`.
   *
   * @returns The cached `mod.nearby.status` {@link AstralObject}s, one per peer.
   */
  async list(): Promise<AstralObject[]> {
    return this.host.call(Ops.list);
  }
}
