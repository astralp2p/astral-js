/**
 * A real in-process `astral.json.v1` apphost WebSocket server for tests.
 *
 * {@link startMockApphost} spins up a genuine `ws` {@link WebSocketServer} bound
 * to an ephemeral `127.0.0.1` port, negotiating the `astral.json.v1`
 * subprotocol. On each connection it plays the host side of the Phase-1
 * handshake exactly as the SDK's {@link JsonWsTransport} expects:
 *
 *   1. send a `host_info_msg` `{ Identity, Alias }` (unless configured to close
 *      the socket first, so `recv()` yields null and the handshake reports a
 *      missing `host_info_msg`);
 *   2. on an `auth_token_msg`, reply `auth_success_msg` `{ GuestID }` for the
 *      good token, else `error_msg` `{ Code: 'auth_failed' }`.
 *
 * Frames are the `{ Type, Object }` wire envelopes the receiver unwraps. (The
 * receiver's coalesced-frame splitting is covered in isolation by the FakeSocket
 * tests in apphost-session.test.ts — a realistic handshake cannot coalesce
 * host_info with the auth reply, since host_info must precede the token.)
 *
 * {@link installGlobalWebSocket} swaps the `ws` client onto
 * `globalThis.WebSocket` so `openSocket` picks it up, returning a `restore()`.
 */

import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { AddressInfo } from 'node:net';

/** The subprotocol every apphost socket negotiates. Mirrors `transport.ts`. */
const SUBPROTOCOL = 'astral.json.v1';

/** The wire type tags the mock emits; verbatim `mod.apphost.*` strings. */
const HOST_INFO = 'mod.apphost.host_info_msg';
const AUTH_TOKEN = 'mod.apphost.auth_token_msg';
const AUTH_SUCCESS = 'mod.apphost.auth_success_msg';
const ERROR = 'mod.apphost.error_msg';
const ROUTE_QUERY = 'mod.apphost.route_query_msg';
const QUERY_ACCEPTED = 'mod.apphost.query_accepted_msg';
const QUERY_REJECTED = 'mod.apphost.query_rejected_msg';
const REGISTER_SERVICE = 'mod.apphost.register_service_msg';
const INCOMING_QUERY = 'mod.apphost.incoming_query_msg';
const ATTACH_QUERY = 'mod.apphost.attach_query_msg';
const REJECT_INCOMING = 'mod.apphost.reject_incoming_msg';
const ACK = 'ack';
const EOS = 'eos';

/** A default host identity: a fixed, valid 66-hex string. */
export const DEFAULT_HOST_IDENTITY = 'a'.repeat(66);
/** The default host alias the mock announces. */
export const DEFAULT_HOST_ALIAS = 'mock-host';
/** The default guest identity handed back on a successful auth. */
export const DEFAULT_GUEST_IDENTITY = 'b'.repeat(66);
/** The token the mock accepts by default. */
export const DEFAULT_GOOD_TOKEN = 'good-token';

/** The `{ Type, Object }` wire envelope, as produced by `wrap`. */
interface WireEnvelope {
  Type: string;
  Object?: unknown;
}

/**
 * A scripted route reply, keyed on the EXACT `Query` string the client sends
 * (post-args-fold). Exactly one of `accept` / `reject` / `error` applies; a
 * query with no matching route gets an `error_msg` `{ Code: 'route_not_found' }`.
 */
export interface MockRoute {
  /** On accept: send `query_accepted_msg`, then each of these objects, then `eos`. */
  accept?: Array<{ type: string; value: unknown }>;
  /** On reject: send `query_rejected_msg` `{ Code }` with this numeric code. */
  reject?: number;
  /** On error: send `error_msg` `{ Code }` with this string code. */
  error?: string;
}

/**
 * A scripted `incoming_query_msg` the mock pushes to a registration socket right
 * after acking its `register_service_msg`. `Caller` / `Target` default to `null`.
 */
export interface MockIncomingQuery {
  /** The query's id — also the attach pairing token. */
  QueryID: string;
  /** The caller identity, or `null`. */
  Caller?: string | null;
  /** The target identity, or `null`. */
  Target?: string | null;
  /** The full query string. */
  Query: string;
}

/** Options controlling the mock apphost's behaviour. */
export interface MockApphostOptions {
  /** The host identity announced in `host_info_msg`. Defaults to {@link DEFAULT_HOST_IDENTITY}; pass `null` for the unset case. */
  hostIdentity?: string | null;
  /** The host alias announced in `host_info_msg`. Defaults to {@link DEFAULT_HOST_ALIAS}. */
  hostAlias?: string;
  /** The guest identity returned on success. Defaults to {@link DEFAULT_GUEST_IDENTITY}; pass `null` for the unset case. */
  guestIdentity?: string | null;
  /** The token accepted as valid. Defaults to {@link DEFAULT_GOOD_TOKEN}. */
  goodToken?: string;
  /** Close each socket immediately, before sending `host_info_msg` (drives the missing-host_info handshake error). */
  closeBeforeHostInfo?: boolean;
  /**
   * Scripted `route_query_msg` replies, keyed on the exact folded `Query` string.
   * An unlisted query is answered with `error_msg` `{ Code: 'route_not_found' }`.
   */
  routes?: Record<string, MockRoute>;
  /**
   * Inbound queries the mock pushes to a registration socket right after acking
   * its `register_service_msg`. One or many; omit for a bare registration.
   */
  incoming?: MockIncomingQuery | MockIncomingQuery[];
}

/** A single object captured on an attached per-query socket. */
export interface CapturedObject {
  type: string;
  value: unknown;
}

/** A running mock apphost server. */
export interface MockApphost {
  /** The `ws://127.0.0.1:<port>` URL to connect to. */
  readonly url: string;
  /** The port the server is listening on. */
  readonly port: number;
  /**
   * The number of connections accepted so far. A `connect()` handshake plus N
   * queries opens N+1 sockets, so tests can assert fresh-socket-per-op.
   */
  readonly connections: number;
  /**
   * The objects captured on each attached per-query socket, keyed by `QueryID`.
   * A key appears once the client's `attach_query_msg` is acked; each object the
   * client then sends is appended until (and excluding) its `eos`.
   */
  readonly accepted: Map<string, CapturedObject[]>;
  /**
   * The reject codes recorded from `reject_incoming_msg`s on registration
   * sockets, keyed by `QueryID`.
   */
  readonly rejected: Map<string, number>;
  /**
   * The objects a caller sent on an accepted route (write-op) socket, keyed by
   * the folded `Query` string. A key appears once the route is accepted; each
   * object the client then sends is appended until (and excluding) its `eos`.
   * Lets write-op tests (e.g. `tree.set`) assert what value the client sent.
   */
  readonly callerSent: Map<string, CapturedObject[]>;
  /**
   * Poll `predicate` until it returns truthy or `timeoutMs` elapses. Resolves on
   * success, rejects on timeout. Lets tests await a captured/rejected result
   * without racing the mock's async pushes.
   */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Stop the server, closing any open sockets. Resolves once fully closed. */
  close(): Promise<void>;
}

/** Serialize a `{ Type, Object }` envelope for the wire. */
function envelope(type: string, value: unknown): string {
  const env: WireEnvelope = { Type: type, Object: value };
  return JSON.stringify(env);
}

/**
 * Start a mock apphost server on an ephemeral `127.0.0.1` port. Resolves once
 * the server is listening and its `url` is known.
 */
export function startMockApphost(options: MockApphostOptions = {}): Promise<MockApphost> {
  const hostIdentity =
    options.hostIdentity === undefined ? DEFAULT_HOST_IDENTITY : options.hostIdentity;
  const hostAlias = options.hostAlias ?? DEFAULT_HOST_ALIAS;
  const guestIdentity =
    options.guestIdentity === undefined ? DEFAULT_GUEST_IDENTITY : options.guestIdentity;
  const goodToken = options.goodToken ?? DEFAULT_GOOD_TOKEN;
  const closeBeforeHostInfo = options.closeBeforeHostInfo ?? false;
  const routes = options.routes ?? {};
  const incoming =
    options.incoming === undefined
      ? []
      : Array.isArray(options.incoming)
        ? options.incoming
        : [options.incoming];

  // Serve-path capture. `accepted` maps a QueryID to the objects the client sent
  // on the socket that attached to it (until eos); `rejected` maps a QueryID to
  // the code from a reject_incoming_msg on a registration socket.
  const accepted = new Map<string, CapturedObject[]>();
  const rejected = new Map<string, number>();

  // Route-path capture. On an accepted route_query the caller socket stays open,
  // so a write-op client can send a value object (and eos) after reading its
  // ack. `callerSent` maps a Query string to the objects the caller then sent on
  // that accepted socket (until eos), so write-op tests can assert them.
  const callerSent = new Map<string, CapturedObject[]>();

  // Count every accepted connection. A connect() handshake plus N queries opens
  // N+1 sockets; the returned MockApphost exposes this via a `connections` getter.
  let connections = 0;

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    // Accept the client's first offered subprotocol iff it is ours.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  wss.on('connection', (ws: WsClient) => {
    connections += 1;

    if (closeBeforeHostInfo) {
      // Drop the connection before any host_info_msg: the client sees a close
      // with no hello object and must raise ConnectError.
      ws.close();
      return;
    }

    // Greet immediately with host_info_msg; the auth reply (if any) follows in
    // its own frame once a token arrives.
    ws.send(envelope(HOST_INFO, { Identity: hostIdentity, Alias: hostAlias }));

    // Once this socket attaches to a query, it becomes a capture socket: every
    // object it then sends is appended to accepted.get(attachedQueryID) until eos.
    let attachedQueryID: string | null = null;

    // Once this socket's route_query is accepted, it stays open as a write-op
    // socket: every object the caller then sends is appended to
    // callerSent.get(acceptedQuery) until the caller's eos.
    let acceptedQuery: string | null = null;

    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) return; // JSON mode: ignore binary frames.
      const text = String(data);
      let env: WireEnvelope;
      try {
        env = JSON.parse(text) as WireEnvelope;
      } catch {
        return;
      }

      if (env.Type === AUTH_TOKEN) {
        const token = (env.Object as { Token?: unknown } | null)?.Token;
        const reply =
          token === goodToken
            ? envelope(AUTH_SUCCESS, { GuestID: guestIdentity })
            : envelope(ERROR, { Code: 'auth_failed' });
        ws.send(reply);
        return;
      }

      if (env.Type === ROUTE_QUERY) {
        const query = (env.Object as { Query?: unknown } | null)?.Query;
        const route = typeof query === 'string' ? routes[query] : undefined;

        if (!route) {
          // Unknown route: the host reports route_not_found via error_msg.
          ws.send(envelope(ERROR, { Code: 'route_not_found' }));
          return;
        }
        if (route.reject !== undefined) {
          ws.send(envelope(QUERY_REJECTED, { Code: route.reject }));
          return;
        }
        if (route.error !== undefined) {
          ws.send(envelope(ERROR, { Code: route.error }));
          return;
        }
        // Accept: query_accepted_msg, then each scripted object, then eos.
        // Leave the caller socket OPEN afterward — a write-op client sends its
        // value object (+ eos) on this same socket after reading the ack, so
        // closing here would race it onto a dead socket. Mark it a write-op
        // capture socket and reserve callerSent.get(query) up front so
        // waitFor(() => callerSent.has(q)) trips as soon as the route accepts.
        if (typeof query === 'string') {
          acceptedQuery = query;
          if (!callerSent.has(query)) callerSent.set(query, []);
        }
        ws.send(envelope(QUERY_ACCEPTED, {}));
        for (const o of route.accept ?? []) ws.send(envelope(o.type, o.value));
        ws.send(envelope(EOS, null));
        return;
      }

      if (env.Type === REGISTER_SERVICE) {
        // Ack the registration, then push each scripted inbound query onto this
        // (registration) socket. Reserve each QueryID's capture list up front so
        // waitFor(() => accepted.has(id)) only trips once a real attach lands.
        ws.send(envelope(ACK, null));
        for (const q of incoming) {
          ws.send(
            envelope(INCOMING_QUERY, {
              QueryID: q.QueryID,
              Caller: q.Caller ?? null,
              Target: q.Target ?? null,
              Query: q.Query,
            }),
          );
        }
        return;
      }

      if (env.Type === ATTACH_QUERY) {
        // A fresh per-query socket attaching to an announced query: ack it, then
        // capture every object it sends until eos into accepted.get(QueryID).
        const queryID = (env.Object as { QueryID?: unknown } | null)?.QueryID;
        if (typeof queryID === 'string') {
          attachedQueryID = queryID;
          if (!accepted.has(queryID)) accepted.set(queryID, []);
          ws.send(envelope(ACK, null));
        }
        return;
      }

      if (env.Type === REJECT_INCOMING) {
        // A reject_incoming_msg on a registration socket: record the code.
        const payload = env.Object as { QueryID?: unknown; Code?: unknown } | null;
        if (typeof payload?.QueryID === 'string' && typeof payload.Code === 'number') {
          rejected.set(payload.QueryID, payload.Code);
        }
        return;
      }

      // Anything else on an attached per-query socket is a responder object:
      // append it to the capture list until the responder's eos arrives.
      if (attachedQueryID !== null) {
        if (env.Type === EOS) {
          attachedQueryID = null;
          return;
        }
        const list = accepted.get(attachedQueryID);
        if (list) list.push({ type: env.Type, value: env.Object ?? null });
        return;
      }

      // Anything else on an accepted route (write-op) socket is a caller object:
      // append it to callerSent.get(acceptedQuery) until the caller's eos.
      if (acceptedQuery !== null) {
        if (env.Type === EOS) {
          acceptedQuery = null;
          return;
        }
        const list = callerSent.get(acceptedQuery);
        if (list) list.push({ type: env.Type, value: env.Object ?? null });
      }
    });
  });

  return new Promise<MockApphost>((resolve, reject) => {
    wss.once('error', reject);
    wss.on('listening', () => {
      const address = wss.address() as AddressInfo;
      const port = address.port;
      const url = `ws://127.0.0.1:${port}`;
      resolve({
        url,
        port,
        // A live getter so tests read the current count after their operations.
        get connections() {
          return connections;
        },
        // Live references so tests observe the mock's async captures.
        accepted,
        rejected,
        // A getter returning the live callerSent map so write-op tests read the
        // caller's sent objects after their operations settle.
        get callerSent() {
          return callerSent;
        },
        waitFor: (predicate: () => boolean, timeoutMs = 1000) =>
          new Promise<void>((res, rej) => {
            const deadline = Date.now() + timeoutMs;
            const tick = (): void => {
              if (predicate()) {
                res();
                return;
              }
              if (Date.now() >= deadline) {
                rej(new Error('waitFor: predicate not satisfied before timeout'));
                return;
              }
              setTimeout(tick, 5);
            };
            tick();
          }),
        close: () =>
          new Promise<void>((res, rej) => {
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * Install the `ws` client as `globalThis.WebSocket` so {@link openSocket} uses
 * it, and return a `restore()` that puts the previous value back. Call in
 * `beforeAll` / `afterAll`.
 */
export function installGlobalWebSocket(): () => void {
  const holder = globalThis as { WebSocket?: unknown };
  const had = Object.prototype.hasOwnProperty.call(holder, 'WebSocket');
  const previous = holder.WebSocket;
  holder.WebSocket = WsClient as unknown;
  return () => {
    if (had) holder.WebSocket = previous;
    else delete holder.WebSocket;
  };
}
