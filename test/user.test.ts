import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, unwrap, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, QueryRejected, RemoteError } from '../src/astral/errors.js';
import { BOOTSTRAP_RESULT_TYPE, User } from '../src/api/user/index.js';

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

describe('User.bootstrap', () => {
  const WORDS = 'penalty stadium garlic rifle fitness garage';
  const USER = '02' + 'd'.repeat(64);

  /** A reply decoded from the JSON form the spec gives for mod.user.bootstrap_result. */
  const result = (mnemonic: string): AstralObject =>
    unwrap(
      JSON.parse(
        `{"Type":"mod.user.bootstrap_result","Object":{"Identity":"${USER}","Mnemonic":"${mnemonic}"}}`,
      ),
    );

  it('decodes the JSON form of mod.user.bootstrap_result', () => {
    expect(result('')).toEqual({
      type: BOOTSTRAP_RESULT_TYPE,
      value: { Identity: USER, Mnemonic: '' },
    });
    expect(BOOTSTRAP_RESULT_TYPE).toBe('mod.user.bootstrap_result');
  });

  it('sends the words in the stream and never in the query', async () => {
    const { transport, routed, streamed, closes } = recordingTransport([result('')]);

    const reply = await userOn(transport).bootstrap(WORDS);

    expect(routed[0]!.Query).toBe('user.bootstrap');
    for (const word of WORDS.split(' ')) {
      expect(routed[0]!.Query).not.toContain(word);
    }
    expect(streamed).toEqual([
      { type: 'string16', value: WORDS },
      { type: 'eos', value: null },
    ]);
    expect(reply).toEqual({ Identity: USER, Mnemonic: '' });
    expect(closes()).toBe(1);
  });

  it('asks the node to generate when no words are given, and streams nothing', async () => {
    const { transport, routed, streamed } = recordingTransport([result(WORDS)]);

    const reply = await userOn(transport).bootstrap();

    expect(routed[0]!.Query).toBe('user.bootstrap?generate=true');
    expect(streamed).toEqual([]);
    expect(reply).toEqual({ Identity: USER, Mnemonic: WORDS });
  });

  it('refuses empty or blank words without sending a query', async () => {
    const { transport, routed } = recordingTransport([result(WORDS)]);
    const user = userOn(transport);

    await expect(user.bootstrap('')).rejects.toBeInstanceOf(TypeError);
    await expect(user.bootstrap('  \n ')).rejects.toBeInstanceOf(TypeError);
    expect(routed).toEqual([]);
  });

  it('sends the passphrase as the passphrase argument, only when non-empty', async () => {
    const { transport, routed } = recordingTransport([result('')]);
    const user = userOn(transport);

    await user.bootstrap(WORDS, { passphrase: 'correct horse' });
    await user.bootstrap(undefined, { passphrase: 'pass' });
    await user.bootstrap(WORDS, { passphrase: '' });

    expect(routed.map((r) => r.Query)).toEqual([
      'user.bootstrap?passphrase=correct%20horse',
      'user.bootstrap?generate=true&passphrase=pass',
      'user.bootstrap',
    ]);
  });

  it('surfaces a rejection code as QueryRejected', async () => {
    const { transport } = recordingTransport([], 2);

    const err = await userOn(transport)
      .bootstrap(WORDS)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryRejected);
    expect((err as QueryRejected).code).toBe(2);
  });

  it('throws a RemoteError on error_message and closes the stream', async () => {
    const { transport, closes } = recordingTransport([
      { type: 'error_message', value: 'invalid mnemonic' },
    ]);

    await expect(userOn(transport).bootstrap(WORDS)).rejects.toThrow(
      new RemoteError('invalid mnemonic'),
    );
    expect(closes()).toBe(1);
  });

  it('throws a ProtocolError on another reply type or none', async () => {
    const other = recordingTransport([{ type: 'ack', value: null }]);
    await expect(userOn(other.transport).bootstrap(WORDS)).rejects.toBeInstanceOf(ProtocolError);

    const none = recordingTransport([]);
    await expect(userOn(none.transport).bootstrap(WORDS)).rejects.toThrow(
      new ProtocolError('user.bootstrap returned no result'),
    );

    const badIdentity = recordingTransport([
      { type: BOOTSTRAP_RESULT_TYPE, value: { Identity: 'nope', Mnemonic: '' } },
    ]);
    await expect(userOn(badIdentity.transport).bootstrap(WORDS)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });
});
