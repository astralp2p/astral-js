import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { Apphost } from '../src/api/apphost/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const MINTED = parseIdentity('03' + 'd'.repeat(64));

const TOKEN = {
  Identity: MINTED,
  Token: 'b9c2e1a3d4f5867a',
  ExpiresAt: '2036-05-25T12:00:00+02:00',
};

/** Records the route_query it is sent, then replies with one access token. */
function registeringTransport() {
  const routed: Array<Record<string, unknown>> = [];

  const transport: Transport = {
    async open(): Promise<Session> {
      const replies: AstralObject[] = [
        { type: MessageTypes.QueryAccepted, value: {} },
        { type: 'apphost.access_token', value: { ...TOKEN } },
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
          return replies.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };

  return { transport, routed };
}

function apphostOn(transport: Transport): Apphost {
  return new Apphost(new Host(transport, NODE, 'node', GUEST));
}

describe('Apphost.register', () => {
  it('returns the minted credentials', async () => {
    const { transport } = registeringTransport();

    await expect(apphostOn(transport).register()).resolves.toEqual(TOKEN);
  });

  it('sends a bare query when no permits are asked for', async () => {
    const { transport, routed } = registeringTransport();

    await apphostOn(transport).register();

    expect(routed[0]!.Query).toBe('apphost.register');
  });

  it('sends a bare query for an empty permit list', async () => {
    const { transport, routed } = registeringTransport();

    await apphostOn(transport).register({ permits: [] });

    expect(routed[0]!.Query).toBe('apphost.register');
  });

  it('names a single asked-for action', async () => {
    const { transport, routed } = registeringTransport();

    await apphostOn(transport).register({
      permits: ['mod.objects.read_object_action'],
    });

    expect(routed[0]!.Query).toBe('apphost.register?permits=mod.objects.read_object_action');
  });

  it('joins several asked-for actions with a comma', async () => {
    const { transport, routed } = registeringTransport();

    await apphostOn(transport).register({
      permits: ['mod.objects.read_object_action', 'mod.user.swarm_access_action'],
    });

    expect(routed[0]!.Query).toBe(
      'apphost.register?permits=mod.objects.read_object_action%2Cmod.user.swarm_access_action',
    );
  });

  it('refuses a permit name carrying the separator', async () => {
    const { transport, routed } = registeringTransport();

    await expect(apphostOn(transport).register({ permits: ['one,two'] })).rejects.toThrow(TypeError);
    expect(routed).toHaveLength(0);
  });
});
