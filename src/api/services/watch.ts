// api/services/watch — follow a discovery and keep the current offerings.

import type { Host } from '../../apphost/host.js';
import { discover, type DiscoverOptions, type DiscoveryStream } from './discover.js';
import {
  offeringKey,
  type DiscoveryEvent,
  type InitialOutcome,
  type ServiceUpdateValue,
} from './types.js';

/**
 * The current set of available offerings for a followed discovery. It has no
 * reconnect policy: once {@link Watcher.done} settles the app starts a new one.
 */
export class Watcher {
  private readonly current = new Map<string, ServiceUpdateValue>();
  private readonly listeners = new Set<() => void>();
  private readonly events: DiscoveryStream;
  private closed = false;
  private resolveInitial!: (o: InitialOutcome) => void;
  private rejectInitial!: (err: unknown) => void;

  /** Resolves with the initial outcome; rejects if the stream ends first. */
  readonly initial: Promise<InitialOutcome>;
  /** Resolves when the watcher is closed; rejects with the error that ended it. */
  readonly done: Promise<void>;

  /** @internal */
  constructor(events: DiscoveryStream) {
    this.events = events;
    this.initial = new Promise((resolve, reject) => {
      this.resolveInitial = resolve;
      this.rejectInitial = reject;
    });
    // why: an app that only listens to onChange never awaits initial; its
    // rejection must not surface as unhandled.
    this.initial.catch(() => {});
    this.done = this.run();
  }

  /** The available offerings, in no particular order. */
  offerings(): ServiceUpdateValue[] {
    return [...this.current.values()];
  }

  /** Call `listener` after every change to {@link Watcher.offerings}. Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop following. Idempotent. */
  close(): void {
    this.closed = true;
    this.events.close();
  }

  /** @internal */
  apply(ev: DiscoveryEvent): void {
    switch (ev.kind) {
      case 'update':
        if (ev.update.Available) this.current.set(offeringKey(ev.update), ev.update);
        else this.current.delete(offeringKey(ev.update));
        break;
      case 'removed':
        for (const k of ev.offerings) this.current.delete(offeringKey(k));
        break;
      case 'initial':
        this.resolveInitial(ev.outcome);
        return;
    }
    for (const l of this.listeners) l();
  }

  private async run(): Promise<void> {
    try {
      for await (const ev of this.events) this.apply(ev);
    } catch (err) {
      this.rejectInitial(err);
      if (!this.closed) throw err;
    }
    this.rejectInitial(new Error('discovery closed'));
  }
}

/** Follow `names` on the host's node, or across its swarm with `reach: 'swarm'`. */
export async function watch(
  host: Host,
  names: readonly string[],
  opts: DiscoverOptions = {},
): Promise<Watcher> {
  return new Watcher(await discover(host, names, true, opts));
}
