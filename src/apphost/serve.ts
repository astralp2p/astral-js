/**
 * The inbound-serve surface: {@link IncomingQuery} and {@link Registration}.
 *
 * A {@link Registration} owns the registration {@link Session} — the one on
 * which the host announces `incoming_query_msg`s — and runs a background
 * delivery loop that wraps each announcement in an {@link IncomingQuery} and
 * fires the handler. The handler settles the query exactly once: {@link
 * IncomingQuery.accept} opens a *fresh* per-query session (fresh-socket-per-op,
 * no auth — the QueryID is the pairing token), attaches to the announced query,
 * and returns a responder {@link Stream}; {@link IncomingQuery.reject} declines
 * it with a numeric code on the registration session. A handler that throws is
 * caught and turned into a `reject(0xff)`. This is a faithful port of the
 * reference client's `Registration` / `IncomingQuery`, retargeted onto the
 * Phase-1 {@link Session}/{@link Transport} seam. The outbound query path
 * (Host.query) is out of scope here.
 *
 * @module apphost/serve
 */

import type { AstralObject } from '../astral/object.js';
import { obj, isAck } from '../astral/object.js';
import type { Nonce } from '../astral/nonce.js';
import { DefaultRejectCode } from '../astral/codes.js';
import { ProtocolError } from '../astral/errors.js';
import type { IncomingQueryMsg, AttachQueryMsg, RejectIncomingMsg } from './messages.js';
import { MessageTypes } from './messages.js';
import type { Session, Transport } from './session.js';
import { Stream } from './stream.js';

/**
 * A single inbound query announced on a {@link Registration}'s session, awaiting
 * an {@link accept} or {@link reject}.
 *
 * The raw `incoming_query_msg` carries the full query string (which the host may
 * decorate with `?in=json&out=json`); {@link query} exposes the path before the
 * `?` and {@link params} the parsed query-string arguments with the auto-injected
 * `in`/`out=json` pair stripped. The query is settle-once: the first {@link
 * accept} or {@link reject} wins, and any later call throws.
 */
export class IncomingQuery {
  /** The query's id — also the attach pairing token. */
  readonly id: string;
  /** The caller identity, or `null`. */
  readonly caller: string | null;
  /** The target identity, or `null`. */
  readonly target: string | null;
  /** The query path — the full query string before any `?`. */
  readonly query: string;
  /** The parsed query-string arguments, excluding the auto-injected `in`/`out=json`. */
  readonly params: Record<string, string>;
  /** The full, undecorated query string as announced. */
  readonly queryString: string;

  private readonly transport: Transport;
  private readonly regSession: Session;
  private settled = false;

  constructor(transport: Transport, regSession: Session, raw: IncomingQueryMsg) {
    this.transport = transport;
    this.regSession = regSession;

    this.id = raw.QueryID;
    this.caller = raw.Caller ?? null;
    this.target = raw.Target ?? null;

    // Split the full query string into the path (e.g. "chat.send") and a
    // friendly params object. The apphost injects ?in=json&out=json, so drop
    // that pair — a bare `query === 'chat.send'` check must still hold, and
    // callers should not see the transport-mode flags among their args.
    const full = raw.Query ?? '';
    const i = full.indexOf('?');
    this.query = i < 0 ? full : full.slice(0, i);
    this.queryString = full;

    const params: Record<string, string> = {};
    if (i >= 0) {
      const search = new URLSearchParams(full.slice(i + 1));
      for (const [key, value] of search) {
        if ((key === 'in' || key === 'out') && value === 'json') continue;
        params[key] = value;
      }
    }
    this.params = params;
  }

  /**
   * Accept the query: open a fresh, unauthenticated per-query {@link Session},
   * attach to the announced query, and return a responder {@link Stream}.
   *
   * Settle-once — throws if the query was already accepted or rejected. Sends
   * `attach_query_msg` `{ QueryID }` and expects an `ack`; anything else closes
   * the session and raises {@link ProtocolError}.
   */
  async accept(): Promise<Stream> {
    if (this.settled) throw new Error('incoming query already settled');
    this.settled = true;

    // Per-query sessions do not authenticate — the QueryID is the pairing token.
    const session = await this.transport.open({ skipAuth: true });

    const attach: AttachQueryMsg = { QueryID: this.id as Nonce };
    session.send(obj(MessageTypes.AttachQuery, attach));

    const resp: AstralObject | null = await session.recv();
    if (resp === null || !isAck(resp)) {
      session.close();
      throw new ProtocolError(
        `expected ack for attach_query, got ${resp ? resp.type : 'nothing'}`,
      );
    }

    return new Stream(session);
  }

  /**
   * Reject the query with a numeric code on the registration session.
   *
   * Settle-once — throws if the query was already accepted or rejected. The send
   * itself is a no-op if the registration session is already closed (the
   * loop's unregister ended it), so a late reject on a torn-down registration is
   * harmless rather than throwing.
   */
  reject(code: number = DefaultRejectCode): void {
    if (this.settled) throw new Error('incoming query already settled');
    this.settled = true;

    const rejectMsg: RejectIncomingMsg = { QueryID: this.id as Nonce, Code: code };
    try {
      this.regSession.send(obj(MessageTypes.RejectIncoming, rejectMsg));
    } catch {
      /* registration session already closed — nothing to reject to */
    }
  }
}

/**
 * A live service registration: owns the registration {@link Session} and runs a
 * background loop that delivers each announced {@link IncomingQuery} to the
 * handler.
 *
 * Construct via {@link Host.register}, which handshakes the session and sends the
 * `register_service_msg`; the caller then invokes {@link start} to begin the
 * loop. {@link unregister} closes the session, which ends the loop.
 */
export class Registration {
  private readonly transport: Transport;
  private readonly session: Session;
  private readonly handler: (q: IncomingQuery) => void | Promise<void>;

  constructor(
    transport: Transport,
    session: Session,
    handler: (q: IncomingQuery) => void | Promise<void>,
  ) {
    this.transport = transport;
    this.session = session;
    this.handler = handler;
  }

  /**
   * Run the background delivery loop.
   *
   * Reads announcements off the registration session until it closes (`recv`
   * returns `null`). Non-`incoming_query_msg` frames are ignored. Each inbound
   * query is wrapped in an {@link IncomingQuery} and handed to the handler
   * fire-and-forget; a handler that throws is caught and turned into a
   * `reject(0xff)` (itself guarded, in case the handler already settled).
   */
  start(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    for (;;) {
      const msg = await this.session.recv();
      if (msg === null) break;
      if (msg.type !== MessageTypes.IncomingQuery) continue;
      const q = new IncomingQuery(this.transport, this.session, msg.value as IncomingQueryMsg);
      // Fire-and-forget: the handler decides accept/reject. A throw becomes a
      // reject(0xff); the inner guard swallows the "already settled" case where
      // the handler both settled the query and then threw.
      Promise.resolve()
        .then(() => this.handler(q))
        .catch(() => {
          try {
            q.reject(0xff);
          } catch {
            /* already settled */
          }
        });
    }
  }

  /** Unregister: close the registration session, which ends the loop. Idempotent. */
  unregister(): void {
    this.session.close();
  }
}
