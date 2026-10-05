import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { ProtocolError, RemoteError } from '../src/astral/errors.js';
import { Objects } from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const SOURCE = '03' + 'b'.repeat(64);
const ID1 = 'data1' + 'a'.repeat(58);
const ID2 = 'data1' + 'b'.repeat(58);

/**
 * Records the route_query it is sent and how often the session closes, then
 * replays `replies`; an exhausted queue reads as a closed socket.
 */
function recordingTransport(replies: AstralObject[]) {
  const routed: Array<Record<string, unknown>> = [];
  let closed = 0;

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] = [{ type: MessageTypes.QueryAccepted, value: {} }, ...replies];
      return {
        hostInfo: { identity: NODE, alias: 'node' },
        guestID: GUEST,
        send(o: AstralObject) {
          if (o.type === MessageTypes.RouteQuery) routed.push(o.value as Record<string, unknown>);
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

  return { transport, routed, closes: () => closed };
}

function objectsOn(transport: Transport): Objects {
  return new Objects(new Host(transport, NODE, 'node', GUEST));
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const searchResult = (id: string): AstralObject => ({
  type: 'mod.objects.search_result',
  value: { SourceID: SOURCE, ObjectID: id },
});

const describeResult = (data: { Type: string; Object: unknown }): AstralObject => ({
  type: 'mod.objects.describe_result',
  value: { SourceID: SOURCE, ObjectID: ID1, Data: data },
});

const EOS: AstralObject = { type: 'eos', value: null };

describe('Objects.search', () => {
  it('sends q, repo and zone, and yields parsed results until eos', async () => {
    const { transport, routed, closes } = recordingTransport([
      searchResult(ID1),
      searchResult(ID2),
      EOS,
      searchResult(ID1), // past eos: never read
    ]);

    const results = await collect(
      await objectsOn(transport).search('artist:"Miles Davis" -genre:pop', {
        repo: 'local',
        zone: 'dv',
      }),
    );

    expect(routed[0]!.Query).toBe(
      'objects.search?q=artist%3A%22Miles%20Davis%22%20-genre%3Apop&repo=local&zone=dv',
    );
    expect(results).toEqual([
      { SourceID: SOURCE, ObjectID: ID1 },
      { SourceID: SOURCE, ObjectID: ID2 },
    ]);
    expect(closes()).toBe(1);
  });

  it('omits unset options', async () => {
    const { transport, routed } = recordingTransport([EOS]);
    expect(await collect(await objectsOn(transport).search('hello'))).toEqual([]);
    expect(routed[0]!.Query).toBe('objects.search?q=hello');
  });

  it('throws a RemoteError on error_message and closes the stream', async () => {
    const { transport, closes } = recordingTransport([
      searchResult(ID1),
      { type: 'error_message', value: 'repository not found' },
    ]);
    const seen: unknown[] = [];
    const run = async () => {
      for await (const r of await objectsOn(transport).search('x', { repo: 'nope' })) seen.push(r);
    };
    await expect(run()).rejects.toThrow(new RemoteError('repository not found'));
    expect(seen).toHaveLength(1);
    expect(closes()).toBe(1);
  });

  it('closes the stream when iteration stops early', async () => {
    const { transport, closes } = recordingTransport([searchResult(ID1), searchResult(ID2), EOS]);
    for await (const r of await objectsOn(transport).search('x')) {
      expect(r.ObjectID).toBe(ID1);
      break;
    }
    expect(closes()).toBe(1);
  });

  it('rejects a result of the wrong type or with a malformed id', async () => {
    const wrongType = recordingTransport([{ type: 'string8', value: 'x' }]);
    await expect(collect(await objectsOn(wrongType.transport).search('x'))).rejects.toThrow(
      ProtocolError,
    );

    const badID = recordingTransport([searchResult('nope')]);
    await expect(collect(await objectsOn(badID.transport).search('x'))).rejects.toThrow(
      ProtocolError,
    );
  });
});

describe('Objects.describe', () => {
  it('sends id, only, except and zone, and yields descriptors with Data unwrapped', async () => {
    const audio = {
      ObjectID: ID1,
      Format: 'flac',
      Title: 'So What',
      Artist: 'Miles Davis',
      Album: 'Kind of Blue',
      Genre: 'Jazz',
      Year: 1959,
      PictureID: ID2,
    };
    const { transport, routed, closes } = recordingTransport([
      describeResult({
        Type: 'mod.fs.file_location',
        Object: { NodeID: SOURCE, Path: '/music/so-what.flac' },
      }),
      describeResult({ Type: 'app.media.audio_file', Object: audio }),
      EOS,
    ]);

    const results = await collect(
      await objectsOn(transport).describe(ID1, {
        only: ['mod.fs.file_location', 'app.media.audio_file'],
        except: ['mod.objects.repository_info'],
        zone: 'd',
      }),
    );

    expect(routed[0]!.Query).toBe(
      `objects.describe?id=${ID1}&only=mod.fs.file_location%2Capp.media.audio_file&except=mod.objects.repository_info&zone=d`,
    );
    expect(results).toEqual([
      {
        SourceID: SOURCE,
        ObjectID: ID1,
        Data: {
          type: 'mod.fs.file_location',
          value: { NodeID: SOURCE, Path: '/music/so-what.flac' },
        },
      },
      { SourceID: SOURCE, ObjectID: ID1, Data: { type: 'app.media.audio_file', value: audio } },
    ]);
    expect(closes()).toBe(1);
  });

  it('omits empty filters', async () => {
    const { transport, routed } = recordingTransport([EOS]);
    expect(
      await collect(await objectsOn(transport).describe(ID1, { only: [], except: [] })),
    ).toEqual([]);
    expect(routed[0]!.Query).toBe(`objects.describe?id=${ID1}`);
  });

  it('throws a RemoteError on error_message', async () => {
    const { transport, closes } = recordingTransport([{ type: 'error_message', value: 'denied' }]);
    await expect(collect(await objectsOn(transport).describe(ID1))).rejects.toThrow(
      new RemoteError('denied'),
    );
    expect(closes()).toBe(1);
  });

  it('closes the stream when iteration stops early', async () => {
    const { transport, closes } = recordingTransport([
      describeResult({ Type: 'string8', Object: 'a' }),
      describeResult({ Type: 'string8', Object: 'b' }),
      EOS,
    ]);
    for await (const r of await objectsOn(transport).describe(ID1)) {
      expect(r.Data).toEqual({ type: 'string8', value: 'a' });
      break;
    }
    expect(closes()).toBe(1);
  });

  it('rejects a descriptor whose Data is not an envelope', async () => {
    const { transport } = recordingTransport([
      {
        type: 'mod.objects.describe_result',
        value: { SourceID: SOURCE, ObjectID: ID1, Data: 'x' },
      },
    ]);
    await expect(collect(await objectsOn(transport).describe(ID1))).rejects.toThrow();
  });
});

/** Accepts the query, plays `replies`, then holds `recv` open until the session closes. */
function hangingTransport(replies: AstralObject[]) {
  let closed = 0;
  let release: ((o: AstralObject | null) => void) | undefined;

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] = [{ type: MessageTypes.QueryAccepted, value: {} }, ...replies];
      return {
        hostInfo: { identity: NODE, alias: 'node' },
        guestID: GUEST,
        send() {},
        recv(): Promise<AstralObject | null> {
          const o = queue.shift();
          if (o) return Promise.resolve(o);
          if (closed) return Promise.resolve(null);
          return new Promise((r) => (release = r));
        },
        close() {
          closed++;
          release?.(null);
        },
      } as unknown as Session;
    },
  };

  return { transport, closes: () => closed };
}

describe('abort signal', () => {
  it('ends a search waiting on the next match', async () => {
    const { transport, closes } = hangingTransport([searchResult(ID1)]);
    const ctl = new AbortController();
    const seen: string[] = [];
    for await (const r of await objectsOn(transport).search('x', { signal: ctl.signal })) {
      seen.push(r.ObjectID);
      setTimeout(() => ctl.abort(), 0); // abort while the loop waits on the next frame
    }
    expect(seen).toEqual([ID1]);
    expect(closes()).toBeGreaterThanOrEqual(1);
  });

  it('closes a describe aborted before iteration starts', async () => {
    const { transport, closes } = hangingTransport([
      describeResult({ Type: 'string8', Object: 'a' }),
    ]);
    const ctl = new AbortController();
    const results = await objectsOn(transport).describe(ID1, { signal: ctl.signal });
    ctl.abort();
    expect(await collect(results)).toEqual([]);
    expect(closes()).toBeGreaterThanOrEqual(1);
  });
});
