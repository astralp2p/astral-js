// api/nodes — the nodes protocol client (links and endpoints).
// Built on the apphost WebSocket client's query. Basic ops: links,
// resolveEndpoints, newLink.

/**
 * The `nodes` protocol client: read the node's live links, resolve the
 * endpoints known for an identity, and open a link to one.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `nodes.*`
 * operations exactly as the reference node serves them. Grounded in the
 * protocol spec and the astrald server ops:
 *   - Spec: `astral-docs .../protocols/nodes/ops/nodes.{links,resolve_endpoints,new_link}.md`.
 *   - astrald server ops: `mod/nodes/src/op_{links,resolve_endpoints,new_link}.go`.
 *
 * The three together are what a caller needs to say something honest about
 * reachability: {@link Nodes.links} is a fact about now, {@link Nodes.resolveEndpoints}
 * is a fact about the past — an endpoint the node learned and has not re-tried —
 * and {@link Nodes.newLink} is the attempt that turns the second into the first.
 *
 * Endpoints arrive as wire adapters, not as {@link AstralObject}s: the library
 * unwraps the frame envelope only, so a `{ Type, Object }` nested inside a
 * value stays in that form. {@link WireAdapter} names the shape rather than
 * imposing one on the endpoint's own payload, which is per-network
 * (`tcp.endpoint`, `tor.endpoint`, …).
 *
 * Only the BASIC operations live here. The node's `add_endpoint`, `close_link`,
 * `sessions` and `migrate_session` are ADVANCED and intentionally omitted.
 *
 * @module api/nodes
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';
import type { Nonce } from '../../astral/nonce.js';
import { ProtocolError } from '../../astral/errors.js';

/**
 * A nested `{ Type, Object }` wire envelope, as it appears inside the value of
 * a decoded object. The library unwraps the outermost envelope only, so these
 * pass through verbatim; `Object` is left `unknown` because an endpoint's
 * payload is defined by its network.
 */
export interface WireAdapter {
  /** The astral type tag, e.g. `tcp.endpoint`. */
  Type: string;
  /** The payload, shaped by that type. */
  Object: unknown;
}

/**
 * The JSON `value` of a `mod.nodes.link_info` {@link AstralObject}: one live
 * link between the local node and a peer.
 */
export interface LinkInfoValue {
  /** The link's id (16-hex nonce), the handle other `nodes.*` ops take. */
  ID: Nonce;
  /** The local side's identity (66-hex string). */
  LocalIdentity: Identity;
  /** The peer's identity (66-hex string). */
  RemoteIdentity: Identity;
  /** The local endpoint the link runs over, absent for some networks. */
  LocalEndpoint?: WireAdapter | null;
  /** The remote endpoint the link runs over, absent for some networks. */
  RemoteEndpoint?: WireAdapter | null;
  /** Whether the local node dialled, rather than accepted. */
  Outbound: boolean;
  /** The network the link runs over, e.g. `tcp`, `tor`. */
  Network: string;
  /** Whether the link is under pressure. */
  HighPressure: boolean;
  /** Bytes moved over the link so far. */
  BytesThroughput: number;
}

/**
 * The JSON `value` of a `mod.nodes.endpoint_with_ttl` {@link AstralObject}: one
 * endpoint known for an identity, and how long it stays known.
 */
export interface EndpointWithTTLValue {
  /** The endpoint itself, as a nested wire adapter. */
  Endpoint: WireAdapter;
  /** Seconds the endpoint remains valid; `null` when it does not expire. */
  TTL: number | null;
}

/** Options for {@link Nodes.newLink}. */
export interface NewLinkOptions {
  /**
   * Dial this endpoint specifically, formatted `<network>:<address>` (e.g.
   * `tcp:1.2.3.4:1791`). When set, {@link NewLinkOptions.strategies} is ignored
   * — the node dials rather than choosing.
   */
  endpoint?: string;
  /**
   * Link strategies to try, in the order given (e.g. `['basic', 'tor']`). Sent
   * comma-joined; omitted when absent or empty, which lets the node use every
   * strategy it has registered. Ignored when `endpoint` is set.
   *
   * A strategy name carries no comma; one that does would split into two names
   * on the wire, so it is rejected here instead.
   */
  strategies?: string[];
}

/** Join strategy names for the op's `strategies` argument. */
function joinStrategies(strategies: string[]): string {
  for (const strategy of strategies) {
    if (strategy.includes(',')) {
      throw new TypeError(`strategy name contains a comma: ${strategy}`);
    }
  }
  return strategies.join(',');
}

/**
 * A client for the node's `nodes` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8624/.ws', { token });
 * const nodes = new Nodes(host);
 *
 * const live = await nodes.links();                    // linked right now
 * const known = await nodes.resolveEndpoints(peerID);  // reachable, maybe
 * if (!live.length && known.length) {
 *   await nodes.newLink(peerID);                       // try to connect
 * }
 * ```
 */
export class Nodes {
  private readonly host: Host;

  /** Bind a `nodes` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * List every currently active link, oldest first.
   *
   * Sends `nodes.links`; the node streams one `mod.nodes.link_info` per live
   * link, terminated by `eos`. Each is returned verbatim as an
   * {@link AstralObject} whose `value` is shaped like {@link LinkInfoValue}. A
   * per-item encoding failure streams an `error_message` and ends the stream,
   * surfaced as a {@link RemoteError} by {@link Host.call}.
   *
   * The result is a fact about now: a link in it is open. Nothing here says
   * anything about a peer that is merely reachable — that is
   * {@link Nodes.resolveEndpoints}.
   *
   * @returns The live `mod.nodes.link_info` objects, one per link.
   */
  async links(): Promise<AstralObject[]> {
    return this.host.call(Ops.links);
  }

  /**
   * Resolve every endpoint the node knows for an identity.
   *
   * Sends `nodes.resolve_endpoints?id=<id>`, asking each registered resolver;
   * the node streams one `mod.nodes.endpoint_with_ttl` per endpoint, terminated
   * by `eos`. Each is returned verbatim as an {@link AstralObject} whose `value`
   * is shaped like {@link EndpointWithTTLValue}.
   *
   * An empty result is an answer, not a failure: the node replied and knows of
   * no endpoint. A result is a claim about the past — an endpoint the node
   * learned at some point and has not re-tried — so a caller reporting it
   * should say when it was learned rather than assert reachability.
   *
   * @param id The identity to resolve, as a hex public key or an alias the
   *   directory resolves.
   * @returns The known `mod.nodes.endpoint_with_ttl` objects, one per endpoint.
   * @throws {QueryRejected} Code `2` if the identity cannot be resolved.
   */
  async resolveEndpoints(id: Identity | string): Promise<AstralObject[]> {
    return this.host.call(Ops.resolveEndpoints, { args: { id } });
  }

  /**
   * Open a link to an identity, and return the link it opened.
   *
   * Sends `nodes.new_link?target=<target>`, dialling
   * {@link NewLinkOptions.endpoint} when one is given and otherwise running
   * link strategies until one succeeds. The node replies with a single
   * `mod.nodes.link_info` describing the new link.
   *
   * Opening a link to a peer already linked is not an error — the node answers
   * with a link either way, so a caller may treat this as "make sure there is
   * one" rather than "make a second".
   *
   * @param target The identity to link to, as a hex public key or an alias.
   * @param opts Optional {@link NewLinkOptions}.
   * @returns The `mod.nodes.link_info` value for the link that was opened.
   * @throws {TypeError} If a strategy name contains a comma.
   * @throws {QueryRejected} Code `2` if the target cannot be resolved or the
   *   endpoint is malformed, `3` if the endpoint cannot be parsed, `4` if the
   *   context is cancelled or endpoint resolution fails, `5` if the link task
   *   cannot be scheduled.
   * @throws {RemoteError} If linking fails for any other reason.
   */
  async newLink(target: Identity | string, opts: NewLinkOptions = {}): Promise<LinkInfoValue> {
    const strategies = opts.strategies?.length ? joinStrategies(opts.strategies) : undefined;
    const objs = await this.host.call(Ops.newLink, {
      args: { target, endpoint: opts.endpoint, strategies },
    });
    if (objs.length === 0) {
      throw new ProtocolError('nodes.new_link returned no link info');
    }
    return objs[0]!.value as LinkInfoValue;
  }
}
