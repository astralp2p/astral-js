/**
 * The socket layer: the sole place a WebSocket is created.
 *
 * Exposes a minimal structural {@link WebSocketLike} — only the members this
 * SDK uses — so the rest of the code never touches the DOM `WebSocket` type or
 * the `ws` package type directly, sidestepping the well-known clash between the
 * two. {@link openSocket} picks the platform socket (the `globalThis.WebSocket`
 * global in browsers and Node 22+, else a lazily-imported `ws`), negotiates the
 * `astral.json.v1` subprotocol, and resolves once the socket is open.
 *
 * @module apphost/transport
 */

import { ConnectError } from '../astral/errors.js';

/** The `astral.json.v1` subprotocol negotiated on every apphost socket. */
export const SUBPROTOCOL = 'astral.json.v1';

/**
 * The narrow structural view of a WebSocket this SDK relies on. Both the DOM
 * `WebSocket` and the `ws` package's socket satisfy this shape, so code typed
 * against it stays free of their incompatible full type definitions.
 */
export interface WebSocketLike {
  /** Send a text frame. */
  send(data: string): void;
  /** Close the socket. */
  close(): void;
  /** The socket state (0 connecting, 1 open, 2 closing, 3 closed). */
  readonly readyState: number;
  /** Subscribe to a socket lifecycle event. */
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
}

/**
 * The subset of a message event we read: text frames carry a string `data`.
 * Binary frames (whose `data` is not a string) are ignored by the receiver.
 */
export interface MessageEventLike {
  data: unknown;
}

/** A constructor compatible with the DOM `WebSocket` / `ws` two-arg form. */
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * Create a WebSocket to `url`, negotiating the `astral.json.v1` subprotocol.
 * Uses `globalThis.WebSocket` when present, otherwise lazily imports the
 * optional `ws` package; rejects with {@link ConnectError} if neither is
 * available.
 *
 * The socket is returned **before** it opens, on purpose: the caller must
 * attach its message listener (construct the {@link Receiver}) and only then
 * {@link waitOpen}. Awaiting `open` here would let the host's first frame
 * (`host_info_msg`, sent immediately on open) arrive before any listener is
 * attached — neither the DOM `WebSocket` nor `ws` buffers pre-listener
 * messages, so it would be lost. The reference client attaches the receiver
 * before awaiting open for exactly this reason.
 */
export async function openSocket(url: string): Promise<WebSocketLike> {
  const Ctor = await resolveWebSocket();
  return new Ctor(url, SUBPROTOCOL);
}

/**
 * Resolve once `ws` fires `open`; reject with {@link ConnectError} if it errors
 * first. Attach the message listener (the {@link Receiver}) before calling this.
 *
 * The `readyState` checks cover a socket that settled BEFORE this subscribes:
 * a same-tick failure dispatches `error`/`close` between construction (inside
 * the async {@link openSocket}) and this call — e.g. undici fails a fetch-spec
 * bad-port URL synchronously — and waiting on the already-fired events would
 * hang forever.
 */
export function waitOpen(ws: WebSocketLike): Promise<void> {
  const OPEN = 1;
  if (ws.readyState === OPEN) return Promise.resolve();
  if (ws.readyState > OPEN) {
    return Promise.reject(new ConnectError('socket closed before open'));
  }
  return new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (event) => reject(new ConnectError('socket error', event)), {
      once: true,
    });
  });
}

/**
 * Resolve the platform WebSocket constructor: the global if defined, else the
 * lazily-imported `ws` package. Throws {@link ConnectError} if neither exists.
 */
async function resolveWebSocket(): Promise<WebSocketCtor> {
  const global = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof global === 'function') {
    return global as unknown as WebSocketCtor;
  }

  try {
    const mod = (await import('ws')) as { default?: unknown; WebSocket?: unknown };
    const Ctor = mod.WebSocket ?? mod.default;
    if (typeof Ctor === 'function') {
      return Ctor as unknown as WebSocketCtor;
    }
  } catch (cause) {
    throw new ConnectError(
      'no WebSocket implementation available: not found on globalThis and the optional "ws" package could not be imported',
      cause,
    );
  }

  throw new ConnectError(
    'no WebSocket implementation available: not found on globalThis and the "ws" package did not export a constructor',
  );
}
