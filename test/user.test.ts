import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, unwrap, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, QueryRejected, RemoteError } from '../src/astral/errors.js';
import { BOOTSTRAP_RESULT_TYPE, DERIVE_IDENTITY_RESULT_TYPE, User } from '../src/api/user/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const PEER = parseIdentity('03' + 'b'.repeat(64));

/**
 * Records the route_query it is sent and every object streamed after it, then
 * replays `replies` as the response. `rejectCode` answers the route_query with
 * a query_rejected_msg instead.
 */
function recordingTransport(replies: AstralObject[], rejectCode?: number) {
  const routed: Array<Record<string, unknown>> = [];
  const streamed: AstralObject[] = [];
  let closed = 0;

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] =
        rejectCode !== undefined
          ? [{ type: MessageTypes.QueryRejected, value: { Code: rejectCode } }]
          : [
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
          } else {
            streamed.push(o);
          }
        },
        async recv(): Promise<AstralObject | null> {
          return queue.shift() ?? null;
        },
        close() {
          closed++;
        },
      } as unknown as Session;
    },
  };

  return { transport, routed, streamed, closes: () => closed };
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

describe('User.join', () => {
  it('sends the swarm node as node and returns the signed contract', async () => {
    const signed: AstralObject = { type: 'mod.auth.signed_contract', value: {} };
    const { transport, routed, streamed } = recordingTransport([signed]);

    const contract = await userOn(transport).join(PEER);

    expect(routed[0]!.Query).toBe(`user.join?node=${PEER}`);
    expect(streamed).toEqual([]);
    expect(contract).toEqual(signed);
  });

  it('sends an alias as node', async () => {
    const signed: AstralObject = { type: 'mod.auth.signed_contract', value: {} };
    const { transport, routed } = recordingTransport([signed]);

    await userOn(transport).join('laptop');

    expect(routed[0]!.Query).toBe('user.join?node=laptop');
  });

  it('surfaces a rejection code as QueryRejected', async () => {
    for (const code of [2, 3, 4]) {
      const { transport } = recordingTransport([], code);

      const err = await userOn(transport)
        .join(PEER)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(QueryRejected);
      expect((err as QueryRejected).code).toBe(code);
    }
  });

  it('throws a RemoteError on error_message', async () => {
    const { transport } = recordingTransport([
      { type: 'error_message', value: 'request declined' },
    ]);

    await expect(userOn(transport).join(PEER)).rejects.toThrow(new RemoteError('request declined'));
  });

  it('throws a ProtocolError when the node returns no contract', async () => {
    const { transport } = recordingTransport([]);

    await expect(userOn(transport).join(PEER)).rejects.toThrow(
      new ProtocolError('user.join returned no signed contract'),
    );
  });
});

const WORDS = 'penalty stadium garlic rifle fitness garage';
const USER = '02' + 'd'.repeat(64);
const TOKEN = 'b9c2e1a3d4f5867a';

/** A reply decoded from the JSON form the spec gives for mod.user.bootstrap_result. */
const bootstrapResult = (mnemonic: string, token: string = TOKEN): AstralObject =>
  unwrap(
    JSON.parse(
      `{"Type":"mod.user.bootstrap_result","Object":{"Identity":"${USER}","Mnemonic":"${mnemonic}","Token":"${token}"}}`,
    ),
  );

/** A reply decoded from the JSON form the spec gives for mod.user.derive_identity_result. */
const deriveIdentityResult = (mnemonic: string): AstralObject =>
  unwrap(
    JSON.parse(
      `{"Type":"mod.user.derive_identity_result","Object":{"Identity":"${USER}","Mnemonic":"${mnemonic}"}}`,
    ),
  );

describe('User.bootstrap', () => {
  it('decodes the JSON form of mod.user.bootstrap_result', () => {
    expect(bootstrapResult('')).toEqual({
      type: BOOTSTRAP_RESULT_TYPE,
      value: { Identity: USER, Mnemonic: '', Token: TOKEN },
    });
    expect(BOOTSTRAP_RESULT_TYPE).toBe('mod.user.bootstrap_result');
  });

  it('returns the user token', async () => {
    const { transport } = recordingTransport([bootstrapResult('')]);

    const reply = await userOn(transport).bootstrap(WORDS);

    expect(reply).toEqual({ Identity: USER, Mnemonic: '', Token: TOKEN });
  });

  it('reads an absent Token as empty and refuses a Token that is not a string', async () => {
    const absent = recordingTransport([
      { type: BOOTSTRAP_RESULT_TYPE, value: { Identity: USER, Mnemonic: '' } },
    ]);
    await expect(userOn(absent.transport).bootstrap(WORDS)).resolves.toEqual({
      Identity: USER,
      Mnemonic: '',
      Token: '',
    });

    const bad = recordingTransport([
      { type: BOOTSTRAP_RESULT_TYPE, value: { Identity: USER, Mnemonic: '', Token: 7 } },
    ]);
    await expect(userOn(bad.transport).bootstrap(WORDS)).rejects.toThrow(
      new ProtocolError('mod.user.bootstrap_result: Token is not a string'),
    );
  });
});

describe('User.deriveIdentity', () => {
  it('decodes the JSON form of mod.user.derive_identity_result', () => {
    expect(deriveIdentityResult(WORDS)).toEqual({
      type: DERIVE_IDENTITY_RESULT_TYPE,
      value: { Identity: USER, Mnemonic: WORDS },
    });
    expect(DERIVE_IDENTITY_RESULT_TYPE).toBe('mod.user.derive_identity_result');
  });

  it('refuses a bootstrap result as its reply', async () => {
    const { transport } = recordingTransport([bootstrapResult('')]);

    await expect(userOn(transport).deriveIdentity(WORDS)).rejects.toThrow(
      new ProtocolError('user.derive_identity: unexpected object type "mod.user.bootstrap_result"'),
    );
  });
});

/**
 * The word handling user.bootstrap and user.derive_identity share: the same
 * arguments, the same stream, the same refusals.
 */
describe.each([
  {
    op: 'user.bootstrap',
    type: BOOTSTRAP_RESULT_TYPE,
    call: (u: User, words?: string, opts?: { passphrase?: string }) => u.bootstrap(words, opts),
    result: (mnemonic: string) => bootstrapResult(mnemonic),
    reply: (mnemonic: string) => ({ Identity: USER, Mnemonic: mnemonic, Token: TOKEN }),
  },
  {
    op: 'user.derive_identity',
    type: DERIVE_IDENTITY_RESULT_TYPE,
    call: (u: User, words?: string, opts?: { passphrase?: string }) =>
      u.deriveIdentity(words, opts),
    result: (mnemonic: string) => deriveIdentityResult(mnemonic),
    reply: (mnemonic: string) => ({ Identity: USER, Mnemonic: mnemonic }),
  },
])('$op words', ({ op, type, call, result, reply }) => {
  it('sends the words in the stream and never in the query', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([result('')]);

    const got = await call(userOn(transport), WORDS);

    expect(routed[0]!.Query).toBe(op);
    for (const word of WORDS.split(' ')) {
      expect(routed[0]!.Query).not.toContain(word);
    }
    expect(streamed).toEqual([
      { type: 'string16', value: WORDS },
      { type: 'eos', value: null },
    ]);
    expect(got).toEqual(reply(''));
    expect(closes()).toBe(1);
  });

  it('asks the node to generate when no words are given, and streams nothing', async () => {
    const { transport, routed, streamed } = recordingTransport([result(WORDS)]);

    const got = await call(userOn(transport));

    expect(routed[0]!.Query).toBe(`${op}?generate=true`);
    expect(streamed).toEqual([]);
    expect(got).toEqual(reply(WORDS));
  });

  it('refuses empty or blank words without sending a query', async () => {
    const { transport, routed } = recordingTransport([result(WORDS)]);
    const user = userOn(transport);

    await expect(call(user, '')).rejects.toBeInstanceOf(TypeError);
    await expect(call(user, '  \n ')).rejects.toBeInstanceOf(TypeError);
    expect(routed).toEqual([]);
  });

  it('sends the passphrase as the passphrase argument, only when non-empty', async () => {
    const { transport, routed } = recordingTransport([result('')]);
    const user = userOn(transport);

    await call(user, WORDS, { passphrase: 'correct horse' });
    await call(user, undefined, { passphrase: 'pass' });
    await call(user, WORDS, { passphrase: '' });

    expect(routed.map((r) => r.Query)).toEqual([
      `${op}?passphrase=correct%20horse`,
      `${op}?generate=true&passphrase=pass`,
      op,
    ]);
  });

  it('surfaces a rejection code as QueryRejected', async () => {
    const { transport } = recordingTransport([], 2);

    const err = await call(userOn(transport), WORDS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryRejected);
    expect((err as QueryRejected).code).toBe(2);
  });

  it('throws a RemoteError on error_message and closes the stream', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'invalid mnemonic' },
    ]);

    await expect(call(userOn(transport), WORDS)).rejects.toThrow(
      new RemoteError('invalid mnemonic'),
    );
    expect(closes()).toBe(1);
  });

  it('throws a ProtocolError on another reply type or none', async () => {
    const other = recordingTransport([{ type: 'ack', value: null }]);
    await expect(call(userOn(other.transport), WORDS)).rejects.toBeInstanceOf(ProtocolError);

    const none = recordingTransport([]);
    await expect(call(userOn(none.transport), WORDS)).rejects.toThrow(
      new ProtocolError(`${op} returned no result`),
    );

    const badIdentity = recordingTransport([{ type, value: { Identity: 'nope', Mnemonic: '' } }]);
    await expect(call(userOn(badIdentity.transport), WORDS)).rejects.toBeInstanceOf(ProtocolError);

    const badMnemonic = recordingTransport([{ type, value: { Identity: USER, Mnemonic: 3 } }]);
    await expect(call(userOn(badMnemonic.transport), WORDS)).rejects.toThrow(
      new ProtocolError(`${type}: Mnemonic is not a string`),
    );
  });
});
