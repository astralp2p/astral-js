import { describe, expect, it } from 'vitest';
import { Host } from '../src/apphost/index.js';
import type { Transport } from '../src/apphost/session.js';
import { parseIdentity, readEnvelope, unwrap, type Identity } from '../src/astral/index.js';
import { Nearby, type NearbyStatusValue } from '../src/api/nearby/index.js';
import { GUEST, NODE, recordingTransport } from './helpers/recording-transport.js';

const PEER = parseIdentity('03' + 'b'.repeat(64));

/**
 * The JSON line astral-go's JSON channel writes for the nearby.Status that
 * astrald's nearby.list sends for an unrecognised Stealth status: a nil
 * Identity encodes as null. Produced from astral-go 71c77a56 api/nearby types.
 */
const UNRECOGNISED_STEALTH =
  '{"Type":"mod.nearby.status","Object":{"Identity":null,"Attachments":[' +
  '{"Type":"mod.nearby.stealth_hint","Object":{"Commitment":"ERERERERERERERERERERERERERERERERERERERERERE=","MaskedNode":"IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi","MaskedUser":"MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz","Nonce":"3f9c2a7d11e4b605"}},' +
  '{"Type":"mod.nearby.status_proof","Object":{"Nonce":"7c1a93b50f2e4d18","Sig":"REREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREQ=","Timestamp":"2026-11-05T17:00:00Z"}}' +
  ']}}';

function nearbyOn(transport: Transport): Nearby {
  return new Nearby(new Host(transport, NODE, 'node', GUEST));
}

describe('Nearby.list', () => {
  it('decodes a status with a null Identity for an unrecognised Stealth peer', async () => {
    const { transport, routed } = recordingTransport([
      unwrap(readEnvelope(JSON.parse(UNRECOGNISED_STEALTH), 'frame')),
      { type: 'mod.nearby.status', value: { Identity: PEER, Attachments: [] } },
    ]);

    const statuses = await nearbyOn(transport).list();

    expect(routed[0]!.Query).toBe('nearby.list');
    expect(statuses).toHaveLength(2);
    expect(statuses[0]!.type).toBe('mod.nearby.status');

    const stealth = statuses[0]!.value as NearbyStatusValue;
    expect(stealth.Identity).toBeNull();
    expect(stealth.Attachments).toHaveLength(2);
    expect((statuses[1]!.value as NearbyStatusValue).Identity).toBe(PEER);

    // The type makes a caller handle null before using the identity as one.
    // @ts-expect-error -- Identity is Identity | null, not assignable to Identity.
    const unchecked: Identity = stealth.Identity;
    expect(unchecked).toBeNull();
    const known: Identity[] = statuses
      .map((s) => (s.value as NearbyStatusValue).Identity)
      .filter((id): id is Identity => id !== null);
    expect(known).toEqual([PEER]);
  });
});
