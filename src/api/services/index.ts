// api/services — the services protocol client (service discovery).
// Built on the apphost WebSocket client's query. Basic op: discover. Populated
// by: dev/api-services.

/**
 * The `services` protocol client: discover the services a node advertises, as a
 * stream of `services.update` objects.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `services.*`
 * operation exactly as the reference node serves it. Grounded in both reference
 * implementations:
 *   - Go client: `api/services/client/services.go` (`Client.Discover`),
 *     op string from `api/services/module.go` (`MethodDiscover`).
 *   - Node (astrald): `mod/services/src/op_discover.go` (`OpDiscover`) and
 *     `mod/services/src/discover_services.go` (the snapshot/live semantics).
 *
 * The one op folds its argument into the query string via the shared encoder
 * (`services.discover?<args>`) and drives a streaming response:
 *
 *   - {@link Services.discover} — query `services.discover` with `{ follow? }`;
 *     the node streams one `services.update` object per available service, then
 *     an `eos`. When `follow` is `false` (the default) the node closes after
 *     that snapshot. When `follow` is `true` the first `eos` is only a
 *     snapshot/live *separator*: the node keeps the channel open and streams
 *     each subsequent live update, ending with a final `eos` (or when the caller
 *     stops iterating). The client yields every `services.update` as an
 *     {@link AstralObject}, transparently consuming the separator so a follow
 *     stream flows without a gap.
 *
 * The node's `services.sync` operation (`MethodSync`, `op_sync.go`) — which
 * fetches and caches a *remote* identity's services over the network zone — is
 * out of scope for this BASIC client and intentionally omitted.
 *
 * @module api/services
 */

import type { Host } from '../../apphost/host.js';
import type { AstralObject } from '../../astral/object.js';
import { isError } from '../../astral/object.js';
import { RemoteError, readErrorMessage } from '../../astral/errors.js';

/** The op string for {@link Services.discover}. Verbatim `MethodDiscover`. */
const OP_DISCOVER = 'services.discover';

/** The wire type tag of a service-availability update. Verbatim Go `Update.ObjectType()`. */
export const UPDATE_TYPE = 'services.update';

/**
 * The JSON `value` of a `services.update` {@link AstralObject}, as the node
 * marshals the Go `services.Update` struct over `astral.json.v1`.
 *
 * The field names are the Go struct's exported names verbatim (astral's
 * `structValue` JSON encoder keys each field by `Field.Name`). This alias
 * documents the obvious shape; it is intentionally shallow — `Info` is a
 * `bundle` (a JSON array of `{ Type, Object }` adapters holding endpoints and
 * other metadata) and is left as pass-through `unknown` rather than fully typed.
 *
 * @see api/services/update.go — the Go `Update` struct.
 */
export interface ServiceUpdateValue {
  /** Whether the service is now available (`true`) or withdrawn (`false`). */
  Available: boolean;
  /** The service name (`string8`). */
  Name: string;
  /** The advertising node's identity (66-hex string, or `anyone`). */
  ProviderID: string;
  /** The service's metadata bundle — a JSON array of `{ Type, Object }` adapters. */
  Info: unknown;
}

/** Options for {@link Services.discover}. */
export interface DiscoverOptions {
  /**
   * When `true`, keep the stream open after the initial snapshot and receive
   * every subsequent live update, instead of ending after the snapshot. The
   * node marks the snapshot/live boundary with an `eos` the client consumes
   * transparently (Go `Client.Discover`, astrald `OpDiscover`).
   */
  follow?: boolean;
}

/**
 * A client for the node's `services` protocol, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const services = new Services(host);
 *
 * // One-shot snapshot: iterate to completion, then it stops.
 * for await (const update of await services.discover()) {
 *   const v = update.value as ServiceUpdateValue;
 *   console.log(v.Available, v.Name, v.ProviderID);
 * }
 *
 * // Follow mode: keeps yielding live updates until you break out.
 * for await (const update of await services.discover(true)) {
 *   const v = update.value as ServiceUpdateValue;
 *   if (v.Name === 'chat') break; // breaking closes the stream
 * }
 * ```
 */
export class Services {
  private readonly host: Host;

  /** Bind a `services` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Discover the services the node advertises, as a stream of `services.update`
   * objects.
   *
   * Sends `services.discover` (folding `&follow=true` only when `follow` is
   * set) and returns an {@link AsyncIterable} that yields each streamed
   * `services.update` as a raw {@link AstralObject} — the type tag preserved and
   * the `value` shaped like {@link ServiceUpdateValue}. The value is passed
   * through unchanged (its `ProviderID` is a hex identity string and `Info` is a
   * `bundle`), so this client imposes no schema beyond the documented alias.
   *
   * Snapshot mode (`follow` omitted or `false`): the node streams the current
   * set of services and ends with an `eos`; the iterable completes after the
   * last update. Each service present at query time is delivered exactly once.
   *
   * Follow mode (`follow === true`): the node streams the same snapshot, then an
   * `eos` that is *only* a snapshot/live separator, then each subsequent live
   * update as services come and go — ending with a final `eos` or when the
   * caller stops iterating. The separator is consumed transparently, so the
   * caller sees one uninterrupted stream of updates and never observes the
   * boundary. A follow stream stays open indefinitely on a live node; the caller
   * ends it by breaking out of the loop (which closes the underlying stream) —
   * there is no other terminator on a healthy node.
   *
   * The query is opened eagerly, so a reject / `route_not_found` rejects this
   * call before iteration begins; the underlying {@link Stream} is then drained
   * lazily as the caller iterates, and closed when iteration ends (whether by
   * exhaustion, a `break`, or a thrown error). A transmittable error object in
   * the stream surfaces as a {@link RemoteError} thrown from the iteration
   * (matching the node's `OpDiscover`, which sends an error object when
   * discovery fails).
   *
   * @param follow Keep the stream open for live updates after the snapshot.
   *   Defaults to `false`.
   * @returns An async iterable of `services.update` {@link AstralObject}s.
   */
  async discover(follow = false): Promise<AsyncIterable<AstralObject>> {
    const stream = await this.host.query(OP_DISCOVER, {
      args: { follow: follow ? true : undefined },
    });

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AstralObject, void, undefined> {
        try {
          // First pass: drain the snapshot. The Stream's iterator returns on the
          // first `eos`, which for a snapshot query is the terminator and for a
          // follow query is the snapshot/live separator.
          for await (const o of stream) {
            if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
            yield o;
          }

          // Snapshot mode ends here. In follow mode the node keeps the channel
          // open past the separator `eos`, so resume reading live updates from
          // the same session until the final `eos` (or the socket closes).
          // Re-entering the Stream's iterator continues off the same underlying
          // recv() queue, transparently skipping the separator; the Stream
          // iterator again stops before the terminating `eos`.
          if (!follow) return;
          for await (const o of stream) {
            if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
            yield o;
          }
        } finally {
          stream.close();
        }
      },
    };
  }
}
