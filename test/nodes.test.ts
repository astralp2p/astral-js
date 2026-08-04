import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, parseNonce, type AstralObject } from '../src/astral/index.js';
import { Nodes, type LinkInfoValue, type EndpointWithTTLValue } from '../src/api/nodes/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));
const PEER = parseIdentity('03' + 'b'.repeat(64));

const LINK: LinkInfoValue = {
  ID: parseNonce('7c1a93b50f2e4d18'),
  LocalIdentity: NODE,
  RemoteIdentity: PEER,
  LocalEndpoint: { Type: 'tcp.endpoint', Object: '10.0.0.5:1791' },
  RemoteEndpoint: { Type: 'tcp.endpoint', Object: '1.2.3.4:1791' },
  Outbound: true,
  Network: 'tcp',
  HighPressure: false,
  BytesThroughput: 1024,
};

const ENDPOINT: EndpointWithTTLValue = {
  Endpoint: { Type: 'tcp.endpoint', Object: '1.2.3.4:1791' },
  TTL: 7776000,
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

function nodesOn(transport: Transport): Nodes {
  return new Nodes(new Host(transport, NODE, 'node', GUEST));
}

describe('Nodes.links', () => {
  it('sends a bare query and returns every link', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
      { type: 'mod.nodes.link_info', value: { ...LINK, ID: parseNonce('3e7d2c1b9a40f582') } },
    ]);

    const links = await nodesOn(transport).links();

    expect(routed[0]!.Query).toBe('nodes.links');
    expect(links).toHaveLength(2);
    expect((links[0]!.value as LinkInfoValue).RemoteIdentity).toBe(PEER);
  });

  it('returns an empty list when nothing is linked', async () => {
    const { transport } = recordingTransport([]);

    await expect(nodesOn(transport).links()).resolves.toEqual([]);
  });

  it('leaves a nested endpoint adapter in wire form', async () => {
    const { transport } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
    ]);

    const [link] = await nodesOn(transport).links();

    expect((link!.value as LinkInfoValue).RemoteEndpoint).toEqual({
      Type: 'tcp.endpoint',
      Object: '1.2.3.4:1791',
    });
  });
});

describe('Nodes.resolveEndpoints', () => {
  it('folds the identity into the query', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.endpoint_with_ttl', value: { ...ENDPOINT } },
    ]);

    const found = await nodesOn(transport).resolveEndpoints(PEER);

    expect(routed[0]!.Query).toBe(`nodes.resolve_endpoints?id=${PEER}`);
    expect((found[0]!.value as EndpointWithTTLValue).TTL).toBe(7776000);
  });

  it('carries a null TTL through unchanged', async () => {
    const { transport } = recordingTransport([
      {
        type: 'mod.nodes.endpoint_with_ttl',
        value: { Endpoint: { Type: 'tor.endpoint', Object: 'abc.onion:1791' }, TTL: null },
      },
    ]);

    const [ep] = await nodesOn(transport).resolveEndpoints(PEER);

    expect((ep!.value as EndpointWithTTLValue).TTL).toBeNull();
  });

  it('returns an empty list when no endpoint is known', async () => {
    const { transport } = recordingTransport([]);

    await expect(nodesOn(transport).resolveEndpoints(PEER)).resolves.toEqual([]);
  });
});

describe('Nodes.newLink', () => {
  it('sends only the target when nothing else is asked for', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
    ]);

    const link = await nodesOn(transport).newLink(PEER);

    expect(routed[0]!.Query).toBe(`nodes.new_link?target=${PEER}`);
    expect(link.ID).toBe('7c1a93b50f2e4d18');
  });

  it('dials a named endpoint', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
    ]);

    await nodesOn(transport).newLink(PEER, { endpoint: 'tcp:1.2.3.4:1791' });

    expect(routed[0]!.Query).toBe(
      `nodes.new_link?target=${PEER}&endpoint=tcp%3A1.2.3.4%3A1791`,
    );
  });

  it('joins strategies with a comma', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
    ]);

    await nodesOn(transport).newLink(PEER, { strategies: ['basic', 'tor'] });

    expect(routed[0]!.Query).toBe(`nodes.new_link?target=${PEER}&strategies=basic%2Ctor`);
  });

  it('omits an empty strategy list', async () => {
    const { transport, routed } = recordingTransport([
      { type: 'mod.nodes.link_info', value: { ...LINK } },
    ]);

    await nodesOn(transport).newLink(PEER, { strategies: [] });

    expect(routed[0]!.Query).toBe(`nodes.new_link?target=${PEER}`);
  });

  it('refuses a strategy name carrying the separator', async () => {
    const { transport, routed } = recordingTransport([]);

    await expect(
      nodesOn(transport).newLink(PEER, { strategies: ['one,two'] }),
    ).rejects.toThrow(TypeError);
    expect(routed).toHaveLength(0);
  });

  it('throws when the node returns no link info', async () => {
    const { transport } = recordingTransport([]);

    await expect(nodesOn(transport).newLink(PEER)).rejects.toThrow(/no link info/);
  });
});
