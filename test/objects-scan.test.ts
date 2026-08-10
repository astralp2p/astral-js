import { describe, expect, it } from 'vitest';
import { Host, MessageTypes } from '../src/apphost/index.js';
import type { Session, Transport } from '../src/apphost/session.js';
import { parseIdentity, type AstralObject } from '../src/astral/index.js';
import { Objects } from '../src/api/objects/index.js';

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));

/** Accepts the query, then plays back `replies` in order, then closes. */
function scriptedTransport(replies: AstralObject[]) {
  const queue = [{ type: MessageTypes.QueryAccepted, value: {} }, ...replies];

  const transport: Transport = {
    async open(): Promise<Session> {
      return {
        hostInfo: { identity: NODE, alias: 'node' },
        guestID: GUEST,
        send() {},
        async recv(): Promise<AstralObject | null> {
          return queue.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };

  return transport;
}

describe('Objects.scan onHistoryComplete', () => {
  it('fires once at the snapshot/live boundary, and only in follow mode', async () => {
    const snapshot = ['data1aaa', 'data1bbb'];
    const live = ['data1ccc'];
    const transport = scriptedTransport([
      ...snapshot.map((v) => ({ type: 'object_id.sha256', value: v }) as AstralObject),
      { type: 'eos', value: null }, // snapshot/live separator
      ...live.map((v) => ({ type: 'object_id.sha256', value: v }) as AstralObject),
    ]);
    const objects = new Objects(new Host(transport, NODE, 'node', GUEST));

    let historyCompleteAt = -1;
    const seen: string[] = [];
    for await (const id of await objects.scan('chat', {
      follow: true,
      onHistoryComplete: () => {
        historyCompleteAt = seen.length;
      },
    })) {
      seen.push(id);
      if (seen.length === snapshot.length + live.length) break;
    }

    expect(seen).toEqual([...snapshot, ...live]);
    expect(historyCompleteAt).toBe(snapshot.length); // fired after the snapshot, before the live id
  });

  it('never calls onHistoryComplete in one-shot mode', async () => {
    const transport = scriptedTransport([
      { type: 'object_id.sha256', value: 'data1aaa' },
      { type: 'eos', value: null }, // one-shot terminator, not a separator
    ]);
    const objects = new Objects(new Host(transport, NODE, 'node', GUEST));

    let called = false;
    const seen: string[] = [];
    for await (const id of await objects.scan('chat', { onHistoryComplete: () => (called = true) })) {
      seen.push(id);
    }

    expect(seen).toEqual(['data1aaa']);
    expect(called).toBe(false);
  });
});
