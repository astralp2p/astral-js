/**
 * Tests for the `auth` protocol client ({@link Auth}), driven against the
 * in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each route is keyed on the EXACT folded query string the client sends
 * (`auth.<op>?<args>`), so every test asserts both the decoded return value and
 * — by the route matching at all — the outgoing query string (an unmatched
 * query is answered `route_not_found` and the call rejects).
 *
 * Covers the two BASIC ops:
 *   - `signContract` — the bidirectional op: NO query args, streams the contract
 *     object (asserted via the mock's `callerSent` capture) and reads back the
 *     signed contract; plus the missing-reply and node-error paths.
 *   - `index` — `{ id }` folded into the query string, acked to void;
 *     plus the node-error and malformed-id (client-side `TypeError`) paths.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import { Auth } from '../src/api/auth/index.js';
import { RemoteError, ProtocolError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

/** A valid `data1…` object id for the index-op tests. */
const OBJECT_ID = 'data1' + 'c'.repeat(52);

/** An unsigned contract object, as the caller would build it. */
const CONTRACT = {
  type: 'mod.auth.contract',
  value: {
    Issuer: { Type: 'identity', Object: 'i'.repeat(66) },
    Subject: { Type: 'identity', Object: 's'.repeat(66) },
    Permits: [],
    ExpiresAt: { Type: 'time', Object: '2030-01-01T00:00:00Z' },
  },
};

/** The signed form the node replies with. */
const SIGNED_CONTRACT = {
  type: 'mod.auth.signed_contract',
  value: {
    ...CONTRACT.value,
    IssuerSig: { Type: 'mod.crypto.signature', Object: 'aaaa' },
    SubjectSig: { Type: 'mod.crypto.signature', Object: 'bbbb' },
  },
};

describe('Auth protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('signContract() folds no args, streams the contract, and returns the signed contract', async () => {
    // The op takes NO query args, so the folded query is the bare op string.
    const query = 'auth.sign_contract';
    const server = await startMockApphost({
      routes: {
        // The node replies with the signed contract, then eos; the mock leaves
        // the socket open so the streamed contract + eos land on it.
        [query]: { accept: [SIGNED_CONTRACT] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      const signed = await auth.signContract(CONTRACT);

      // The returned object is the full signed-contract AstralObject verbatim.
      expect(signed).toEqual(SIGNED_CONTRACT);

      // The client streamed exactly the contract object (the eos is excluded
      // from the capture) on the accepted write socket.
      await server.waitFor(() => (server.callerSent.get(query)?.length ?? 0) === 1);
      expect(server.callerSent.get(query)).toEqual([CONTRACT]);
    } finally {
      await server.close();
    }
  });

  test('signContract() rejects with a RemoteError when the node streams an error', async () => {
    const query = 'auth.sign_contract';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'already signed' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      await expect(auth.signContract(CONTRACT)).rejects.toBeInstanceOf(RemoteError);
      await expect(auth.signContract(CONTRACT)).rejects.toThrow('already signed');
    } finally {
      await server.close();
    }
  });

  test('signContract() rejects with a ProtocolError when the node sends no reply', async () => {
    const query = 'auth.sign_contract';
    const server = await startMockApphost({
      routes: {
        // Accept with no scripted objects: the mock sends query_accepted then
        // eos, so the client sees the stream end without a signed contract.
        [query]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      await expect(auth.signContract(CONTRACT)).rejects.toBeInstanceOf(ProtocolError);
    } finally {
      await server.close();
    }
  });

  test('index() folds { id } into the query and resolves void on ack', async () => {
    // The object id folds into the query string; a data1… id URI-encodes to
    // itself (no reserved characters), so the folded query is exact.
    const query = `auth.index?id=${OBJECT_ID}`;
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'ack', value: null }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      await expect(auth.index(OBJECT_ID)).resolves.toBeUndefined();

      // The id is a query arg, not a streamed object: nothing is sent on the
      // accepted socket beyond opening it.
      expect(server.callerSent.get(query)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('index() rejects with a RemoteError when the node reports a failure', async () => {
    const query = `auth.index?id=${OBJECT_ID}`;
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'invalid contract' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      await expect(auth.index(OBJECT_ID)).rejects.toThrow('invalid contract');
    } finally {
      await server.close();
    }
  });

  test('index() rejects a malformed object id before touching the network', async () => {
    // parseObjectID guards the id client-side, so a non-data1 id rejects with a
    // TypeError and never opens a socket.
    const server = await startMockApphost({});
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const auth = new Auth(host);

      await expect(auth.index('not-an-object-id')).rejects.toBeInstanceOf(TypeError);
    } finally {
      await server.close();
    }
  });
});
