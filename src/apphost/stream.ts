/**
 * The bidirectional object stream returned by an accepted query.
 *
 * A {@link Stream} wraps a live {@link Session} that has already passed the
 * `query_accepted_msg` gate: it forwards objects onto the socket with
 * {@link Stream.send}, closes the socket with {@link Stream.close} (idempotent),
 * and — as an {@link AsyncIterable} — yields each inbound {@link AstralObject}
 * until the responder sends `eos` or the connection closes. This mirrors the
 * reference client's `Stream`, but drives the Phase-1 {@link Session} pipe
 * rather than a raw WebSocket.
 *
 * @module apphost/stream
 */

import type { AstralObject } from '../astral/object.js';
import { isEos } from '../astral/object.js';
import type { Session } from './session.js';

/**
 * An async-iterable pipe over an accepted query's {@link Session}. Each iterated
 * item is an {@link AstralObject} the responder sent; iteration ends on `eos` or
 * socket close.
 */
export class Stream implements AsyncIterable<AstralObject> {
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  /** Send an object over the stream. */
  send(o: AstralObject): void {
    this.session.send(o);
  }

  /** Close the underlying session. Idempotent (the session's `close` is). */
  close(): void {
    this.session.close();
  }

  /** Yield inbound objects until the responder sends `eos` or the socket closes. */
  async *[Symbol.asyncIterator](): AsyncGenerator<AstralObject, void, undefined> {
    for (;;) {
      const o = await this.session.recv();
      if (o === null) return;
      if (isEos(o)) return;
      yield o;
    }
  }
}
