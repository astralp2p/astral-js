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
}

/** A running mock apphost server. */
export interface MockApphost {
  /** The `ws://127.0.0.1:<port>` URL to connect to. */
  readonly url: string;
  /** The port the server is listening on. */
  readonly port: number;
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

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    // Accept the client's first offered subprotocol iff it is ours.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  wss.on('connection', (ws: WsClient) => {
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
      if (env.Type !== AUTH_TOKEN) return;

      const token = (env.Object as { Token?: unknown } | null)?.Token;
      const reply =
        token === goodToken
          ? envelope(AUTH_SUCCESS, { GuestID: guestIdentity })
          : envelope(ERROR, { Code: 'auth_failed' });
      ws.send(reply);
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
