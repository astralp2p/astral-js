import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { User } from '../src/api/user/index.js';

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

function userOn(transport: Transport): User {
  return new User(new Host(transport, NODE, 'node', GUEST));
}

describe('User.adopt', () => {
  it('sends the node as identity', async () => {
    const signed: AstralObject = { type: 'mod.auth.signed_contract', value: {} };
    const { transport, routed } = recordingTransport([signed]);

    const contract = await userOn(transport).adopt(PEER);

    expect(routed[0]!.Query).toBe(`user.adopt?identity=${PEER}`);
    expect(contract).toEqual(signed);
  });
});

describe('User.expel', () => {
  it('sends the node as identity', async () => {
    const ban: AstralObject = { type: 'mod.user.signed_expulsion', value: {} };
    const { transport, routed } = recordingTransport([ban]);

    const expulsion = await userOn(transport).expel('phone');

    expect(routed[0]!.Query).toBe('user.expel?identity=phone');
    expect(expulsion).toEqual(ban);
  });
});
