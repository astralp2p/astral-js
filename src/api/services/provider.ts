// api/services/provider — keep an advertisement open while the app runs.
//
// Spec: .ai/system/protocols/services/ops/services.advertise.md#liveness.
// Mirrors astral-go api/services/client Provider.

import type { Host } from '../../apphost/host.js';
import type { Identity } from '../../astral/identity.js';
import { RemoteError } from '../../astral/errors.js';
import { advertise, type Binding, type OfferingHandler } from './advertise.js';
import type { ReconnectOptions } from './watch.js';

/** The node's refusal of a name the provider already holds. */
const ADVERTISED = 'service already advertised by this provider';

/** Retry of a refusal naming an already held service, in milliseconds. */
const REFUSAL_FIRST_MS = 250;
const REFUSAL_MAX_MS = 4000;
const REFUSAL_FOR_MS = 30000;

/** Options for {@link provide}. */
export interface ProvideOptions {
  /**
   * The waits before advertising again after a failure other than the
   * refusal of a held name, such as a node that is down. 1000 to 30000 ms
   * when omitted.
   */
  retry?: ReconnectOptions;
}

type Open = () => Promise<Binding>;

/**
 * An advertisement that stays open while the app runs: whenever the node ends
 * the binding, the provider advertises again. A provider that hangs never
 * advertises again, so a binding the node ended for unanswered asks stays
 * ended.
 */
export class Provider {
  private binding: Binding | null;
  private readonly open: Open;
  private readonly minMs: number;
  private readonly maxMs: number;
  private closed = false;
  private wake: (() => void) | null = null;

  /** Resolves when the provider is closed. */
  readonly done: Promise<void>;

  /** @internal */
  constructor(open: Open, first: Binding, opts: ProvideOptions) {
    this.open = open;
    this.binding = first;
    this.minMs = opts.retry?.minMs ?? 1000;
    this.maxMs = opts.retry?.maxMs ?? 30000;
    this.done = this.keep();
  }

  /** The open binding, or `null` while the provider advertises again. */
  current(): Binding | null {
    return this.binding;
  }

  /** See {@link Binding.change}. Does nothing while no binding is open. */
  change(...callers: Identity[]): void {
    this.binding?.change(...callers);
  }

  /** See {@link Binding.changeAll}. Does nothing while no binding is open. */
  changeAll(): void {
    this.binding?.changeAll();
  }

  /** Stop advertising: end the open binding and open no other. Idempotent. */
  close(): void {
    this.closed = true;
    this.binding?.close();
    this.wake?.();
  }

  private async keep(): Promise<void> {
    let delay = this.minMs;
    while (!this.closed) {
      if (this.binding) {
        await this.binding.done.catch(() => {});
        this.binding = null;
        continue;
      }
      try {
        const b = await this.open();
        if (this.closed) {
          b.close();
          break;
        }
        this.binding = b;
        delay = this.minMs;
      } catch {
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.maxMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

/** Advertise, retrying the refusal of a held name from 250 ms to 4 s for 30 s. */
async function openRetrying(
  host: Host,
  handlers: Readonly<Record<string, OfferingHandler>>,
): Promise<Binding> {
  const deadline = Date.now() + REFUSAL_FOR_MS;
  for (let delay = REFUSAL_FIRST_MS; ; delay = Math.min(delay * 2, REFUSAL_MAX_MS)) {
    try {
      return await advertise(host, handlers);
    } catch (e) {
      // why: right after a reconnect the node can still hold the previous
      // binding until it notices that binding closed.
      const held = e instanceof RemoteError && e.message === ADVERTISED;
      if (!held || Date.now() + delay > deadline) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Advertise the services `handlers` names and keep them advertised: whenever
 * the node ends the binding, advertise again.
 *
 * Resolves once the node acknowledges the first binding. Retries the refusal
 * of a held name for up to 30 s, and rejects with any other error at once.
 */
export async function provide(
  host: Host,
  handlers: Readonly<Record<string, OfferingHandler>>,
  opts: ProvideOptions = {},
): Promise<Provider> {
  const open = () => openRetrying(host, handlers);
  return new Provider(open, await open(), opts);
}
