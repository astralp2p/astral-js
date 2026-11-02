import { describe, expect, it } from 'vitest';
import { Host } from '../src/apphost/index.js';
import type { Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, RemoteError } from '../src/astral/errors.js';
import { Apphost, type RevokeTarget } from '../src/api/apphost/index.js';
import { discoveryPermit } from '../src/api/services/index.js';
import { GUEST, NODE, recordingTransport } from './helpers/recording-transport.js';

const APP = parseIdentity('03' + 'e'.repeat(64));
const ACK: AstralObject = { type: 'ack', value: null };
const SEE = 'mod.auth.see_objects_action';

function apphostOn(transport: Transport): Apphost {
  return new Apphost(new Host(transport, NODE, 'node', GUEST));
}

function grantObject(id: number, expiresAt: string | null): AstralObject {
  return {
    type: 'mod.apphost.grant',
    value: {
      ID: id,
      Permit: { Action: SEE, Constraints: null, Delegation: 0 },
      ExpiresAt: expiresAt,
    },
  };
}

describe('Apphost.grant', () => {
  it('streams one grant_request on a bare query and resolves on ack', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([ACK]);

    await apphostOn(transport).grant(APP, [discoveryPermit(['inference'])], { durationMs: 60000 });

    expect(routed[0]!.Query).toBe('apphost.grant');
    expect(streamed).toEqual([
      {
        type: 'mod.apphost.grant_request',
        value: { Identity: APP, Duration: 60000000000, Permits: [discoveryPermit(['inference'])] },
      },
    ]);
    expect(Object.keys(streamed[0]!.value as object)).toEqual(['Identity', 'Duration', 'Permits']);
    expect(closes()).toBe(1);
  });

  it('sends Duration 0 without a duration', async () => {
    const { transport, streamed, closes } = recordingTransport([ACK]);

    await apphostOn(transport).grant(APP, [SEE]);

    expect((streamed[0]!.value as Record<string, unknown>).Duration).toBe(0);
    expect(closes()).toBe(1);
  });

  it('surfaces an error_message as a RemoteError', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'not permitted' },
    ]);

    await expect(apphostOn(transport).grant(APP, [SEE])).rejects.toThrow(
      new RemoteError('not permitted'),
    );
    expect(closes()).toBe(1);
  });

  it('refuses a stream that ends without an ack', async () => {
    const { transport, closes } = recordingTransport([]);

    await expect(apphostOn(transport).grant(APP, [SEE])).rejects.toThrow(ProtocolError);
    expect(closes()).toBe(1);
  });

  it('refuses an unexpected reply', async () => {
    const { transport, closes } = recordingTransport([{ type: 'string8', value: 'x' }]);

    await expect(apphostOn(transport).grant(APP, [SEE])).rejects.toThrow(ProtocolError);
    expect(closes()).toBe(1);
  });

  it.each([
    ['an empty permit list', APP, [], {}, TypeError],
    ['an alias', 'alice', [SEE], {}, TypeError],
    ['anyone', 'anyone', [SEE], {}, TypeError],
    ['a negative duration', APP, [SEE], { durationMs: -1 }, RangeError],
    ['a fractional duration', APP, [SEE], { durationMs: 1.5 }, RangeError],
  ])('refuses %s before routing', async (_, identity, permits, opts, error) => {
    const { transport, routed } = recordingTransport([ACK]);

    await expect(apphostOn(transport).grant(identity, permits, opts)).rejects.toThrow(error);
    expect(routed).toHaveLength(0);
  });
});

describe('Apphost.requestGrant', () => {
  it('streams one request_grant_request on a bare query and resolves on ack', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([ACK]);

    await apphostOn(transport).requestGrant([discoveryPermit(['inference'])]);

    expect(routed[0]!.Query).toBe('apphost.request_grant');
    expect(streamed).toEqual([
      {
        type: 'mod.apphost.request_grant_request',
        value: { Permits: [discoveryPermit(['inference'])], Duration: 0 },
      },
    ]);
    expect(Object.keys(streamed[0]!.value as object)).toEqual(['Permits', 'Duration']);
    expect(closes()).toBe(1);
  });

  it('surfaces a declined request as a RemoteError', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'grant declined' },
    ]);

    const err = await apphostOn(transport)
      .requestGrant([SEE], { durationMs: 1000 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as Error).message).toBe('grant declined');
    expect(closes()).toBe(1);
  });

  it('refuses an empty permit list before routing', async () => {
    const { transport, routed } = recordingTransport([ACK]);

    await expect(apphostOn(transport).requestGrant([])).rejects.toThrow(TypeError);
    expect(routed).toHaveLength(0);
  });
});

// listGrants reads through Host.call, which drains to eos and leaves the
// session to the transport, so these tests assert no close count.
describe('Apphost.listGrants', () => {
  it('decodes every grant', async () => {
    const { transport, routed } = recordingTransport([
      grantObject(7, '2026-12-01T00:00:00Z'),
      grantObject(8, null),
    ]);

    const grants = await apphostOn(transport).listGrants(APP);

    expect(routed[0]!.Query).toBe(`apphost.list_grants?identity=${APP}`);
    expect(grants).toEqual([
      grantObject(7, '2026-12-01T00:00:00Z').value,
      grantObject(8, null).value,
    ]);
  });

  it('refuses a foreign reply type', async () => {
    const { transport } = recordingTransport([{ type: 'mod.auth.permit', value: {} }]);

    await expect(apphostOn(transport).listGrants(APP)).rejects.toThrow(ProtocolError);
  });

  it('surfaces an error_message as a RemoteError', async () => {
    const { transport } = recordingTransport([{ type: 'error_message', value: 'not permitted' }]);

    await expect(apphostOn(transport).listGrants(APP)).rejects.toThrow(RemoteError);
  });
});

describe('Apphost.revoke', () => {
  it('revokes one grant by id', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([ACK]);

    await apphostOn(transport).revoke(APP, { id: 7 });

    expect(routed[0]!.Query).toBe(`apphost.revoke?identity=${APP}&id=7`);
    expect(streamed).toEqual([]);
    expect(closes()).toBe(1);
  });

  it('revokes every grant for an action', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([ACK]);

    await apphostOn(transport).revoke(APP, { action: SEE });

    expect(routed[0]!.Query).toBe(`apphost.revoke?identity=${APP}&action=${SEE}`);
    expect(streamed).toEqual([]);
    expect(closes()).toBe(1);
  });

  it.each([
    ['both id and action', { id: 7, action: SEE }],
    ['neither id nor action', {}],
    ['a negative id', { id: -1 }],
    ['an empty action', { action: '' }],
  ])('refuses %s before routing', async (_, target) => {
    const { transport, routed } = recordingTransport([ACK]);

    await expect(
      apphostOn(transport).revoke(APP, target as unknown as RevokeTarget),
    ).rejects.toThrow(TypeError);
    expect(routed).toHaveLength(0);
  });

  it('refuses a stream that ends without an ack', async () => {
    const { transport, closes } = recordingTransport([]);

    await expect(apphostOn(transport).revoke(APP, { id: 7 })).rejects.toThrow(ProtocolError);
    expect(closes()).toBe(1);
  });
});
