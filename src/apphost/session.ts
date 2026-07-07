/**
 * The transport seam: {@link Session} / {@link Transport} and their
 * `astral.json.v1`-over-WebSocket implementations.
 *
 * A {@link Session} is a live, handshaken connection to the host — an object
 * pipe (`send` / `recv`) plus the handshake results (host info and, when
 * authenticated, the assigned guest identity). A {@link Transport} opens one:
 * {@link JsonWsTransport} runs the apphost handshake exactly as the reference
 * client's `openSession` does. Higher layers (Host, query, register, Stream)
 * build on this seam and are out of scope here; keeping the socket, framing,
 * and handshake behind {@link Transport} lets a future binary/IPC transport
 * slot in without touching them.
 *
 * @module apphost/session
 */

import type { AstralObject } from '../astral/object.js';
import { wrap } from '../astral/object.js';
import type { Identity } from '../astral/identity.js';
import { AuthError, ConnectError, ProtocolError } from '../astral/errors.js';
import type {
  AuthSuccessMsg,
  AuthTokenMsg,
  ErrorMsg,
  HostInfoMsg,
} from './messages.js';
import { MessageTypes } from './messages.js';
import { Receiver } from './receiver.js';
import type { WebSocketLike } from './transport.js';
import { openSocket, waitOpen } from './transport.js';

/** The host info captured from the opening `host_info_msg` frame. */
export interface HostInfo {
  /** The host node's identity, or `null` if unset. */
  identity: Identity | null;
  /** The host's human-readable alias. */
  alias: string;
}

/**
 * A live, handshaken connection to the host: an object pipe plus the results of
 * the handshake. `send` / `recv` move friendly {@link AstralObject}s; `close`
 * is idempotent.
 */
export interface Session {
  /** The host info announced during the handshake. */
  readonly hostInfo: HostInfo;
  /** The identity assigned to this guest, or `null` if the session is unauthenticated. */
  readonly guestID: Identity | null;
  /** Send an object to the host. */
  send(o: AstralObject): void;
  /** Receive the next object from the host, or `null` once the connection closes. */
  recv(): Promise<AstralObject | null>;
  /** Close the connection. Idempotent. */
  close(): void;
}

/** Options accepted when opening a {@link Session}. */
export interface OpenOptions {
  /** Skip the token-authentication step even if the transport holds a token. */
  skipAuth?: boolean;
}

/** Opens {@link Session}s. The abstraction the rest of the SDK builds on. */
export interface Transport {
  /** Open and hand back a fully handshaken {@link Session}. */
  open(opts?: OpenOptions): Promise<Session>;
}

/**
 * A {@link Session} over a {@link WebSocketLike} carrying `astral.json.v1`.
 * Constructed by {@link JsonWsTransport.open} once the handshake has completed.
 */
export class JsonWsSession implements Session {
  readonly hostInfo: HostInfo;
  readonly guestID: Identity | null;
  private readonly ws: WebSocketLike;
  private readonly receiver: Receiver;
  private closed = false;

  constructor(
    ws: WebSocketLike,
    receiver: Receiver,
    hostInfo: HostInfo,
    guestID: Identity | null,
  ) {
    this.ws = ws;
    this.receiver = receiver;
    this.hostInfo = hostInfo;
    this.guestID = guestID;
  }

  send(o: AstralObject): void {
    this.rawSend(wrap(o));
  }

  recv(): Promise<AstralObject | null> {
    return this.receiver.next();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private rawSend(env: unknown): void {
    this.ws.send(JSON.stringify(env));
  }
}

/**
 * A {@link Transport} that opens a WebSocket carrying `astral.json.v1` and runs
 * the apphost handshake: read `host_info_msg`, then (with a token, unless
 * `skipAuth`) send `auth_token_msg` and read the reply.
 */
export class JsonWsTransport implements Transport {
  private readonly url: string;
  private readonly token: string | null;

  constructor(url: string, token?: string | null) {
    this.url = url;
    this.token = token ?? null;
  }

  async open(opts: OpenOptions = {}): Promise<Session> {
    const { skipAuth = false } = opts;

    // Attach the receiver's message listener BEFORE the socket opens, so the
    // host's first frame (host_info_msg, sent on open) is not missed.
    const ws = await openSocket(this.url);
    const receiver = new Receiver(ws);
    await waitOpen(ws);

    const hello = await receiver.next();
    if (!hello || hello.type !== MessageTypes.HostInfo) {
      ws.close();
      throw new ProtocolError(`expected host_info_msg, got ${hello ? hello.type : 'nothing'}`);
    }
    const info = hello.value as HostInfoMsg;
    const hostInfo: HostInfo = { identity: info.Identity, alias: info.Alias };

    let guestID: Identity | null = null;
    if (this.token && !skipAuth) {
      const authToken: AuthTokenMsg = { Token: this.token };
      ws.send(JSON.stringify(wrap({ type: MessageTypes.AuthToken, value: authToken })));
      const resp = await receiver.next();
      if (!resp) {
        ws.close();
        throw new ConnectError('socket closed during auth');
      }
      if (resp.type === MessageTypes.Error) {
        ws.close();
        throw new AuthError((resp.value as ErrorMsg | null)?.Code);
      }
      if (resp.type !== MessageTypes.AuthSuccess) {
        ws.close();
        throw new ProtocolError(`expected auth_success_msg, got ${resp.type}`);
      }
      guestID = (resp.value as AuthSuccessMsg).GuestID;
    }

    return new JsonWsSession(ws, receiver, hostInfo, guestID);
  }
}
