/**
 * Phase-2 outbound-query tests: drive {@link connect} and {@link Host.query}
 * against the in-process mock apphost (`test/mock-apphost.ts`).
 *
 * Covers the full outbound path: connect capturing host info + guest id, an
 * accepted query streaming its scripted objects to `eos`, a numeric reject
 * surfacing as {@link QueryRejected}, an unknown route surfacing as
 * {@link RouteNotFound} (via `error_msg` `route_not_found`), args folding into
 * the `Query` string, and fresh-socket-per-op (one handshake socket plus one per
 * query). The inbound path (register / incoming queries) is a later phase.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import type { AstralObject } from '../src/astral/object.js';
import { QueryRejected, RouteNotFound } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_HOST_IDENTITY,
  DEFAULT_HOST_ALIAS,
  DEFAULT_GUEST_IDENTITY,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

describe('connect + Host.query against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('connect() captures identity, alias, and guest id', async () => {
    const server = await startMockApphost();
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      expect(host.identity).toBe(DEFAULT_HOST_IDENTITY);
      expect(host.alias).toBe(DEFAULT_HOST_ALIAS);
      expect(host.guestID).toBe(DEFAULT_GUEST_IDENTITY);
    } finally {
      await server.close();
    }
  });

  test('an accepted query streams the scripted objects and terminates at eos', async () => {
    const server = await startMockApphost({
      routes: {
        'x.stream': {
          accept: [
            { type: 'string8', value: 'one' },
            { type: 'string8', value: 'two' },
            { type: 'string8', value: 'three' },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const stream = await host.query('x.stream');

      const got: AstralObject[] = [];
      for await (const o of stream) got.push(o);

      expect(got).toEqual([
        { type: 'string8', value: 'one' },
        { type: 'string8', value: 'two' },
        { type: 'string8', value: 'three' },
      ]);
    } finally {
      await server.close();
    }
  });

  test('a query_rejected reply rejects with QueryRejected carrying the code', async () => {
    const server = await startMockApphost({
      routes: { 'x.deny': { reject: 7 } },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      await expect(host.query('x.deny')).rejects.toBeInstanceOf(QueryRejected);
      await expect(host.query('x.deny')).rejects.toMatchObject({ code: 7 });
    } finally {
      await server.close();
    }
  });

  test('an unknown route (error_msg route_not_found) rejects with RouteNotFound', async () => {
    // No `routes` configured, so every query is answered route_not_found.
    const server = await startMockApphost();
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      await expect(host.query('x.missing')).rejects.toBeInstanceOf(RouteNotFound);
    } finally {
      await server.close();
    }
  });

  test('args fold into the query string the mock keys on', async () => {
    // The route is keyed on the folded query — the query only accepts if the
    // client sent exactly 'x.op?a=1'.
    const server = await startMockApphost({
      routes: {
        'x.op?a=1': { accept: [{ type: 'string8', value: 'ok' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const stream = await host.query('x.op', { args: { a: 1 } });

      const got: AstralObject[] = [];
      for await (const o of stream) got.push(o);

      expect(got).toEqual([{ type: 'string8', value: 'ok' }]);
    } finally {
      await server.close();
    }
  });

  test('fresh-socket-per-op: connect + N queries open N+1 sockets', async () => {
    const server = await startMockApphost({
      routes: {
        'x.a': { accept: [] },
        'x.b': { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });

      // Drain each stream so the queries fully complete.
      for (const route of ['x.a', 'x.b']) {
        const stream = await host.query(route);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of stream) { /* drain */ }
      }

      // 1 handshake socket + 2 query sockets.
      expect(server.connections).toBe(3);
    } finally {
      await server.close();
    }
  });
});
