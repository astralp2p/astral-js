/**
 * Tests for the `tree` protocol client ({@link Tree}), driven against the
 * in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each route is keyed on the EXACT folded query string the client sends
 * (`tree.<op>?<args>`), so every test asserts both the decoded return value and
 * — by the route matching at all — the outgoing query string (an unmatched
 * query is answered `route_not_found` and the call rejects). The bidirectional
 * `set` op additionally asserts the object it streamed via the mock's
 * `callerSent` capture.
 *
 * Covers the four BASIC ops: `get` (one-shot, missing-path error, and follow
 * mode), `set` (ack + the streamed value), `list` (child names), and `delete`
 * (plain and recursive).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import type { Stream } from '../src/apphost/stream.js';
import { Tree } from '../src/api/tree/index.js';
import { RemoteError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

describe('Tree protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('get() folds { path } and returns the single stored object', async () => {
    // path '/net/alias' URI-encodes to %2Fnet%2Falias; follow is omitted.
    const query = 'tree.get?path=%2Fnet%2Falias';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'string8', value: 'alice' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      const result = await tree.get('/net/alias');

      // A one-shot get resolves the full AstralObject (type tag preserved), not
      // a bare value, and never the live Stream.
      expect(result).toEqual({ type: 'string8', value: 'alice' });
    } finally {
      await server.close();
    }
  });

  test('get() surfaces a missing path as a RemoteError', async () => {
    const query = 'tree.get?path=%2Fmissing';
    const server = await startMockApphost({
      routes: {
        // The node accepts the query, then streams an error object for a path
        // that does not exist.
        [query]: { accept: [{ type: 'error_message', value: 'node not found' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      await expect(tree.get('/missing')).rejects.toBeInstanceOf(RemoteError);
      await expect(tree.get('/missing')).rejects.toThrow('node not found');
    } finally {
      await server.close();
    }
  });

  test('get({ follow: true }) folds follow=true and returns the live Stream', async () => {
    // Follow mode folds &follow=true and keeps the stream open. The mock sends
    // the scripted objects then eos, so iterating the returned Stream yields the
    // current value and each update in order before stopping at eos.
    const query = 'tree.get?path=%2Fnet%2Falias&follow=true';
    const server = await startMockApphost({
      routes: {
        [query]: {
          accept: [
            { type: 'string8', value: 'alice' },
            { type: 'string8', value: 'alice2' },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      const stream = (await tree.get('/net/alias', { follow: true })) as Stream;

      const seen: unknown[] = [];
      for await (const o of stream) seen.push(o.value);
      stream.close();

      expect(seen).toEqual(['alice', 'alice2']);
    } finally {
      await server.close();
    }
  });

  test('set() folds { path }, streams the value, and resolves void on ack', async () => {
    const query = 'tree.set?path=%2Fnet%2Falias';
    const value = { type: 'string8', value: 'alice' };
    const server = await startMockApphost({
      routes: {
        // The node acks a successful write; the mock's accept path sends the ack
        // then eos, and leaves the socket open so the streamed value + eos land.
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      await expect(tree.set('/net/alias', value)).resolves.toBeUndefined();

      // The client streamed exactly the value object (the eos is excluded from
      // the capture) on the accepted write socket.
      await server.waitFor(() => (server.callerSent.get(query)?.length ?? 0) === 1);
      expect(server.callerSent.get(query)).toEqual([value]);
    } finally {
      await server.close();
    }
  });

  test('set() rejects with a RemoteError when the node streams an error', async () => {
    const query = 'tree.set?path=%2Freadonly';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'permission denied' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      await expect(
        tree.set('/readonly', { type: 'string8', value: 'x' }),
      ).rejects.toThrow('permission denied');
    } finally {
      await server.close();
    }
  });

  test('list() folds { path } and yields each child name as a string', async () => {
    const query = 'tree.list?path=%2Fnet';
    const server = await startMockApphost({
      routes: {
        [query]: {
          accept: [
            { type: 'string8', value: 'alias' },
            { type: 'string8', value: 'peers' },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      const names: string[] = [];
      for await (const name of await tree.list('/net')) names.push(name);

      expect(names).toEqual(['alias', 'peers']);
    } finally {
      await server.close();
    }
  });

  test('list() yields nothing for an empty directory', async () => {
    const query = 'tree.list?path=%2Fempty';
    const server = await startMockApphost({
      routes: {
        // No scripted objects: the mock sends query_accepted then eos, so the
        // iterable completes without yielding.
        [query]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      const names: string[] = [];
      for await (const name of await tree.list('/empty')) names.push(name);

      expect(names).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('delete() folds { path } and resolves void on ack', async () => {
    const query = 'tree.delete?path=%2Fnet%2Falias';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      await expect(tree.delete('/net/alias')).resolves.toBeUndefined();

      // The route matched (exact query string) and no extra caller objects were
      // sent on the accepted socket.
      expect(server.callerSent.get(query)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('delete({ recursive: true }) folds recursive=true into the query', async () => {
    // Recursive delete adds &recursive=true; the route only matches that exact
    // folded query, so a match asserts the client sent it.
    const query = 'tree.delete?path=%2Fnet&recursive=true';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const tree = new Tree(host);

      await expect(tree.delete('/net', { recursive: true })).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
