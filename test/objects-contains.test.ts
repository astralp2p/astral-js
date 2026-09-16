import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { Objects } from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const ID = 'data1ssqtd7j8z4xqz9mzs7xr5hqwxk9z4xqz9mzs7xr5hqwxk9z4xqz9mz';

/** Records the route_query it is sent, then replays `replies` as the response. */
function recordingTransport(replies: AstralObject[]) {
  const routed: Array<Record<string, unknown>> = [];

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] = [
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
          }
        },
        async recv(): Promise<AstralObject | null> {
          return queue.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };

  return { transport, routed };
}

function objectsOn(transport: Transport): Objects {
  return new Objects(new Host(transport, NODE, 'node', GUEST));
}

describe('Objects.contains', () => {
  // astrald tags Repo `query:"required"` on objects.contains
  // (mod/objects/src/op_contains.go:11, added by a476adf2), so a query without
  // it is rejected before the op runs. Verified live against astrald d48a3e83:
  // `objects.contains?id=…` answers QueryRejected (code 1) while the same query
  // with `repo=local` answers true.
  it('sends the repo argument astrald requires', async () => {
    const { transport, routed } = recordingTransport([{ type: 'bool', value: true }]);

    await objectsOn(transport).contains('local', ID);

    expect(routed[0]!.Query).toBe(`objects.contains?repo=local&id=${ID}`);
  });

  it('coerces the node bool to a JS boolean', async () => {
    const { transport } = recordingTransport([{ type: 'bool', value: true }]);

    await expect(objectsOn(transport).contains('local', ID)).resolves.toBe(true);
  });

  it('answers false when the repository does not hold the object', async () => {
    const { transport } = recordingTransport([{ type: 'bool', value: false }]);

    await expect(objectsOn(transport).contains('local', ID)).resolves.toBe(false);
  });

  it('carries a non-default repository name through', async () => {
    const { transport, routed } = recordingTransport([{ type: 'bool', value: false }]);

    await objectsOn(transport).contains('mem0', ID);

    expect(routed[0]!.Query).toBe(`objects.contains?repo=mem0&id=${ID}`);
  });
});
