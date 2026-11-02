import { describe, expect, it } from 'vitest';
import { Host } from '../src/apphost/index.js';
import type { Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { ProtocolError } from '../src/astral/errors.js';
import { Apphost, durationNs, grantExpiresAt, parseGrant } from '../src/api/apphost/index.js';
import { discoveryPermit } from '../src/api/services/index.js';
import { GUEST, NODE, recordingTransport } from './helpers/recording-transport.js';

// Golden JSON printed by json.Marshal through the astral-go codec at main
// 5b0b5311 (structs declared as in astral-docs e7674fb
// protocols/apphost/types; ExpiresAt is a *astral.Time, nil until revoked).
const GO_GRANT_SCOPED =
  '{"ExpiresAt":"2026-12-01T00:00:00Z","ID":7,"Permit":{"Action":"mod.services.service_discovery_action","Constraints":[{"Type":"mod.services.discovery_scope","Object":{"Rules":[{"Nodes":[],"Services":["inference"]}]}}],"Delegation":0}}';
const GO_GRANT_UNTIL_REVOKED =
  '{"ExpiresAt":null,"ID":8,"Permit":{"Action":"mod.auth.see_objects_action","Constraints":null,"Delegation":0}}';
const GO_REGISTER_REQUEST =
  '{"ContractPermits":[],"GrantPermits":[{"Action":"mod.auth.see_objects_action","Constraints":null,"Delegation":0}],"Name":"smoke"}';
const GO_REGISTER_REQUEST_EMPTY = '{"ContractPermits":[],"GrantPermits":[],"Name":""}';
const GO_GRANT_REQUEST =
  '{"Duration":60000000000,"Identity":"0282fee8775757cdd8fda8b220195f5b8611312cd145c5a1a3aa55df210e779b2c","Permits":[{"Action":"mod.services.service_discovery_action","Constraints":[{"Type":"mod.services.discovery_scope","Object":{"Rules":[{"Nodes":[],"Services":["inference"]}]}}],"Delegation":0}]}';
const GO_REQUEST_GRANT_REQUEST =
  '{"Duration":0,"Permits":[{"Action":"mod.services.service_discovery_action","Constraints":[{"Type":"mod.services.discovery_scope","Object":{"Rules":[{"Nodes":[],"Services":["inference"]}]}}],"Delegation":0}]}';

const IDENTITY = parseIdentity(
  '0282fee8775757cdd8fda8b220195f5b8611312cd145c5a1a3aa55df210e779b2c',
);
const ACK: AstralObject = { type: 'ack', value: null };
const TOKEN: AstralObject = {
  type: 'apphost.access_token',
  value: { Identity: IDENTITY, Token: 't', ExpiresAt: '2036-01-01T00:00:00Z' },
};

/** Run `call` on a recording transport and return the one object it streamed. */
async function sent(replies: AstralObject[], call: (a: Apphost) => Promise<unknown>) {
  const { transport, streamed } = recordingTransport(replies);
  await call(new Apphost(new Host(transport as Transport, NODE, 'node', GUEST)));
  expect(streamed).toHaveLength(1);
  return streamed[0]!.value;
}

describe('mod.apphost.grant round trip', () => {
  it.each([
    ['a scoped grant with an expiry', GO_GRANT_SCOPED],
    ['a grant until revoked', GO_GRANT_UNTIL_REVOKED],
  ])('decodes %s as astral-go wrote it', (_, golden) => {
    const g = parseGrant({ type: 'mod.apphost.grant', value: JSON.parse(golden) });

    expect(JSON.parse(JSON.stringify(g))).toEqual(JSON.parse(golden));
  });

  it('reads an absent ExpiresAt as until revoked', () => {
    const value = JSON.parse(GO_GRANT_UNTIL_REVOKED);
    delete value.ExpiresAt;

    expect(parseGrant({ type: 'mod.apphost.grant', value }).ExpiresAt).toBeNull();
  });

  it.each([
    ['an ID of 2^53', { ...JSON.parse(GO_GRANT_UNTIL_REVOKED), ID: 2 ** 53 }],
    ['a negative ID', { ...JSON.parse(GO_GRANT_UNTIL_REVOKED), ID: -1 }],
    ['a permit without Action', { ...JSON.parse(GO_GRANT_UNTIL_REVOKED), Permit: {} }],
    ['a numeric ExpiresAt', { ...JSON.parse(GO_GRANT_UNTIL_REVOKED), ExpiresAt: 0 }],
  ])('refuses %s', (_, value) => {
    expect(() => parseGrant({ type: 'mod.apphost.grant', value })).toThrow(ProtocolError);
  });

  it('refuses another type', () => {
    expect(() =>
      parseGrant({ type: 'mod.auth.permit', value: JSON.parse(GO_GRANT_UNTIL_REVOKED) }),
    ).toThrow(ProtocolError);
  });
});

describe('request objects match astral-go', () => {
  it('register_request with a name and a grant permit', async () => {
    const value = await sent([TOKEN], (a) =>
      a.register({ name: 'smoke', permits: ['mod.auth.see_objects_action'] }),
    );
    expect(value).toEqual(JSON.parse(GO_REGISTER_REQUEST));
  });

  it('register_request of a bare register()', async () => {
    const value = await sent([TOKEN], (a) => a.register());
    expect(value).toEqual(JSON.parse(GO_REGISTER_REQUEST_EMPTY));
  });

  it('grant_request', async () => {
    const value = await sent([ACK], (a) =>
      a.grant(IDENTITY, [discoveryPermit(['inference'])], { durationMs: 60000 }),
    );
    expect(value).toEqual(JSON.parse(GO_GRANT_REQUEST));
  });

  it('request_grant_request', async () => {
    const value = await sent([ACK], (a) => a.requestGrant([discoveryPermit(['inference'])]));
    expect(value).toEqual(JSON.parse(GO_REQUEST_GRANT_REQUEST));
  });
});

describe('durationNs', () => {
  it.each([
    [0, 0],
    [1, 1e6],
    [60000, 6e10],
    [365 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1e9],
  ])('converts %d ms', (ms, ns) => {
    expect(durationNs(ms)).toBe(ns);
  });

  it.each([-1, 1.5, Number.NaN, 9223372036855])('refuses %d', (ms) => {
    expect(() => durationNs(ms)).toThrow(RangeError);
  });
});

describe('grantExpiresAt', () => {
  it('reads null as until revoked', () => {
    expect(
      grantExpiresAt(
        parseGrant({ type: 'mod.apphost.grant', value: JSON.parse(GO_GRANT_UNTIL_REVOKED) }),
      ),
    ).toBeNull();
  });

  it('reads an instant as a Date', () => {
    expect(
      grantExpiresAt(parseGrant({ type: 'mod.apphost.grant', value: JSON.parse(GO_GRANT_SCOPED) })),
    ).toEqual(new Date('2026-12-01T00:00:00Z'));
  });
});
