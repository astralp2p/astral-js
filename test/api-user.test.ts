/**
 * Tests for the `user` protocol client ({@link User}), driven against the
 * in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each route is keyed on the EXACT folded query string the client sends
 * (`user.<op>?<args>`), so every test asserts both the decoded/returned value
 * and — by the route matching at all — the outgoing query string (an unmatched
 * query is answered `route_not_found` and the call rejects). The bidirectional
 * `acceptMembership` op additionally asserts the objects it streamed via the
 * mock's `callerSent` capture.
 *
 * Covers the three CLIENT ops: `newNodeContract` (query arg `user`, returned
 * contract, and the empty-response ProtocolError), `acceptMembership` (the two
 * streamed inputs + the returned subject signature, plus a streamed
 * RemoteError), and `expel` (query arg `target` for both an Identity and its
 * string form, and the returned signed expulsion).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import { User } from '../src/api/user/index.js';
import { parseIdentity } from '../src/astral/identity.js';
import { ProtocolError, RemoteError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

/** A fixed, valid 66-hex node identity the tests expel. */
const NODE_ID = 'c'.repeat(66);

/** A representative `mod.auth.contract` wire object (pass-through value). */
const CONTRACT = {
  type: 'mod.auth.contract',
  value: {
    Issuer: 'a'.repeat(66),
    Subject: 'b'.repeat(66),
    Permits: [{ Action: 'mod.user.swarm_membership_action', Constraints: null, Delegation: 0 }],
    ExpiresAt: '2027-01-01T00:00:00Z',
  },
};

/** The issuer's `mod.crypto.signature` (compact `<scheme>:<base64>` text form). */
const ISSUER_SIG = { type: 'mod.crypto.signature', value: 'bip137:aXNzdWVy' };

/** The node's subject `mod.crypto.signature`, returned by accept_membership. */
const SUBJECT_SIG = { type: 'mod.crypto.signature', value: 'bip137:c3ViamVjdA==' };

/** A representative `mod.user.signed_expulsion` wire object. */
const SIGNED_EXPULSION = {
  type: 'mod.user.signed_expulsion',
  value: {
    Issuer: 'a'.repeat(66),
    Subject: NODE_ID,
    ExpelledAt: '2026-07-08T00:00:00Z',
    IssuerSig: 'bip137:ZXhwZWw=',
  },
};

describe('User protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('newNodeContract() folds { user } and returns the single contract object', async () => {
    // The client sends the issuer alias under the `user` key (NOT `alias`), so
    // the route only matches that exact folded query.
    const query = 'user.new_node_contract?user=alice';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: CONTRACT.type, value: CONTRACT.value }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      const contract = await user.newNodeContract('alice');

      // The full contract object round-trips (type tag preserved).
      expect(contract).toEqual(CONTRACT);
    } finally {
      await server.close();
    }
  });

  test('newNodeContract() rejects with a ProtocolError when the node returns no object', async () => {
    const query = 'user.new_node_contract?user=alice';
    const server = await startMockApphost({
      // The node accepts the query but streams nothing before eos.
      routes: { [query]: { accept: [] } },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      await expect(user.newNodeContract('alice')).rejects.toBeInstanceOf(ProtocolError);
    } finally {
      await server.close();
    }
  });

  test('newNodeContract() surfaces a streamed error as a RemoteError', async () => {
    const query = 'user.new_node_contract?user=nobody';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'identity not found' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      await expect(user.newNodeContract('nobody')).rejects.toBeInstanceOf(RemoteError);
      await expect(user.newNodeContract('nobody')).rejects.toThrow('identity not found');
    } finally {
      await server.close();
    }
  });

  test('acceptMembership() streams the contract + issuer sig and returns the subject sig', async () => {
    // No query args: the op string is bare. The node replies with the subject
    // signature, then eos; the socket stays open so the streamed inputs land.
    const query = 'user.accept_membership';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: SUBJECT_SIG.type, value: SUBJECT_SIG.value }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      const subjectSig = await user.acceptMembership(CONTRACT, ISSUER_SIG);
      expect(subjectSig).toEqual(SUBJECT_SIG);

      // The client streamed exactly the contract then the issuer signature, in
      // that order (the trailing eos is excluded from the capture).
      await server.waitFor(() => (server.callerSent.get(query)?.length ?? 0) === 2);
      expect(server.callerSent.get(query)).toEqual([CONTRACT, ISSUER_SIG]);
    } finally {
      await server.close();
    }
  });

  test('acceptMembership() rejects with a RemoteError when the node streams an error', async () => {
    const query = 'user.accept_membership';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'invitation declined' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      await expect(user.acceptMembership(CONTRACT, ISSUER_SIG)).rejects.toThrow(
        'invitation declined',
      );
    } finally {
      await server.close();
    }
  });

  test('acceptMembership() rejects with a ProtocolError when the node returns no signature', async () => {
    const query = 'user.accept_membership';
    const server = await startMockApphost({
      // The node accepts and ends the stream without a subject signature.
      routes: { [query]: { accept: [] } },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      await expect(user.acceptMembership(CONTRACT, ISSUER_SIG)).rejects.toBeInstanceOf(
        ProtocolError,
      );
    } finally {
      await server.close();
    }
  });

  test('expel() folds { target } from a string and returns the signed expulsion', async () => {
    const query = `user.expel?target=${NODE_ID}`;
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: SIGNED_EXPULSION.type, value: SIGNED_EXPULSION.value }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      const ban = await user.expel(NODE_ID);
      expect(ban).toEqual(SIGNED_EXPULSION);
    } finally {
      await server.close();
    }
  });

  test('expel() folds { target } from an Identity to the same query', async () => {
    // A parsed Identity folds to the identical target arg as its string form.
    const query = `user.expel?target=${NODE_ID}`;
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: SIGNED_EXPULSION.type, value: SIGNED_EXPULSION.value }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      const ban = await user.expel(parseIdentity(NODE_ID));
      expect(ban).toEqual(SIGNED_EXPULSION);
    } finally {
      await server.close();
    }
  });

  test('expel() rejects with a ProtocolError when the node returns no object', async () => {
    const query = `user.expel?target=${NODE_ID}`;
    const server = await startMockApphost({
      routes: { [query]: { accept: [] } },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const user = new User(host);

      await expect(user.expel(NODE_ID)).rejects.toBeInstanceOf(ProtocolError);
    } finally {
      await server.close();
    }
  });
});
