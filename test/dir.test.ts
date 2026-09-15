import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { ack, error, parseIdentity, RemoteError, type AstralObject } from '../src/astral/index.js';
import { Dir } from '../src/api/dir/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const PEER = parseIdentity('03' + 'b'.repeat(64));

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

function dirOn(transport: Transport): Dir {
  return new Dir(new Host(transport, NODE, 'node', GUEST));
}

describe('Dir.resolve', () => {
  it('sends the name as identity and decodes the identity', async () => {
    const { transport, routed } = recordingTransport([{ type: 'identity', value: PEER }]);

    const id = await dirOn(transport).resolve('alice');

    expect(routed[0]!.Query).toBe('dir.resolve?identity=alice');
    expect(id).toBe(PEER);
  });
});

describe('Dir.getAlias', () => {
  it('sends the identity as identity and returns the alias', async () => {
    const { transport, routed } = recordingTransport([{ type: 'string8', value: 'alice' }]);

    const alias = await dirOn(transport).getAlias(PEER);

    expect(routed[0]!.Query).toBe(`dir.get_alias?identity=${PEER}`);
    expect(alias).toBe('alice');
  });

  it('surfaces the zero-identity refusal as a RemoteError', async () => {
    const { transport } = recordingTransport([error('missing identity')]);

    const call = dirOn(transport).getAlias('anyone');

    await expect(call).rejects.toThrow(RemoteError);
    await expect(call).rejects.toThrow('missing identity');
  });
});

describe('Dir.setAlias', () => {
  it('sends the identity as identity alongside the alias', async () => {
    const { transport, routed } = recordingTransport([ack()]);

    await dirOn(transport).setAlias(PEER, 'alice');

    expect(routed[0]!.Query).toBe(`dir.set_alias?identity=${PEER}&alias=alice`);
  });

  it('sends an empty alias to clear it', async () => {
    const { transport, routed } = recordingTransport([ack()]);

    await dirOn(transport).setAlias('localnode');

    expect(routed[0]!.Query).toBe('dir.set_alias?identity=localnode&alias=');
  });
});
