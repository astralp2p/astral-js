import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import {
  Objects,
  REPOSITORY_INFO_TYPE,
  type RepositoryInfoValue,
} from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));

// A leaf repository, a sequential group, a concurrent group, and an empty
// group. Not captured from a node: these are the JSON astral-go `21acd1b`
// marshals for the four values, astral-go being the wire authority below a
// live node. The last two are the pair that matters — they differ in `Kind`
// and `Concurrent` alone, both carrying an empty `Children`.
const LEAF = {
  Name: 'mem0',
  Label: 'Default memory',
  Free: 67108864,
  Kind: 'repository',
  Children: [],
  Concurrent: false,
};
const GROUP = {
  Name: 'main',
  Label: 'World',
  Free: 0,
  Kind: 'group',
  Children: ['device', 'virtual', 'network'],
  Concurrent: false,
};
const CONCURRENT_GROUP = {
  Name: 'local',
  Label: 'Local storage',
  Free: 0,
  Kind: 'group',
  Children: ['fs1', 'fs0'],
  Concurrent: true,
};
const EMPTY_GROUP = {
  Name: 'memory',
  Label: 'In-memory repos',
  Free: 0,
  Kind: 'group',
  Children: [],
  Concurrent: false,
};

/** Records the route_query it is sent, then replays `replies` as the response. */
function recordingTransport(replies: AstralObject[]) {
  const routed: Array<Record<string, unknown>> = [];

  const transport: Transport = {
    async open(): Promise<Session> {
      const queue: AstralObject[] = [
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
          }
        },
        async recv(): Promise<AstralObject | null> {
          return queue.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };

  return { transport, routed };
}

function objectsOn(transport: Transport): Objects {
  return new Objects(new Host(transport, NODE, 'node', GUEST));
}

/** The reply frames for a list of repository-info values. */
function infos(...values: unknown[]): AstralObject[] {
  return values.map((value) => ({ type: REPOSITORY_INFO_TYPE, value }));
}

describe('Objects.repositories', () => {
  it('sends a bare query with no arguments', async () => {
    const { transport, routed } = recordingTransport(infos(LEAF));

    await objectsOn(transport).repositories();

    expect(routed[0]!.Query).toBe('objects.repositories');
  });

  it('returns an empty list when the node serves no repository', async () => {
    const { transport } = recordingTransport([]);

    await expect(objectsOn(transport).repositories()).resolves.toEqual([]);
  });

  it('decodes a leaf repository', async () => {
    const { transport } = recordingTransport(infos(LEAF));

    const [repo] = await objectsOn(transport).repositories();

    expect(repo).toEqual({
      Name: 'mem0',
      Label: 'Default memory',
      Free: 67108864,
      Kind: 'repository',
      Children: [],
      Concurrent: false,
    } satisfies RepositoryInfoValue);
  });

  it('decodes a sequential group and a concurrent group', async () => {
    const { transport } = recordingTransport(infos(GROUP, CONCURRENT_GROUP));

    const [group, concurrent] = await objectsOn(transport).repositories();

    expect(group!.Kind).toBe('group');
    expect(group!.Concurrent).toBe(false);
    expect(concurrent!.Kind).toBe('group');
    expect(concurrent!.Concurrent).toBe(true);
    expect(concurrent!.Label).toBe('Local storage');
  });

  it('tells an empty group from a leaf by Kind, not by Children', async () => {
    const { transport } = recordingTransport(infos(LEAF, EMPTY_GROUP));

    const [leaf, empty] = await objectsOn(transport).repositories();

    expect(leaf!.Children).toEqual([]);
    expect(empty!.Children).toEqual([]);
    expect(leaf!.Kind).toBe('repository');
    expect(empty!.Kind).toBe('group');
  });

  it('preserves the order of Children', async () => {
    const { transport } = recordingTransport(infos(GROUP, CONCURRENT_GROUP));

    const [group, concurrent] = await objectsOn(transport).repositories();

    expect(group!.Children).toEqual(['device', 'virtual', 'network']);
    expect(concurrent!.Children).toEqual(['fs1', 'fs0']); // not sorted
  });

  it('returns every entry of the tree, in stream order', async () => {
    const { transport } = recordingTransport(infos(LEAF, GROUP, CONCURRENT_GROUP, EMPTY_GROUP));

    const repos = await objectsOn(transport).repositories();

    expect(repos.map((r) => r.Name)).toEqual(['mem0', 'main', 'local', 'memory']);
  });
});
