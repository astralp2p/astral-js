import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TYPE,
  MAX_CONTRACT_TEXT_LEN,
  contractSignableText,
  type ContractValue,
} from '../src/api/auth/index.js';
import { parseIdentity } from '../src/astral/index.js';

interface Vector {
  name: string;
  value: ContractValue;
  signableText: string;
  signableHash: string;
  objectId: string;
}

// Produced by astral-go; see "source" in the file.
const { vectors } = JSON.parse(
  readFileSync(new URL('./vectors/contract-signable-text.json', import.meta.url), 'utf8'),
) as { vectors: Vector[] };

const ISSUER = parseIdentity('02' + 'a'.repeat(64));
const SUBJECT = parseIdentity('03' + 'b'.repeat(64));
const MEMBER = [{ Action: 'mod.user.member_action', Constraints: null, Delegation: 0 }];

function contract(over: Partial<ContractValue> = {}): ContractValue {
  return {
    Issuer: ISSUER,
    Subject: SUBJECT,
    Permits: MEMBER,
    ExpiresAt: '2030-01-02T03:04:05Z',
    RequestID: null,
    ...over,
  };
}

describe('contractSignableText against astral-go vectors', () => {
  it('has the vectors', () => {
    expect(CONTRACT_TYPE).toBe('mod.auth.contract');
    expect(vectors.length).toBeGreaterThanOrEqual(21);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_, v) => {
    expect(contractSignableText(v.value)).toBe(v.signableText);
    expect(v.signableText.length).toBeLessThanOrEqual(MAX_CONTRACT_TEXT_LEN);
    expect(v.signableText).toMatch(/^[\x20-\x7e]+$/);
  });

  it('carries a RequestID of astral-go as a data1 string or null', () => {
    const withID = vectors.filter((v) => v.value.RequestID !== null);
    const without = vectors.filter((v) => v.value.RequestID === null);
    expect(withID.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const v of withID) expect(v.value.RequestID).toMatch(/^data1[a-z0-9]*$/);
  });

  it('does not show the RequestID, which only the commitment binds', () => {
    const [a, b] = ['member_with_request_id', 'trusted_no_request_id'].map((s) =>
      vectors.find((v) => v.name.endsWith(s)),
    );
    expect(a?.value.RequestID).not.toBeNull();
    expect(b?.value.RequestID).toBeNull();
    expect(a?.signableHash).not.toBe(b?.signableHash);

    const id = a!.value.RequestID;
    expect(contractSignableText({ ...a!.value, RequestID: null } as ContractValue)).toBe(
      contractSignableText({ ...a!.value, RequestID: id } as ContractValue),
    );
  });
});

describe('contractSignableText', () => {
  it('names the three membership tiers by their word', () => {
    for (const [action, word] of [
      ['mod.user.member_action', 'member'],
      ['mod.user.trusted_action', 'trusted'],
      ['mod.user.privileged_member_action', 'privileged_member'],
    ] as const) {
      const text = contractSignableText(
        contract({ Permits: [{ Action: action, Constraints: null, Delegation: 0 }] }),
      );
      expect(text).toBe(`${ISSUER} grants ${SUBJECT} ${word} depth 0 until 2030-01-02 03:04:05`);
    }
  });

  it.each([
    ['mod.auth.sudo_action', 'auth.sudo'],
    ['mod.user.admin_swarm_action', 'user.admin_swarm'],
    ['mod.x9.y_9_action', 'x9.y_9'],
    ['mod.auth.action', null],
    ['mod.auth._action', null],
    ['mod..sudo_action', null],
    ['mod.a.b.c_action', null],
    ['mod.Auth.sudo_action', null],
    ['auth.sudo_action', null],
    ['mod.auth.sudo', null],
    ['mod.auth.sudo,x_action', null],
    ['mod.auth.sudo until_action', null],
    ['constructor', null],
    ['', null],
  ])('names the action %j as %j', (action, name) => {
    const text = contractSignableText(
      contract({ Permits: [{ Action: action, Constraints: null, Delegation: 0 }] }),
    );
    const list = text.slice(`${ISSUER} grants ${SUBJECT} `.length, text.indexOf(' depth '));
    expect(list).toBe(name ?? '+1');
  });

  it('counts the actions the line has no room for', () => {
    const permits = Array.from({ length: 50 }, (_, i) => ({
      Action: `mod.module${String(i).padStart(2, '0')}.long_action_name_action`,
      Constraints: null,
      Delegation: 0,
    }));
    const text = contractSignableText(contract({ Permits: permits }));
    expect(text.length).toBeLessThanOrEqual(MAX_CONTRACT_TEXT_LEN);
    const items = text
      .slice(`${ISSUER} grants ${SUBJECT} `.length, text.indexOf(' depth '))
      .split(',');
    const left = Number(items[items.length - 1]!.slice(1));
    expect(items.length - 1 + left).toBe(50);
    expect(items.length - 1).toBeGreaterThan(0);
  });

  it('stays within the limit with the widest depth, and with no word fitting', () => {
    const permits = [
      { Action: 'mod.x.' + 'y'.repeat(300) + '_action', Constraints: null, Delegation: 255 },
    ];
    const text = contractSignableText(
      contract({ Permits: permits, ExpiresAt: '9999-12-31T23:59:59Z' }),
    );
    expect(text).toBe(`${ISSUER} grants ${SUBJECT} +1 depth 255 until 9999-12-31 23:59:59`);
  });

  it('shows an absent or anonymous identity as 66 zeros', () => {
    const zeros = '0'.repeat(66);
    expect(contractSignableText(contract({ Issuer: null, Subject: parseIdentity('anyone') }))).toBe(
      `${zeros} grants ${zeros} member depth 0 until 2030-01-02 03:04:05`,
    );
  });

  it('cuts the time to the second and keeps year 1', () => {
    expect(contractSignableText(contract({ ExpiresAt: '2030-01-02T03:04:05.987654321Z' }))).toMatch(
      / until 2030-01-02 03:04:05$/,
    );
    expect(contractSignableText(contract({ ExpiresAt: '0001-01-01T00:00:00Z' }))).toMatch(
      / until 0001-01-01 00:00:00$/,
    );
  });

  it('reads a missing Permits and a missing Delegation as none and 0', () => {
    expect(
      contractSignableText({ Issuer: ISSUER, Subject: SUBJECT, ExpiresAt: '2030-01-02T03:04:05Z' }),
    ).toBe(`${ISSUER} grants ${SUBJECT} none depth 0 until 2030-01-02 03:04:05`);
    expect(
      contractSignableText(contract({ Permits: [{ Action: 'mod.vfs.read_action' }] as never })),
    ).toMatch(/ vfs\.read depth 0 /);
  });

  it.each([
    ['a short identity', { Issuer: 'abcd' }],
    ['a non-string identity', { Subject: 5 }],
    ['a time with an offset', { ExpiresAt: '2030-01-02T03:04:05+02:00' }],
    ['a date without a time', { ExpiresAt: '2030-01-02' }],
    ['a month 13', { ExpiresAt: '2030-13-02T03:04:05Z' }],
    ['a 30th of February', { ExpiresAt: '2030-02-30T03:04:05Z' }],
    ['an hour 24', { ExpiresAt: '2030-01-02T24:04:05Z' }],
    ['a missing time', { ExpiresAt: undefined }],
    ['a permit without an Action', { Permits: [{ Delegation: 0 }] }],
    ['a Delegation of 256', { Permits: [{ Action: 'a.b', Delegation: 256 }] }],
    ['a fractional Delegation', { Permits: [{ Action: 'a.b', Delegation: 1.5 }] }],
  ])('refuses %s', (_, over) => {
    expect(() => contractSignableText(contract(over as Partial<ContractValue>))).toThrow(TypeError);
  });
});
