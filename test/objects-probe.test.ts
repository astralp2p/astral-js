import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { Objects } from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));

const FULL = 'data1rxqff36hhoddbhwbsd5c1smbpoh9oq5pgum6n6g4bg1esia4psp1r';
const PARTIAL = 'data0bqff36hhoddbhwbsd5c1smbpoh9oq5pgum6n6g4bg1esia4psp1r';

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

/** A descriptor as a node at the pin answers it: five keys, `ObjectID` set. */
function descriptor(objectID: unknown): AstralObject {
  const value: Record<string, unknown> = {
    Type: 'string8',
    Repo: 'local',
    Mime: 'text/plain; charset=utf-8',
    Time: 421000,
  };
  if (objectID !== undefined) value.ObjectID = objectID;
  return { type: 'mod.objects.probe', value };
}

describe('Objects.probe', () => {
  // The point of a partial id is that the node resolves it, so the client must
  // put it on the wire as given. Nothing else pins this: probe never calls
  // parseObjectID, so a future normalisation would go unnoticed here.
  it('sends a partial id through to the query unchanged', async () => {
    const { transport, routed } = recordingTransport([descriptor(FULL)]);
    await objectsOn(transport).probe(PARTIAL);
    expect(routed[0]!.Query).toBe(`objects.probe?id=${PARTIAL}`);
  });

  // The answer names the object in full even though the request did not — which
  // is what makes probing by digest useful.
  it('returns the resolved id the node reports', async () => {
    const { transport } = recordingTransport([descriptor(FULL)]);
    const probe = await objectsOn(transport).probe(PARTIAL);
    expect(probe.type).toBe('mod.objects.probe');
    expect((probe.value as { ObjectID: string }).ObjectID).toBe(FULL);
  });

  // The two absences are different shapes and the client distinguishes neither:
  // it returns the descriptor unwrapped, so both reach the caller as data. A
  // guard written for one of them is wrong about the other, which is why the
  // docstring names both.
  it('passes through a null ObjectID without failing', async () => {
    const { transport } = recordingTransport([descriptor(null)]);
    const probe = await objectsOn(transport).probe(FULL);
    const value = probe.value as Record<string, unknown>;
    expect('ObjectID' in value).toBe(true);
    expect(value.ObjectID).toBeNull();
  });

  it('passes through a descriptor with no ObjectID key without failing', async () => {
    const { transport } = recordingTransport([descriptor(undefined)]);
    const probe = await objectsOn(transport).probe(FULL);
    const value = probe.value as Record<string, unknown>;
    expect('ObjectID' in value).toBe(false);
    expect(value.Type).toBe('string8');
  });
});
