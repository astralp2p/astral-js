// api/services/advertise — bind this app as the provider of a set of services.

import type { Host } from '../../apphost/host.js';
import type { Stream } from '../../apphost/stream.js';
import type { Identity } from '../../astral/identity.js';
import { isAck, isError, obj, wrap, type AstralObject } from '../../astral/object.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';
import { Ops, Types } from './consts.js';
import { joinNames } from './names.js';
import type { AskValue } from './types.js';

/** What a provider offers one caller. */
export interface Offering {
  /** Defaults to `true`. */
  available?: boolean;
  /** The offering's info objects, sent as its bundle. */
  info?: AstralObject[];
}

/**
 * Evaluates one service for one caller. Returning `null` or throwing offers the
 * caller nothing.
 */
export type OfferingHandler = (caller: Identity) => Offering | null | Promise<Offering | null>;

/**
 * A live advertisement. The node asks it for each caller's offering until it
 * closes; closing it withdraws every service it holds.
 */
export class Binding {
  private readonly stream: Stream;
  /** Resolves when the binding ends, from either side. */
  readonly done: Promise<void>;

  /** @internal */
  constructor(stream: Stream, handlers: Readonly<Record<string, OfferingHandler>>) {
    this.stream = stream;
    this.done = this.serve(handlers);
  }

  /** Tell the node these callers' offerings may have changed. No callers: no-op. */
  change(...callers: Identity[]): void {
    if (callers.length === 0) return;
    this.stream.send(obj(Types.change, { All: false, Callers: callers }));
  }

  /** Tell the node every following caller's offerings may have changed. */
  changeAll(): void {
    this.stream.send(obj(Types.change, { All: true, Callers: null }));
  }

  /** End the binding. Idempotent. */
  close(): void {
    this.stream.close();
  }

  private async serve(handlers: Readonly<Record<string, OfferingHandler>>): Promise<void> {
    try {
      for await (const o of this.stream.frames()) {
        if (o.type !== Types.ask) break;
        // note: asks are answered concurrently; the node already sends at most
        // one per caller at a time.
        void this.answer(o.value as AskValue, handlers[(o.value as AskValue).Service]);
      }
    } finally {
      this.stream.close();
    }
  }

  private async answer(ask: AskValue, handler: OfferingHandler | undefined): Promise<void> {
    let offering: Offering | null = null;
    try {
      offering = handler ? await handler(ask.CallerID) : null;
    } catch {
      offering = null;
    }
    const update = {
      Available: offering !== null && offering.available !== false,
      Name: ask.Service,
      ProviderID: null,
      Info: offering?.info?.map(wrap) ?? null,
    };
    try {
      this.stream.send(obj(Types.answer, { RequestID: ask.RequestID, Update: update }));
    } catch {
      // note: the binding closed while the handler ran; nothing is owed.
    }
  }
}

/**
 * Advertise the services `handlers` names on the host's node, as this app.
 *
 * Resolves once the node acknowledges the binding. Rejects with
 * {@link RemoteError} when the node refuses it, for instance because this app
 * already holds one of the names. Re-advertising after a disconnect is left to
 * the app.
 */
export async function advertise(
  host: Host,
  handlers: Readonly<Record<string, OfferingHandler>>,
): Promise<Binding> {
  const stream = await host.query(Ops.advertise, {
    args: { services: joinNames(Object.keys(handlers)) },
  });

  const first = await stream.frames().next();
  if (first.done || !isAck(first.value)) {
    stream.close();
    if (!first.done && isError(first.value)) {
      throw new RemoteError(readErrorMessage(first.value) ?? 'remote error');
    }
    throw new ProtocolError('services.advertise was not acknowledged');
  }

  return new Binding(stream, handlers);
}
