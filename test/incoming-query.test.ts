import { describe, expect, it } from 'vitest';
import { IncomingQuery } from '../src/apphost/serve.js';
import type { IncomingQueryMsg } from '../src/apphost/messages.js';
import type { Session, Transport } from '../src/apphost/session.js';
import type { Nonce } from '../src/astral/index.js';

/** An IncomingQuery for `query`; parsing params touches neither transport nor session. */
function incoming(query: string): IncomingQuery {
  const raw: IncomingQueryMsg = {
    QueryID: '0123456789abcdef' as Nonce,
    Caller: null,
    Target: null,
    Query: query,
  };
  return new IncomingQuery({} as Transport, {} as Session, raw);
}

describe('IncomingQuery.params', () => {
  it('keeps the first value of a repeated key, as astral-go query.Parse does', () => {
    expect(incoming('chat.send?to=alice&to=bob').params).toEqual({ to: 'alice' });
  });

  it('strips the auto-injected in/out=json pair', () => {
    const q = incoming('chat.send?msg=hi&in=json&out=json');
    expect(q.query).toBe('chat.send');
    expect(q.params).toEqual({ msg: 'hi' });
  });

  it('keeps a key that names an Object.prototype member', () => {
    expect(incoming('op?toString=x&toString=y').params).toEqual({ toString: 'x' });
  });
});
