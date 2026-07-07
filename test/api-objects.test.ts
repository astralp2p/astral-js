/**
 * Tests for the `objects` protocol client (`src/api/objects`), driven against
 * the in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each test scripts a `routes` entry keyed on the EXACT folded query string the
 * client sends (`objects.<op>?<args>`), then asserts the decoded return value
 * and (via the route key matching) the outgoing query string. Covers `probe`
 * (raw descriptor object + empty), `contains` (true / false), `getType`
 * (present + empty), and `find` (streamed identities, anyone skipped, and a
 * remote error surfaced from the stream).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import { Objects } from '../src/api/objects/index.js';
import type { Identity } from '../src/astral/identity.js';
import { parseIdentity } from '../src/astral/identity.js';
import { ProtocolError, RemoteError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

/** A fixed, canonical `data1…` object id the tests probe/find. */
const OBJECT_ID = 'data1abcdef0123456789';
/** Two valid holder identities the `find` op streams. */
const ALICE_ID = 'c'.repeat(66);
const BOB_ID = 'd'.repeat(66);
/** The zero/anonymous identity the node may emit and the client must skip. */
const ANYONE_KEY = '0'.repeat(66);

describe('Objects protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('probe() folds { id } and returns the raw descriptor object', async () => {
    const descriptor = {
      Type: 'mod.dir.alias_map',
      Repo: 'main',
      Mime: 'application/octet-stream',
      Time: 1234,
    };
    const server = await startMockApphost({
      routes: {
        // The route only matches if the client sent exactly this folded query.
        [`objects.probe?id=${OBJECT_ID}`]: {
          accept: [{ type: 'mod.objects.probe', value: descriptor }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      const probe = await objects.probe(OBJECT_ID);

      expect(probe).toEqual({ type: 'mod.objects.probe', value: descriptor });
    } finally {
      await server.close();
    }
  });

  test('probe() rejects with ProtocolError when the node returns no descriptor', async () => {
    const server = await startMockApphost({
      routes: {
        // Accept with no objects: the mock sends query_accepted then eos, so the
        // client sees an empty response where a single descriptor is required.
        [`objects.probe?id=${OBJECT_ID}`]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.probe(OBJECT_ID)).rejects.toBeInstanceOf(ProtocolError);
    } finally {
      await server.close();
    }
  });

  test('probe() surfaces a remote error as RemoteError', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.probe?id=${OBJECT_ID}`]: {
          accept: [{ type: 'error_message', value: 'object not found' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.probe(OBJECT_ID)).rejects.toBeInstanceOf(RemoteError);
      await expect(objects.probe(OBJECT_ID)).rejects.toThrow('object not found');
    } finally {
      await server.close();
    }
  });

  test('contains() folds { id } and returns true for a held object', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.contains?id=${OBJECT_ID}`]: {
          accept: [{ type: 'bool', value: true }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.contains(OBJECT_ID)).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });

  test('contains() returns false when the node does not hold the object', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.contains?id=${OBJECT_ID}`]: {
          accept: [{ type: 'bool', value: false }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.contains(OBJECT_ID)).resolves.toBe(false);
    } finally {
      await server.close();
    }
  });

  test('getType() folds { id } and returns the type string', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.get_type?id=${OBJECT_ID}`]: {
          accept: [{ type: 'string8', value: 'mod.dir.alias_map' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.getType(OBJECT_ID)).resolves.toBe('mod.dir.alias_map');
    } finally {
      await server.close();
    }
  });

  test('getType() returns "" when the node returns no type', async () => {
    const server = await startMockApphost({
      routes: {
        // Accept with no objects: callOne sees an empty response.
        [`objects.get_type?id=${OBJECT_ID}`]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      await expect(objects.getType(OBJECT_ID)).resolves.toBe('');
    } finally {
      await server.close();
    }
  });

  test('find() folds { id } and streams each holder identity, skipping anyone', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.find?id=${OBJECT_ID}`]: {
          accept: [
            { type: 'identity', value: ALICE_ID },
            // The node may emit the zero/anonymous identity; the client skips it.
            { type: 'identity', value: ANYONE_KEY },
            { type: 'identity', value: BOB_ID },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      const holders: Identity[] = [];
      for await (const id of await objects.find(OBJECT_ID)) holders.push(id);

      expect(holders).toEqual([parseIdentity(ALICE_ID), parseIdentity(BOB_ID)]);
    } finally {
      await server.close();
    }
  });

  test('find() yields nothing when no holder is streamed', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.find?id=${OBJECT_ID}`]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      const holders: Identity[] = [];
      for await (const id of await objects.find(OBJECT_ID)) holders.push(id);

      expect(holders).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('find() surfaces a remote error streamed on the channel', async () => {
    const server = await startMockApphost({
      routes: {
        [`objects.find?id=${OBJECT_ID}`]: {
          accept: [{ type: 'error_message', value: 'id is required' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const objects = new Objects(host);

      // Draining the iterable to completion surfaces the streamed error object.
      const drain = async (): Promise<Identity[]> => {
        const holders: Identity[] = [];
        for await (const id of await objects.find(OBJECT_ID)) holders.push(id);
        return holders;
      };

      await expect(drain()).rejects.toBeInstanceOf(RemoteError);
      await expect(drain()).rejects.toThrow('id is required');
    } finally {
      await server.close();
    }
  });
});
