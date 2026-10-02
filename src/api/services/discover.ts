// api/services/discover — read a services.discover stream into events.

import type { Host } from '../../apphost/host.js';
import type { Stream } from '../../apphost/stream.js';
import { isEos, isError } from '../../astral/object.js';
import { AstralError, ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';
import { Ops, Types } from './consts.js';
import { joinNames } from './names.js';
import type { DiscoveryEvent, OfferingKeyValue, ServiceUpdateValue } from './types.js';

/**
 * Thrown when a discovery stream closes where the protocol does not end it:
 * before the initial outcome, or at any point while following.
 */
export class StreamEnded extends AstralError {
  constructor() {
    super('discovery stream ended');
  }
}

/**
 * A discovery's events. `close` ends the stream at once, even while an
 * iteration waits for the next event; that iteration then ends with
 * {@link StreamEnded}.
 */
export type DiscoveryStream = AsyncIterable<DiscoveryEvent> & { close(): void };

/**
 * Discover `names` for this app on the host's node.
 *
 * Yields each offering view, each removal, and one `initial` event when the
 * initial attempt ends. Without `follow` the iterable completes after the
 * `initial` event; with `follow` it continues until the caller stops iterating.
 * A refusal or a stream that ends early throws from the iteration.
 */
export async function discover(
  host: Host,
  names: readonly string[],
  follow = false,
): Promise<DiscoveryStream> {
  const stream = await host.query(Ops.discover, {
    args: { services: joinNames(names), follow: follow ? true : undefined },
  });
  return {
    [Symbol.asyncIterator]: () => readDiscovery(stream, follow),
    close: () => stream.close(),
  };
}

async function* readDiscovery(
  stream: Stream,
  follow: boolean,
): AsyncGenerator<DiscoveryEvent, void, undefined> {
  let incomplete: string[] | null = null;
  let boundary = false;
  try {
    for await (const o of stream.frames()) {
      if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
      if (isEos(o)) {
        boundary = true;
        yield {
          kind: 'initial',
          outcome: { complete: incomplete === null, incomplete: incomplete ?? [] },
        };
        if (!follow) return;
        continue;
      }
      switch (o.type) {
        case Types.update:
          yield { kind: 'update', update: o.value as ServiceUpdateValue };
          break;
        case Types.removed:
          yield {
            kind: 'removed',
            offerings: (o.value as { Offerings: OfferingKeyValue[] | null }).Offerings ?? [],
          };
          break;
        case Types.incomplete:
          incomplete = (o.value as { Services: string[] | null }).Services ?? [];
          break;
        default:
          throw new ProtocolError(`unexpected object in discovery: ${o.type}`);
      }
    }
    if (!boundary || follow) throw new StreamEnded();
  } finally {
    stream.close();
  }
}
