// api/services/watch — follow a discovery and keep the current offerings.

import type { Host } from '../../apphost/host.js';
import { RemoteError } from '../../astral/errors.js';
import { discover, type DiscoverOptions, type DiscoveryStream } from './discover.js';
import { joinNames } from './names.js';
import {
  offeringKey,
  type DiscoveryEvent,
  type InitialOutcome,
  type ServiceUpdateValue,
} from './types.js';

/** The waits between reopened follows, in milliseconds. */
export interface ReconnectOptions {
  /** The first wait; 1000 when omitted. */
  minMs?: number;
  /** The longest wait; 30000 when omitted. */
  maxMs?: number;
}

/** Options for {@link watch}. */
export interface WatchOptions extends DiscoverOptions {
  /**
   * Reopen the follow after its stream ends. The wait starts at `minMs`,
   * doubles up to `maxMs`, and returns to `minMs` after a follow that reached
   * its boundary.
   */
  reconnect?: boolean | ReconnectOptions;
}

type Open = () => Promise<DiscoveryStream>;

interface Backoff {
  minMs: number;
  maxMs: number;
}

/**
 * The current set of available offerings for a followed discovery.
 *
 * Without `reconnect` it follows one stream: once {@link Watcher.done} settles
 * the app starts a new one. With `reconnect` it reopens the follow with
 * backoff after the stream ends, keeps the set it held marked
 * {@link Watcher.stale} until the reopened follow's boundary, and then applies
 * the difference in one step: one change and one synced event.
 */
export class Watcher {
  private readonly current = new Map<string, ServiceUpdateValue>();
  private readonly listeners = new Set<() => void>();
  private readonly syncedListeners = new Set<() => void>();
  private readonly open: Open;
  private readonly backoff: Backoff | null;
  private events: DiscoveryStream | null;
  private staging: Map<string, ServiceUpdateValue | null> | null = null;
  private isStale = false;
  private settled = false;
  private closed = false;
  private wake: (() => void) | null = null;
  private resolveInitial!: (o: InitialOutcome) => void;
  private rejectInitial!: (err: unknown) => void;

  /**
   * Resolves with the outcome of the watcher's first boundary; rejects if the
   * watcher stops before any boundary.
   */
  readonly initial: Promise<InitialOutcome>;
  /** Resolves when the watcher is closed; rejects with the error that ended it. */
  readonly done: Promise<void>;

  /** @internal */
  constructor(open: Open, backoff: Backoff | null, first: DiscoveryStream | null) {
    this.open = open;
    this.backoff = backoff;
    this.events = first;
    this.initial = new Promise((resolve, reject) => {
      this.resolveInitial = resolve;
      this.rejectInitial = reject;
    });
    // why: an app that only listens to onChange never awaits initial; its
    // rejection must not surface as unhandled.
    this.initial.catch(() => {});
    this.done = backoff ? this.runReconnecting(backoff) : this.run();
  }

  /** The available offerings, in no particular order. */
  offerings(): ServiceUpdateValue[] {
    return [...this.current.values()];
  }

  /**
   * True from the end of a stream until a reopened follow's complete
   * boundary. An incomplete boundary keeps the offerings it did not show, and
   * the set stays stale.
   */
  stale(): boolean {
    return this.isStale;
  }

  /** Call `listener` after every change to {@link Watcher.offerings}. Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Call `listener` at every boundary, the first follow's and every reopened
   * follow's, after its outcome is applied. Returns an unsubscribe.
   */
  onSynced(listener: () => void): () => void {
    this.syncedListeners.add(listener);
    return () => this.syncedListeners.delete(listener);
  }

  /** Stop following. Idempotent. */
  close(): void {
    this.closed = true;
    this.events?.close();
    this.wake?.();
  }

  /** @internal */
  apply(ev: DiscoveryEvent): void {
    if (ev.kind === 'initial') {
      this.boundary(ev.outcome);
      return;
    }
    if (this.staging) {
      this.stage(ev);
      return;
    }
    switch (ev.kind) {
      case 'update':
        if (ev.update.Available) this.current.set(offeringKey(ev.update), ev.update);
        else this.current.delete(offeringKey(ev.update));
        break;
      case 'removed':
        for (const k of ev.offerings) this.current.delete(offeringKey(k));
        break;
    }
    this.notify(this.listeners);
  }

  private stage(ev: DiscoveryEvent): void {
    const staging = this.staging!;
    if (ev.kind === 'update') staging.set(offeringKey(ev.update), ev.update);
    if (ev.kind === 'removed') for (const k of ev.offerings) staging.set(offeringKey(k), null);
  }

  private boundary(outcome: InitialOutcome): void {
    const staged = this.staging !== null;
    if (staged) this.settle(outcome);
    if (!this.settled) {
      this.settled = true;
      this.resolveInitial(outcome);
    }
    if (staged) this.notify(this.listeners);
    this.notify(this.syncedListeners);
  }

  // why only a complete outcome prunes: an offering missing from an
  // incomplete outcome may belong to a member that did not answer in time.
  private settle(outcome: InitialOutcome): void {
    const staging = this.staging!;
    for (const [k, u] of staging) {
      if (u?.Available) this.current.set(k, u);
      else this.current.delete(k);
    }
    if (outcome.complete) {
      for (const k of [...this.current.keys()]) if (!staging.has(k)) this.current.delete(k);
    }
    this.isStale = !outcome.complete;
    this.staging = null;
  }

  private notify(listeners: Set<() => void>): void {
    for (const l of listeners) l();
  }

  /** Follows one stream; returns whether it reached its boundary. */
  private async follow(events: DiscoveryStream): Promise<boolean> {
    let reached = false;
    for await (const ev of events) {
      if (ev.kind === 'initial') reached = true;
      this.apply(ev);
    }
    return reached;
  }

  private async run(): Promise<void> {
    try {
      await this.follow(this.events!);
    } catch (err) {
      this.rejectInitial(err);
      if (!this.closed) throw err;
    }
    this.rejectInitial(new Error('discovery closed'));
  }

  // why the reset: a node that admits a follow and drops it at once would
  // otherwise be reopened in a tight loop.
  // why only the first refusal stops: a refusal before the first boundary is
  // an admission error, while a restarting node can briefly refuse a reopen.
  private async runReconnecting(b: Backoff): Promise<void> {
    let delay = b.minMs;
    for (let first = true; ; first = false) {
      let reached = false;
      let err: unknown = null;
      try {
        this.events = await this.open();
        if (this.closed) this.events.close();
        reached = await this.follow(this.events);
      } catch (e) {
        err = e;
      }
      if (this.closed) break;
      if (first && !reached && err instanceof RemoteError) {
        this.rejectInitial(err);
        throw err;
      }
      this.reopen();
      if (reached) delay = b.minMs;
      await this.sleep(delay);
      if (this.closed) break;
      delay = Math.min(delay * 2, b.maxMs);
    }
    this.rejectInitial(new Error('discovery closed'));
  }

  private reopen(): void {
    const turned = !this.isStale;
    this.isStale = true;
    this.staging = new Map();
    if (turned) this.notify(this.listeners);
  }

  /** Waits `ms`, or until {@link Watcher.close}. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/**
 * Follow `names` on the host's node, or across its swarm with `reach: 'swarm'`.
 * With `reconnect` the names are checked and the watcher opens the follow
 * itself, so a node that is not up yet does not reject the call.
 */
export async function watch(
  host: Host,
  names: readonly string[],
  opts: WatchOptions = {},
): Promise<Watcher> {
  const open = () => discover(host, names, true, opts);
  if (!opts.reconnect) return new Watcher(open, null, await open());
  joinNames(names);
  const r = opts.reconnect === true ? {} : opts.reconnect;
  const minMs = r.minMs && r.minMs > 0 ? r.minMs : 1000;
  const maxMs = Math.max(r.maxMs && r.maxMs > 0 ? r.maxMs : 30000, minMs);
  return new Watcher(open, { minMs, maxMs }, null);
}
