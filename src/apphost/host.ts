/**
 * The outbound-query surface: {@link connect}, {@link Host}, and its
 * {@link QueryOptions}.
 *
 * {@link connect} opens one throwaway {@link Session} to capture the host's
 * identity/alias and the assigned guest id, then hands back a {@link Host} bound
 * to a {@link Transport}. {@link Host.query} opens a *fresh* session per call
 * (fresh-socket-per-op), sends a `route_query_msg`, and drives the accept /
 * reject / error gate: an accept yields a {@link Stream}, a reject raises
 * {@link QueryRejected}, an `error_msg` maps through {@link queryErrorForCode}
 * (so `route_not_found` becomes {@link RouteNotFound}), and anything else is a
 * {@link ProtocolError}. This is a faithful port of the reference client's
 * `Host.query`, retargeted onto the Phase-1 {@link Session}/{@link Transport}
 * seam. The inbound path (register / incoming queries) is out of scope here.
 *
 * @module apphost/host
 */

import type { AstralObject } from '../astral/object.js';
import { obj } from '../astral/object.js';
import type { Identity } from '../astral/identity.js';
import type { Zone } from '../astral/zone.js';
import { ZoneDefault } from '../astral/zone.js';
import type { QueryArgs } from '../astral/encoding.js';
import { buildQueryString } from '../astral/encoding.js';
import { newNonce } from '../astral/nonce.js';
import { ConnectError, ProtocolError, QueryRejected, queryErrorForCode } from '../astral/errors.js';
import type { ErrorMsg, QueryRejectedMsg, RouteQueryMsg } from './messages.js';
import { MessageTypes } from './messages.js';
import type { Session, Transport } from './session.js';
import { JsonWsTransport } from './session.js';
import { Stream } from './stream.js';

/** Options for a single {@link Host.query}. Every field is optional. */
export interface QueryOptions {
  /** The target identity, or `null`. Defaults to the host's own identity. */
  target?: Identity | string | null;
  /** The caller identity, or `null`. Defaults to the assigned guest id. */
  caller?: Identity | string | null;
  /** Arguments folded into the query string via {@link buildQueryString}. */
  args?: QueryArgs;
  /** The reachability zone. Defaults to {@link ZoneDefault} (`'dvn'`). */
  zone?: Zone;
  /** Optional routing filters, or `null`. */
  filters?: string[] | null;
}

/**
 * A handle bound to a {@link Transport} that routes outbound queries. Holds the
 * host info captured at {@link connect} time; opens a fresh {@link Session} per
 * {@link Host.query}.
 */
export class Host {
  private readonly transport: Transport;
  private readonly _identity: Identity | null;
  private readonly _alias: string;
  private readonly _guestID: Identity | null;

  constructor(
    transport: Transport,
    identity: Identity | null,
    alias: string,
    guestID: Identity | null,
  ) {
    this.transport = transport;
    this._identity = identity;
    this._alias = alias;
    this._guestID = guestID;
  }

  /** The host node's identity announced at connect time, or `null`. */
  get identity(): Identity | null {
    return this._identity;
  }

  /** The host's human-readable alias. */
  get alias(): string {
    return this._alias;
  }

  /** The identity the host assigned this guest, or `null` if unauthenticated. */
  get guestID(): Identity | null {
    return this._guestID;
  }

  /**
   * Route an outbound query and, on accept, return a {@link Stream} of the
   * responder's objects.
   *
   * Opens a fresh {@link Session}, folds {@link QueryOptions.args} into
   * `queryString` (when given), and sends a `route_query_msg`. `Caller` defaults
   * to the guest id and `Target` to the host's own identity — matching the
   * reference client. Rejects with {@link QueryRejected} on `query_rejected_msg`,
   * the mapped {@link queryErrorForCode} error on `error_msg`, {@link ConnectError}
   * if the socket closes first, and {@link ProtocolError} on any other reply.
   */
  async query(queryString: string, opts: QueryOptions = {}): Promise<Stream> {
    const session = await this.transport.open();

    const folded =
      opts.args !== undefined ? buildQueryString(queryString, opts.args) : queryString;

    const routeQuery: RouteQueryMsg = {
      Nonce: newNonce(),
      // An explicit `caller: null` passes through (the host then fills in its own
      // node identity); an omitted caller defaults to the guest id. Faithful to
      // the reference client's `opts.caller !== undefined ? … : guestID` chain.
      Caller: ((opts.caller !== undefined ? opts.caller : this._guestID) ?? null) as Identity | null,
      Target: (opts.target ?? this._identity ?? null) as Identity | null,
      Query: folded,
      Zone: opts.zone ?? ZoneDefault,
      Filters: opts.filters ?? null,
    };
    session.send(obj(MessageTypes.RouteQuery, routeQuery));

    const resp: AstralObject | null = await session.recv();
    if (resp === null) {
      session.close();
      throw new ConnectError('socket closed before query response');
    }

    switch (resp.type) {
      case MessageTypes.QueryAccepted:
        return new Stream(session);
      case MessageTypes.QueryRejected:
        session.close();
        throw new QueryRejected((resp.value as QueryRejectedMsg).Code);
      case MessageTypes.Error:
        session.close();
        throw queryErrorForCode((resp.value as ErrorMsg).Code);
      default:
        session.close();
        throw new ProtocolError(`unexpected response to route_query: ${resp.type}`);
    }
  }
}

/**
 * Open a connection to apphost, complete the handshake to capture the host
 * identity/alias and assigned guest id, close that throwaway session, and return
 * a {@link Host} that opens fresh sessions per query.
 */
export async function connect(
  url: string,
  opts: { token?: string | null } = {},
): Promise<Host> {
  const transport = new JsonWsTransport(url, opts.token ?? null);
  const session: Session = await transport.open();
  const { hostInfo, guestID } = session;
  session.close();
  return new Host(transport, hostInfo.identity, hostInfo.alias, guestID);
}
