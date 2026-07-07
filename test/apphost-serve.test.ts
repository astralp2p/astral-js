/**
 * Phase-3 inbound-serve tests: drive {@link connect} and {@link Host.register}
 * against the in-process mock apphost (`test/mock-apphost.ts`).
 *
 * Covers the full inbound path: a registration whose handler accepts an
 * announced query, attaches a fresh per-query socket, and streams a response to
 * `eos` (captured by the mock); a handler that rejects with a numeric code; a
 * handler that throws (the delivery loop turns it into a `reject(0xff)`); and
 * an idempotent {@link Registration.unregister}. The outbound path (Host.query)
 * is covered in apphost-query.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import type { IncomingQuery } from '../src/apphost/serve.js';
import { obj, eos } from '../src/astral/object.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

describe('connect + Host.register against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('an accepted incoming query attaches and streams its response to eos', async () => {
    const server = await startMockApphost({
      incoming: {
        QueryID: 'q-accept',
        Caller: 'c'.repeat(66),
        // The apphost decorates the query string with the transport-mode flags;
        // the SDK must strip them from params and split off the path.
        Query: 'chat.send?room=lobby&in=json&out=json',
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      const seen: {
        id?: string;
        caller?: string | null;
        query?: string;
        params?: Record<string, string>;
        queryString?: string;
      } = {};
      const reg = await host.register('a'.repeat(66), async (q: IncomingQuery) => {
        seen.id = q.id;
        seen.caller = q.caller;
        seen.query = q.query;
        seen.params = q.params;
        seen.queryString = q.queryString;
        const stream = await q.accept();
        stream.send(obj('string8', 'hi'));
        stream.send(eos());
        stream.close();
      });

      // Wait for the mock to capture the responder's object under this QueryID.
      await server.waitFor(() => (server.accepted.get('q-accept')?.length ?? 0) > 0);

      expect(seen.id).toBe('q-accept');
      expect(seen.caller).toBe('c'.repeat(66));
      expect(seen.query).toBe('chat.send');
      expect(seen.params).toEqual({ room: 'lobby' });
      expect(seen.queryString).toBe('chat.send?room=lobby&in=json&out=json');

      expect(server.accepted.get('q-accept')).toEqual([{ type: 'string8', value: 'hi' }]);

      reg.unregister();
    } finally {
      await server.close();
    }
  });

  test('a handler that rejects records the numeric code on the mock', async () => {
    const server = await startMockApphost({
      incoming: { QueryID: 'q-reject', Query: 'chat.send' },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      const reg = await host.register('a'.repeat(66), (q) => {
        q.reject(5);
      });

      await server.waitFor(() => server.rejected.has('q-reject'));
      expect(server.rejected.get('q-reject')).toBe(5);

      reg.unregister();
    } finally {
      await server.close();
    }
  });

  test('a handler that throws is turned into a reject(0xff) by the loop', async () => {
    const server = await startMockApphost({
      incoming: { QueryID: 'q-throw', Query: 'chat.send' },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      const reg = await host.register('a'.repeat(66), () => {
        throw new Error('handler blew up');
      });

      await server.waitFor(() => server.rejected.has('q-throw'));
      expect(server.rejected.get('q-throw')).toBe(255);

      reg.unregister();
    } finally {
      await server.close();
    }
  });

  test('unregister() is idempotent and does not throw', async () => {
    const server = await startMockApphost();
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const reg = await host.register('a'.repeat(66), () => {
        /* ignore incoming queries */
      });

      expect(() => {
        reg.unregister();
        reg.unregister();
      }).not.toThrow();
    } finally {
      await server.close();
    }
  });
});
