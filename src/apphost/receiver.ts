/**
 * The frame receiver: turns a socket's `message` events into an awaitable queue.
 *
 * Mirrors the reference client's `Receiver`. Each text frame is split on `\n`
 * (tolerating a coalescing relay that packs several NDJSON envelopes into one
 * frame), every non-blank line is `JSON.parse`d, read as a `{ Type, Object }`
 * envelope by {@link readEnvelope} and {@link unwrap}ped into a friendly
 * {@link AstralObject}, then enqueued. {@link Receiver.next} resolves the next
 * object, or `null` once the socket closes. Non-string frames and malformed
 * lines are skipped — a line whose container does not conform counts as
 * malformed, so a corrupted value is dropped rather than delivered.
 *
 * @module apphost/receiver
 */

import { readEnvelope } from '../astral/envelope.js';
import type { AstralObject, WireEnvelope } from '../astral/object.js';
import { unwrap } from '../astral/object.js';
import type { MessageEventLike, WebSocketLike } from './transport.js';

/** Wraps a {@link WebSocketLike} so inbound frames can be consumed one await at a time. */
export class Receiver {
  private readonly queue: AstralObject[] = [];
  private readonly waiters: ((value: AstralObject | null) => void)[] = [];
  private closed = false;

  constructor(ws: WebSocketLike) {
    ws.addEventListener('message', (event) => {
      const { data } = event as MessageEventLike;
      if (typeof data !== 'string') return; // ignore binary frames in JSON mode
      // The server sends one envelope per frame, but tolerate frames carrying
      // several newline-delimited envelopes (e.g. a coalescing relay).
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let env: WireEnvelope;
        try {
          // readEnvelope, not a cast: a frame whose container carries an
          // unrecognised key would otherwise unwrap to a well-formed object with
          // a null value, which reads downstream as a real answer.
          env = readEnvelope(JSON.parse(line), 'frame');
        } catch {
          continue;
        }
        const obj = unwrap(env);
        const waiter = this.waiters.shift();
        if (waiter) waiter(obj);
        else this.queue.push(obj);
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(null);
      }
    });
  }

  /** Resolve the next {@link AstralObject}, or `null` once the socket has closed. */
  next(): Promise<AstralObject | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
