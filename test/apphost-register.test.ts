import { describe, expect, it } from 'vitest';
import { Host } from '../src/apphost/index.js';
import type { Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, QueryRejected, RemoteError } from '../src/astral/errors.js';
import { Apphost } from '../src/api/apphost/index.js';
import { discoveryPermit } from '../src/api/services/index.js';
import { GUEST, NODE, recordingTransport } from './helpers/recording-transport.js';

const MINTED = parseIdentity('03' + 'd'.repeat(64));

const TOKEN = {
  Identity: MINTED,
  Token: 'b9c2e1a3d4f5867a',
  ExpiresAt: '2036-05-25T12:00:00+02:00',
};

const TOKEN_REPLY: AstralObject = { type: 'apphost.access_token', value: { ...TOKEN } };

function apphostOn(transport: Transport): Apphost {
  return new Apphost(new Host(transport, NODE, 'node', GUEST));
}

describe('Apphost.register', () => {
  it('returns the minted credentials', async () => {
    const { transport, closes } = recordingTransport([TOKEN_REPLY]);

    await expect(apphostOn(transport).register()).resolves.toEqual(TOKEN);
    expect(closes()).toBe(1);
  });

  it.each([
    ['no options', undefined],
    ['an empty permit list', { permits: [] }],
    ['a name and permits', { name: 'x', permits: ['a.b'], contractPermits: ['c.d'] }],
  ])('sends a bare apphost.register query for %s', async (_, opts) => {
    const { transport, routed, closes } = recordingTransport([TOKEN_REPLY]);

    await apphostOn(transport).register(opts);

    expect(routed[0]!.Query).toBe('apphost.register');
    expect(closes()).toBe(1);
  });

  it('streams one empty register_request and no eos for a bare register()', async () => {
    const { transport, streamed, closes } = recordingTransport([TOKEN_REPLY]);

    await apphostOn(transport).register();

    expect(streamed).toEqual([
      {
        type: 'mod.apphost.register_request',
        value: { Name: '', GrantPermits: [], ContractPermits: [] },
      },
    ]);
    expect(closes()).toBe(1);
  });

  it('sends string permits as GrantPermits without constraints', async () => {
    const { transport, streamed, closes } = recordingTransport([TOKEN_REPLY]);

    await apphostOn(transport).register({
      permits: ['mod.auth.see_objects_action', 'mod.user.see_swarm_action'],
    });

    expect((streamed[0]!.value as Record<string, unknown>).GrantPermits).toEqual([
      { Action: 'mod.auth.see_objects_action', Constraints: null, Delegation: 0 },
      { Action: 'mod.user.see_swarm_action', Constraints: null, Delegation: 0 },
    ]);
    expect(closes()).toBe(1);
  });

  it('sends name as Name and contractPermits as ContractPermits', async () => {
    const { transport, streamed, closes } = recordingTransport([TOKEN_REPLY]);

    await apphostOn(transport).register({
      name: 'My App',
      contractPermits: ['mod.auth.see_objects_action'],
    });

    expect(streamed[0]!.value).toEqual({
      Name: 'My App',
      GrantPermits: [],
      ContractPermits: [
        { Action: 'mod.auth.see_objects_action', Constraints: null, Delegation: 0 },
      ],
    });
    expect(closes()).toBe(1);
  });

  it('passes a constrained permit through intact', async () => {
    const { transport, streamed, closes } = recordingTransport([TOKEN_REPLY]);
    const scoped = discoveryPermit(['inference']);

    await apphostOn(transport).register({ permits: [scoped] });

    expect((streamed[0]!.value as Record<string, unknown>).GrantPermits).toEqual([scoped]);
    expect(closes()).toBe(1);
  });

  it('sends exactly the register_request fields', async () => {
    const { transport, streamed, closes } = recordingTransport([TOKEN_REPLY]);

    await apphostOn(transport).register({ name: 'x', permits: ['a.b'] });

    expect(Object.keys(streamed[0]!.value as object).sort()).toEqual([
      'ContractPermits',
      'GrantPermits',
      'Name',
    ]);
    expect(closes()).toBe(1);
  });

  it('refuses an invalid permit before routing', async () => {
    const { transport, routed, closes } = recordingTransport([TOKEN_REPLY]);

    await expect(apphostOn(transport).register({ permits: [''] })).rejects.toThrow(TypeError);
    expect(routed).toHaveLength(0);
    expect(closes()).toBe(0);
  });

  it('surfaces a policy refusal as a RemoteError', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'registration declined' },
    ]);

    const err = await apphostOn(transport)
      .register()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as Error).message).toBe('registration declined');
    expect(closes()).toBe(1);
  });

  it('refuses a stream that ends without a token', async () => {
    const { transport, closes } = recordingTransport([]);

    await expect(apphostOn(transport).register()).rejects.toThrow(ProtocolError);
    expect(closes()).toBe(1);
  });

  it('refuses a foreign reply type', async () => {
    const { transport, closes } = recordingTransport([{ type: 'string8', value: 'x' }]);

    await expect(apphostOn(transport).register()).rejects.toThrow(ProtocolError);
    expect(closes()).toBe(1);
  });

  it('surfaces a query_rejected as a QueryRejected', async () => {
    const { transport, closes } = recordingTransport([], 1);

    await expect(apphostOn(transport).register()).rejects.toThrow(QueryRejected);
    expect(closes()).toBe(1);
  });
});
