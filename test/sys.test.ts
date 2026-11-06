import { describe, expect, it } from 'vitest';
import { Host } from '../src/apphost/index.js';
import type { Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, RemoteError } from '../src/astral/errors.js';
import { Ops, Policies, Refusals, Sys, Types } from '../src/api/sys/index.js';
import * as apphost from '../src/api/apphost/index.js';
import { GUEST, NODE, recordingTransport } from './helpers/recording-transport.js';

const MINTED = parseIdentity('03' + 'd'.repeat(64));

const TOKEN = {
  Identity: MINTED,
  Token: 'b9c2e1a3d4f5867a',
  ExpiresAt: '2036-05-25T12:00:00+02:00',
};

const TOKEN_REPLY: AstralObject = { type: 'apphost.access_token', value: { ...TOKEN } };

function sysOn(transport: Transport): Sys {
  return new Sys(new Host(transport, NODE, 'node', GUEST));
}

describe('sys consts', () => {
  it('names the sys op and wire types', () => {
    expect(Ops.registerManager).toBe('sys.register_manager');
    expect(Types.registerManagerRequest).toBe('mod.sys.register_manager_request');
    expect(Types.policyBinding).toBe('mod.sys.policy_binding');
  });

  it('leaves no manager appointment in apphost', () => {
    expect(apphost.Ops).not.toHaveProperty('registerManager');
    expect(apphost.Types).not.toHaveProperty('registerManagerRequest');
    expect(apphost.Types).not.toHaveProperty('policyBinding');
    expect(apphost.Refusals).not.toHaveProperty('notFresh');
    expect(apphost).not.toHaveProperty('Policies');
    expect(apphost.Apphost.prototype).not.toHaveProperty('registerManager');
  });
});

describe('Sys.registerManager', () => {
  it('streams one register_manager_request and returns the manager token', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([TOKEN_REPLY]);

    const token = await sysOn(transport).registerManager({
      name: 'control-plane',
      permits: ['mod.user.see_swarm_action'],
      policies: [
        { policy: Policies.appRegister, operation: 'cp.approve_app' },
        { policy: Policies.swarmJoin, operation: 'cp.approve_join', timeoutMs: 300000 },
      ],
    });

    expect(token).toEqual(TOKEN);
    expect(routed[0]!.Query).toBe('sys.register_manager');
    expect(streamed).toEqual([
      {
        type: 'mod.sys.register_manager_request',
        value: {
          Name: 'control-plane',
          GrantPermits: [{ Action: 'mod.user.see_swarm_action', Constraints: null, Delegation: 0 }],
          ContractPermits: [],
          Policies: [
            { Policy: 'app_register', Operation: 'cp.approve_app', Timeout: 0 },
            { Policy: 'swarm_join', Operation: 'cp.approve_join', Timeout: 300000000000 },
          ],
        },
      },
    ]);
    expect(closes()).toBe(1);
  });

  it('streams an empty request for a bare registerManager()', async () => {
    const { transport, streamed } = recordingTransport([TOKEN_REPLY]);

    await sysOn(transport).registerManager();

    expect(streamed).toEqual([
      {
        type: 'mod.sys.register_manager_request',
        value: { Name: '', GrantPermits: [], ContractPermits: [], Policies: [] },
      },
    ]);
  });

  it('names the five policies', () => {
    expect(Object.values(Policies)).toEqual([
      'app_register',
      'grant_request',
      'swarm_join',
      'swarm_invite',
      'contract_accept',
    ]);
  });

  it('refuses a malformed permit or timeout before routing', async () => {
    const { transport, routed } = recordingTransport([TOKEN_REPLY]);
    const sys = sysOn(transport);

    await expect(sys.registerManager({ permits: [''] })).rejects.toThrow(TypeError);
    await expect(
      sys.registerManager({
        policies: [{ policy: Policies.appRegister, operation: 'x', timeoutMs: -1 }],
      }),
    ).rejects.toThrow(RangeError);
    expect(routed).toHaveLength(0);
  });

  it('surfaces node is not fresh as a RemoteError', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'node is not fresh' },
    ]);

    await expect(sysOn(transport).registerManager()).rejects.toThrow(
      new RemoteError(Refusals.notFresh),
    );
    expect(Refusals.notFresh).toBe('node is not fresh');
    expect(closes()).toBe(1);
  });

  it('refuses a stream that ends without a token', async () => {
    const { transport } = recordingTransport([]);

    await expect(sysOn(transport).registerManager()).rejects.toThrow(
      new ProtocolError('sys.register_manager returned no access token'),
    );
  });
});
