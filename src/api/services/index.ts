// api/services — the services protocol: advertise offerings, discover them.
//
// Spec: .ai/system/protocols/services/. Mirrors astral-go api/services/client.

import type { Host } from '../../apphost/host.js';
import { advertise, type Binding, type OfferingHandler } from './advertise.js';
import { discover, type DiscoveryStream } from './discover.js';
import { watch, type Watcher } from './watch.js';

export { Ops, Types, UPDATE_TYPE, MAX_NAMES } from './consts.js';
export { joinNames, validateName } from './names.js';
export { offeringKey } from './types.js';
export type {
  AskValue,
  DiscoveryEvent,
  InitialOutcome,
  OfferingKeyValue,
  ServiceUpdateValue,
} from './types.js';
export { discover, StreamEnded, type DiscoveryStream } from './discover.js';
export { advertise, Binding, type Offering, type OfferingHandler } from './advertise.js';
export { watch, Watcher } from './watch.js';

/**
 * A client for the node's `services` protocol, bound to a connected
 * {@link Host}.
 *
 * @example
 * ```ts
 * const services = new Services(host);
 *
 * // Provide: answer each caller's view of "player".
 * const binding = await services.advertise({ player: () => ({ available: true }) });
 *
 * // Consume: follow the players this app may discover.
 * const w = await services.watch(['player']);
 * w.onChange(() => console.log(w.offerings()));
 * ```
 */
export class Services {
  private readonly host: Host;

  constructor(host: Host) {
    this.host = host;
  }

  /** See {@link advertise}. */
  advertise(handlers: Readonly<Record<string, OfferingHandler>>): Promise<Binding> {
    return advertise(this.host, handlers);
  }

  /** See {@link discover}. */
  discover(names: readonly string[], follow = false): Promise<DiscoveryStream> {
    return discover(this.host, names, follow);
  }

  /** See {@link watch}. */
  watch(names: readonly string[]): Promise<Watcher> {
    return watch(this.host, names);
  }
}
