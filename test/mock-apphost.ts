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
        ws.send(envelope(QUERY_ACCEPTED, {}));
        for (const o of route.accept ?? []) ws.send(envelope(o.type, o.value));
        ws.send(envelope(EOS, null));
        return;
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
