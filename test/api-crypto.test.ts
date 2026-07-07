/**
 * Tests for the `crypto` protocol client ({@link Crypto}), driven against the
 * in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each route is keyed on the EXACT folded query string the client sends
 * (`crypto.<op>?<args>`), so every test asserts both the decoded return value
 * and — implicitly, by the route matching at all — the outgoing query string:
 * an unmatched query is answered `route_not_found` and the call rejects.
 *
 * Covers the three BASIC ops: `publicKey` (with and without `scheme`),
 * `signText` (bare and with `key`/`scheme`), and `verifyTextSignature` for both
 * the valid (ack) and invalid (streamed `error_message`) paths.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import { Crypto } from '../src/api/crypto/index.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

describe('Crypto protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('publicKey() with no scheme queries crypto.public_key and returns the key text', async () => {
    const server = await startMockApphost({
      routes: {
        'crypto.public_key': {
          accept: [{ type: 'string8', value: 'bip137:03abcd' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const key = await crypto.publicKey();

      expect(key).toBe('bip137:03abcd');
    } finally {
      await server.close();
    }
  });

  test('publicKey({ scheme }) folds scheme into the query string', async () => {
    const server = await startMockApphost({
      routes: {
        'crypto.public_key?scheme=bip137': {
          accept: [{ type: 'string8', value: 'bip137:03ef01' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const key = await crypto.publicKey({ scheme: 'bip137' });

      expect(key).toBe('bip137:03ef01');
    } finally {
      await server.close();
    }
  });

  test('signText(text) queries crypto.sign_text?text=… and returns the signature', async () => {
    const server = await startMockApphost({
      routes: {
        // A space must URI-encode to %20 in the folded query the client sends.
        'crypto.sign_text?text=hello%20world': {
          accept: [{ type: 'string8', value: 'bip137:SIGN==' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const sig = await crypto.signText('hello world');

      expect(sig).toBe('bip137:SIGN==');
    } finally {
      await server.close();
    }
  });

  test('signText(text, { key, scheme }) folds all args in text/key/scheme order', async () => {
    const server = await startMockApphost({
      routes: {
        'crypto.sign_text?text=hi&key=bip137%3A03aa&scheme=bip137': {
          accept: [{ type: 'string8', value: 'bip137:OTHER==' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const sig = await crypto.signText('hi', { key: 'bip137:03aa', scheme: 'bip137' });

      expect(sig).toBe('bip137:OTHER==');
    } finally {
      await server.close();
    }
  });

  test('verifyTextSignature returns true when the node acks a valid signature', async () => {
    const server = await startMockApphost({
      routes: {
        'crypto.verify_text_signature?text=hi&sig=bip137%3ASIG&key=bip137%3AKEY': {
          // A valid signature: the node acks (an ack object, value null).
          accept: [{ type: 'ack', value: null }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const ok = await crypto.verifyTextSignature('hi', 'bip137:SIG', 'bip137:KEY');

      expect(ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('verifyTextSignature returns true on an empty (ack-less) accept', async () => {
    // The node may accept and close with no object before eos; callOne yields
    // null and, being non-error, that still means valid.
    const server = await startMockApphost({
      routes: {
        'crypto.verify_text_signature?text=hi&sig=bip137%3ASIG&key=bip137%3AKEY': {
          accept: [],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const ok = await crypto.verifyTextSignature('hi', 'bip137:SIG', 'bip137:KEY');

      expect(ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('verifyTextSignature returns false when the node streams an error_message', async () => {
    const server = await startMockApphost({
      routes: {
        'crypto.verify_text_signature?text=hi&sig=bip137%3ABAD&key=bip137%3AKEY': {
          // An invalid signature: the node streams an error_message object,
          // which Host.callOne surfaces as a RemoteError the client catches.
          accept: [{ type: 'error_message', value: 'invalid signature' }],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const crypto = new Crypto(host);

      const ok = await crypto.verifyTextSignature('hi', 'bip137:BAD', 'bip137:KEY');

      expect(ok).toBe(false);
    } finally {
      await server.close();
    }
  });
});
