/**
 * Tests for the `dir` protocol client (`src/api/dir`), driven against the
 * in-process mock apphost (`test/mock-apphost.ts`).
 *
 * Each test scripts a `routes` entry keyed on the EXACT folded query string the
 * client sends (`dir.<op>?<args>`), then asserts the decoded return value and,
 * for the write op, the outgoing query string (via the route key) plus that the
 * client sent no extra caller objects. Covers `resolve` (identity decode),
 * `getAlias` (present alias, and empty when none), and `setAlias` (set + clear).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import { Dir } from '../src/api/dir/index.js';
import { parseIdentity } from '../src/astral/identity.js';
import { RemoteError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

/** A fixed, valid 66-hex identity the mock resolves names to. */
const ALICE_ID = 'c'.repeat(66);
/** A second valid identity, for the alias ops. */
const BOB_ID = 'd'.repeat(66);

describe('Dir protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('resolve() folds { name } and decodes the identity result', async () => {
    const server = await startMockApphost({
      routes: {
        // The route only matches if the client sent exactly this folded query.
        'dir.resolve?name=alice': {
          accept: [{ type: 'identity', value: ALICE_ID }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      const id = await dir.resolve('alice');

      expect(id).toBe(parseIdentity(ALICE_ID));
    } finally {
      await server.close();
    }
  });

  test('resolve() surfaces a remote error as RemoteError', async () => {
    const server = await startMockApphost({
      routes: {
        'dir.resolve?name=nobody': {
          accept: [{ type: 'error_message', value: 'identity not found' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      await expect(dir.resolve('nobody')).rejects.toBeInstanceOf(RemoteError);
      await expect(dir.resolve('nobody')).rejects.toThrow('identity not found');
    } finally {
      await server.close();
    }
  });

  test('getAlias() folds { id } and returns the alias string', async () => {
    const server = await startMockApphost({
      routes: {
        [`dir.get_alias?id=${BOB_ID}`]: {
          accept: [{ type: 'string8', value: 'bob' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      const alias = await dir.getAlias(parseIdentity(BOB_ID));

      expect(alias).toBe('bob');
    } finally {
      await server.close();
    }
  });

  test('getAlias() returns "" when the identity has no alias', async () => {
    const server = await startMockApphost({
      routes: {
        // The reference op sends an empty string8 when no alias is set.
        [`dir.get_alias?id=${BOB_ID}`]: {
          accept: [{ type: 'string8', value: '' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      const alias = await dir.getAlias(BOB_ID);

      expect(alias).toBe('');
    } finally {
      await server.close();
    }
  });

  test('setAlias() folds { id, alias } and resolves void on ack', async () => {
    const query = `dir.set_alias?id=${BOB_ID}&alias=bob`;
    const server = await startMockApphost({
      routes: {
        // The reference op replies with a single ack; the mock's accept path
        // already sends eos after the scripted objects, so the ack alone is the
        // whole response.
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      await expect(dir.setAlias(BOB_ID, 'bob')).resolves.toBeUndefined();

      // The route matched (so the exact query string was sent), and the client
      // sent no extra caller objects on the accepted socket.
      expect(server.callerSent.get(query)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('setAlias() with no alias folds an empty alias (clear)', async () => {
    // Omitting the alias defaults to '', which clears the alias node-side.
    const query = `dir.set_alias?id=${BOB_ID}&alias=`;
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const dir = new Dir(host);

      await expect(dir.setAlias(BOB_ID)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
