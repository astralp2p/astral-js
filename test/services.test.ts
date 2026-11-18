import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { RemoteError } from '../src/astral/errors.js';
import { Services, StreamEnded, joinNames } from '../src/api/services/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const PROVIDER = parseIdentity('03' + 'b'.repeat(64));
const CALLER = parseIdentity('03' + 'd'.repeat(64));

/** A session the test feeds by hand: `push` delivers, `end` closes. */
class ScriptedSession {
  readonly sent: AstralObject[] = [];
  readonly hostInfo = { identity: NODE, alias: 'node' };
  readonly guestID = GUEST;
  private queue: Array<AstralObject | null> = [];
  private waiting: ((o: AstralObject | null) => void) | null = null;
  closed = false;

  push(o: AstralObject | null): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(o);
    } else this.queue.push(o);
  }
  end(): void {
    this.push(null);
  }
  send(o: AstralObject): void {
    this.sent.push(o);
  }
  recv(): Promise<AstralObject | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((r) => (this.waiting = r));
  }
  close(): void {
    this.closed = true;
    this.push(null);
  }
  /** The query string of the route_query this session carried. */
  get query(): string {
    return (this.sent[0]!.value as { Query: string }).Query;
  }
  /** Objects sent after the route_query. */
  get objects(): AstralObject[] {
    return this.sent.slice(1);
  }
}

function scripted(...replies: AstralObject[]) {
  const session = new ScriptedSession();
  session.push({ type: MessageTypes.QueryAccepted, value: {} });
  for (const r of replies) session.push(r);
  const transport: Transport = {
    async open(): Promise<Session> {
      return session as unknown as Session;
    },
  };
  return { session, services: new Services(new Host(transport, NODE, 'node', GUEST)) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ack: AstralObject = { type: 'ack', value: null };
const eos: AstralObject = { type: 'eos', value: null };
const update = (name: string, available = true): AstralObject => ({
  type: 'services.update',
  value: { Available: available, Name: name, ProviderID: PROVIDER, Info: null },
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('joinNames', () => {
  it('joins a valid list', () => {
    expect(joinNames(['player', 'contacts-backend'])).toBe('player,contacts-backend');
  });
  it.each([[[]], [['a', 'a']], [['a,b']], [[' a']], [['']]])('rejects %j', (names) => {
    expect(() => joinNames(names)).toThrow();
  });
});

describe('Services.discover', () => {
  it('yields views and a complete outcome, then ends', async () => {
    const { session, services } = scripted(update('player'), eos);
    const events = await collect(await services.discover(['player']));

    expect(session.query).toBe('services.discover?services=player');
    expect(events.map((e) => e.kind)).toEqual(['update', 'initial']);
    expect(events[1]).toEqual({ kind: 'initial', outcome: { complete: true, incomplete: [] } });
  });

  it('reports an incomplete initial attempt', async () => {
    const { services } = scripted(
      { type: 'services.incomplete', value: { Services: ['player'] } },
      eos,
    );
    const events = await collect(await services.discover(['player']));
    expect(events).toEqual([
      { kind: 'initial', outcome: { complete: false, incomplete: ['player'] } },
    ]);
  });

  it('fails a one-shot that closes before its outcome', async () => {
    const { session, services } = scripted(update('player'));
    session.end();
    await expect(collect(await services.discover(['player']))).rejects.toBeInstanceOf(StreamEnded);
  });

  it('surfaces a refusal', async () => {
    const { services } = scripted({ type: 'error_message', value: 'not permitted' });
    await expect(collect(await services.discover(['player']))).rejects.toBeInstanceOf(RemoteError);
  });

  it('continues past the outcome when following', async () => {
    const { session, services } = scripted(eos, update('player'), {
      type: 'services.removed',
      value: { Offerings: [{ ProviderID: PROVIDER, Name: 'player' }] },
    });
    session.end();
    const kinds: string[] = [];
    await expect(
      (async () => {
        for await (const e of await services.discover(['player'], true)) kinds.push(e.kind);
      })(),
    ).rejects.toBeInstanceOf(StreamEnded);
    expect(session.query).toBe('services.discover?services=player&follow=true');
    expect(kinds).toEqual(['initial', 'update', 'removed']);
  });
});

describe('Services reach', () => {
  it('sends reach=swarm only when asked', async () => {
    const local = scripted(eos);
    await collect(await local.services.discover(['player']));
    expect(local.session.query).toBe('services.discover?services=player');

    const swarm = scripted(eos);
    await collect(await swarm.services.discover(['player'], false, { reach: 'swarm' }));
    expect(swarm.session.query).toBe('services.discover?services=player&reach=swarm');
  });

  it('watches across the swarm', async () => {
    const { session, services } = scripted(eos);
    const w = await services.watch(['player'], { reach: 'swarm' });
    await w.initial;
    expect(session.query).toBe('services.discover?services=player&follow=true&reach=swarm');
    w.close();
    await w.done;
  });
});

describe('Services.watch', () => {
  it('rejects initial when the stream fails first', async () => {
    const { services } = scripted({ type: 'error_message', value: 'not permitted' });
    const w = await services.watch(['player']);
    await expect(w.initial).rejects.toBeInstanceOf(RemoteError);
    await expect(w.done).rejects.toBeInstanceOf(RemoteError);
  });

  it('keeps the available offerings', async () => {
    const { session, services } = scripted(update('player'), eos);
    const w = await services.watch(['player']);
    expect(await w.initial).toEqual({ complete: true, incomplete: [] });
    expect(w.offerings().map((o) => o.Name)).toEqual(['player']);

    let changes = 0;
    w.onChange(() => changes++);
    session.push(update('player', false));
    await tick();
    expect(w.offerings()).toEqual([]);
    expect(changes).toBe(1);

    w.close();
    await w.done;
  });
});

/** A host whose n-th query gets sessions[n]; later queries are refused by a closed socket. */
function scriptedQueries(...sessions: ScriptedSession[]) {
  let n = 0;
  const transport: Transport = {
    async open(): Promise<Session> {
      const s = sessions[n++];
      if (!s) {
        const closed = new ScriptedSession();
        closed.end();
        return closed as unknown as Session;
      }
      return s as unknown as Session;
    },
  };
  return { services: new Services(new Host(transport, NODE, 'node', GUEST)), opened: () => n };
}

function follow(...replies: Array<AstralObject | null>): ScriptedSession {
  const s = new ScriptedSession();
  s.push({ type: MessageTypes.QueryAccepted, value: {} });
  for (const r of replies) s.push(r);
  return s;
}

const offer = (provider: string): AstralObject => ({
  type: 'services.update',
  value: { Available: true, Name: 'player', ProviderID: provider, Info: null },
});
const OTHER = parseIdentity('03' + 'e'.repeat(64));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Services.watch with reconnect', () => {
  it('reopens after an EOF and applies the difference in one change per boundary', async () => {
    const second = follow(offer(PROVIDER));
    const { services, opened } = scriptedQueries(
      follow(offer(PROVIDER), offer(OTHER), eos, null),
      second,
    );
    const w = await services.watch(['player'], { reconnect: { minMs: 1, maxMs: 4 } });
    let changes = 0;
    let synced = 0;
    w.onChange(() => changes++);
    w.onSynced(() => synced++);

    expect(await w.initial).toEqual({ complete: true, incomplete: [] });
    await until(() => opened() === 2 && w.stale());
    expect(w.offerings().length).toBe(2);
    changes = 0;
    await tick();
    expect(changes).toBe(0);
    expect(w.offerings().length).toBe(2);

    second.push(eos);
    await until(() => synced === 2);
    expect(w.offerings().map((o) => o.ProviderID)).toEqual([PROVIDER]);
    expect(w.stale()).toBe(false);
    expect(changes).toBe(1);

    w.close();
    await w.done;
  });

  it('keeps unseen offerings after an incomplete boundary until they are shown again', async () => {
    const second = follow(
      offer(PROVIDER),
      { type: 'services.incomplete', value: { Services: ['player'] } },
      eos,
    );
    const { services } = scriptedQueries(follow(offer(PROVIDER), offer(OTHER), eos, null), second);
    const w = await services.watch(['player'], { reconnect: { minMs: 1 } });
    let synced = 0;
    w.onSynced(() => synced++);
    await until(() => synced === 2);
    expect(w.offerings().length).toBe(2);
    expect(w.stale()).toBe(true);

    second.push(offer(OTHER));
    await until(() => !w.stale());
    expect(w.offerings().length).toBe(2);
    w.close();
    await w.done;
  });

  it('stops on a refusal of the first follow', async () => {
    const { services, opened } = scriptedQueries(
      follow({ type: 'error_message', value: 'not permitted' }),
    );
    const w = await services.watch(['player'], { reconnect: { minMs: 1 } });
    await expect(w.initial).rejects.toBeInstanceOf(RemoteError);
    await expect(w.done).rejects.toBeInstanceOf(RemoteError);
    expect(opened()).toBe(1);
  });

  it('retries a refusal of a later follow', async () => {
    const third = follow(eos);
    const { services, opened } = scriptedQueries(
      follow(eos, null),
      follow({ type: 'error_message', value: 'services not ready' }),
      third,
    );
    const w = await services.watch(['player'], { reconnect: { minMs: 1 } });
    let synced = 0;
    w.onSynced(() => synced++);
    await until(() => synced === 2);
    expect(opened()).toBe(3);
    w.close();
    await w.done;
  });

  it('checks the names before any query', async () => {
    const { services, opened } = scriptedQueries();
    await expect(services.watch([], { reconnect: true })).rejects.toThrow();
    expect(opened()).toBe(0);
  });
});

describe('Services.advertise', () => {
  it('answers each ask from its handler', async () => {
    const { session, services } = scripted(ack);
    const binding = await services.advertise({
      player: (caller) => (caller === CALLER ? { info: [{ type: 'string8', value: 'hi' }] } : null),
    });
    expect(session.query).toBe('services.advertise?services=player');

    session.push({
      type: 'services.ask',
      value: { RequestID: '7', CallerID: CALLER, Service: 'player' },
    });
    session.push({
      type: 'services.ask',
      value: { RequestID: '8', CallerID: GUEST, Service: 'player' },
    });
    await tick();
    await tick();

    expect(session.objects).toEqual([
      {
        type: 'services.answer',
        value: {
          RequestID: '7',
          Update: {
            Available: true,
            Name: 'player',
            ProviderID: null,
            Info: [{ Type: 'string8', Object: 'hi' }],
          },
        },
      },
      {
        type: 'services.answer',
        value: {
          RequestID: '8',
          Update: { Available: false, Name: 'player', ProviderID: null, Info: null },
        },
      },
    ]);

    binding.change(CALLER);
    binding.change();
    binding.changeAll();
    expect(session.objects.slice(2)).toEqual([
      { type: 'services.change', value: { All: false, Callers: [CALLER] } },
      { type: 'services.change', value: { All: true, Callers: null } },
    ]);

    binding.close();
    await binding.done;
  });

  it('answers unavailable when a handler throws', async () => {
    const { session, services } = scripted(ack);
    await services.advertise({
      player: () => {
        throw new Error('boom');
      },
    });
    session.push({
      type: 'services.ask',
      value: { RequestID: '1', CallerID: CALLER, Service: 'player' },
    });
    await tick();
    await tick();
    expect((session.objects[0]!.value as { Update: { Available: boolean } }).Update.Available).toBe(
      false,
    );
  });

  it('rejects when the node refuses the set', async () => {
    const { services } = scripted({
      type: 'error_message',
      value: 'service already advertised by this provider',
    });
    await expect(services.advertise({ player: () => null })).rejects.toBeInstanceOf(RemoteError);
  });
});
