import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { Objects } from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const PEER = parseIdentity('03' + 'b'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));

/** Records the route_query it is sent, then accepts and ends the stream. */
function recordingTransport() {
  const routed: Array<Record<string, unknown>> = [];

  const transport: Transport = {
    async open(): Promise<Session> {
      const replies: AstralObject[] = [
        { type: MessageTypes.QueryAccepted, value: {} },
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
          return replies.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };

  return { transport, routed };
}

describe('Host.to', () => {
  it('addresses the connected node by default', async () => {
    const { transport, routed } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST);

    await host.query('objects.scan?repo=chat');

    expect(routed[0]!.Target).toBe(NODE);
    expect(host.target).toBeNull();
  });

  it('addresses the peer a bound host names', async () => {
    const { transport, routed } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST).to(PEER);

    await host.query('objects.scan?repo=chat');

    expect(routed[0]!.Target).toBe(PEER);
    expect(host.target).toBe(PEER);
  });

  it('keeps the transport, identity and guest id — the app still speaks to its own node', () => {
    const { transport } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST);
    const bound = host.to(PEER);

    expect(bound.identity).toBe(host.identity);
    expect(bound.alias).toBe(host.alias);
    expect(bound.guestID).toBe(host.guestID);
  });

  it('lets a per-query target win over the bound one', async () => {
    const { transport, routed } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST).to(PEER);

    await host.query('objects.scan?repo=chat', { target: NODE });

    expect(routed[0]!.Target).toBe(NODE);
  });

  it('addresses the connected node again when rebound to null', async () => {
    const { transport, routed } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST).to(PEER).to(null);

    await host.query('objects.scan?repo=chat');

    expect(routed[0]!.Target).toBe(NODE);
  });

  it('carries the binding into every protocol client built on it', async () => {
    const { transport, routed } = recordingTransport();
    const host = new Host(transport, NODE, 'node', GUEST);

    // The point of binding at the host: no client needs to know about targets.
    const theirs = new Objects(host.to(PEER));
    await theirs.scan('chat');

    expect(routed[0]!.Target).toBe(PEER);
    expect(String(routed[0]!.Query)).toContain('objects.scan');
  });
});
