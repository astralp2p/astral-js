// test/helpers/recording-transport — a scripted apphost transport for protocol client tests.

import { MessageTypes } from '../../src/apphost/index.js';
import type { Session, Transport } from '../../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../../src/astral/index.js';

export const NODE = parseIdentity('02' + 'a'.repeat(64));
export const GUEST = parseIdentity('02' + 'c'.repeat(64));

/**
 * Records the route_query it is sent and every object streamed after it, then
 * replays `replies` as the response. `rejectCode` answers the route_query with
 * a query_rejected_msg instead.
 */
export function recordingTransport(replies: AstralObject[], rejectCode?: number) {
  const routed: Array<Record<string, unknown>> = [];
  const streamed: AstralObject[] = [];
  let closed = 0;

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] =
        rejectCode !== undefined
          ? [{ type: MessageTypes.QueryRejected, value: { Code: rejectCode } }]
          : [
              { type: MessageTypes.QueryAccepted, value: {} },
              ...replies,
              { type: 'eos', value: null },
            ];
      return {
        hostInfo: { identity: NODE, alias: 'node' },
        guestID: GUEST,
        send(o: AstralObject) {
          if (o.type === MessageTypes.RouteQuery) {
            routed.push(o.value as Record<string, unknown>);
          } else {
            streamed.push(o);
          }
        },
        async recv(): Promise<AstralObject | null> {
          return queue.shift() ?? null;
        },
        close() {
          closed++;
        },
      } as unknown as Session;
    },
  };

  return { transport, routed, streamed, closes: () => closed };
}
