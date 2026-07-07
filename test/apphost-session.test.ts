/**
 * Phase-1 transport-seam tests: drive {@link JsonWsTransport} against a real,
 * in-process mock apphost (`test/mock-apphost.ts`) speaking `astral.json.v1`.
 *
 * Covers the handshake surface only — host info capture, token auth (success,
 * skip, failure), a socket that closes before greeting, and the receiver's
 * coalesced-frame splitting. Higher layers (Host/connect/query/Stream/register)
 * are later phases and are not exercised here.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { JsonWsTransport } from '../src/apphost/session.js';
import { Receiver } from '../src/apphost/receiver.js';
import type { WebSocketLike } from '../src/apphost/transport.js';
import { AuthError, ProtocolError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_HOST_IDENTITY,
  DEFAULT_HOST_ALIAS,
  DEFAULT_GUEST_IDENTITY,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

describe('JsonWsTransport handshake against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('open() with the good token captures host info and guest id', async () => {
    const server = await startMockApphost();
    try {
      const transport = new JsonWsTransport(server.url, DEFAULT_GOOD_TOKEN);
      const session = await transport.open();

      expect(session.hostInfo).toEqual({
        identity: DEFAULT_HOST_IDENTITY,
        alias: DEFAULT_HOST_ALIAS,
      });
      expect(session.guestID).toBe(DEFAULT_GUEST_IDENTITY);

      session.close();
    } finally {
      await server.close();
    }
  });

  test('open() with no token yields a null guest id but still captures host info', async () => {
    const server = await startMockApphost({
      hostIdentity: DEFAULT_HOST_IDENTITY,
      hostAlias: 'no-auth-host',
    });
    try {
      // No token on the transport → the auth step is skipped entirely.
      const transport = new JsonWsTransport(server.url);
      const session = await transport.open();

      expect(session.hostInfo).toEqual({
        identity: DEFAULT_HOST_IDENTITY,
        alias: 'no-auth-host',
      });
      expect(session.guestID).toBeNull();

      session.close();
    } finally {
      await server.close();
    }
  });

  test('open() honours skipAuth even when the transport holds a token', async () => {
    const server = await startMockApphost();
    try {
      const transport = new JsonWsTransport(server.url, DEFAULT_GOOD_TOKEN);
      const session = await transport.open({ skipAuth: true });

      // skipAuth suppresses the token exchange, so no guest id is assigned.
      expect(session.guestID).toBeNull();
      expect(session.hostInfo.alias).toBe(DEFAULT_HOST_ALIAS);

      session.close();
    } finally {
      await server.close();
    }
  });

  test('open() with a bad token rejects with AuthError', async () => {
    const server = await startMockApphost({ goodToken: DEFAULT_GOOD_TOKEN });
    try {
      const transport = new JsonWsTransport(server.url, 'wrong-token');
      await expect(transport.open()).rejects.toBeInstanceOf(AuthError);
      await expect(transport.open()).rejects.toMatchObject({ code: 'auth_failed' });
    } finally {
      await server.close();
    }
  });

  test('open() rejects with ProtocolError when the server closes before host_info', async () => {
    // The socket opens then closes without a greeting, so recv() yields null and
    // the handshake reports the missing host_info_msg — faithful to the reference
    // client, which throws in the same branch.
    const server = await startMockApphost({ closeBeforeHostInfo: true });
    try {
      const transport = new JsonWsTransport(server.url, DEFAULT_GOOD_TOKEN);
      await expect(transport.open()).rejects.toBeInstanceOf(ProtocolError);
    } finally {
      await server.close();
    }
  });
});

describe('Receiver coalesced-frame splitting', () => {
  /**
   * A minimal in-memory {@link WebSocketLike} whose `emit` pushes a frame into
   * the registered `message` listener — no real socket, so the split behaviour
   * is exercised in isolation.
   */
  class FakeSocket implements WebSocketLike {
    private messageListener?: (event: unknown) => void;
    readonly sent: string[] = [];

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      /* no-op */
    }

    addEventListener(
      type: 'open' | 'message' | 'error' | 'close',
      listener: (event: unknown) => void,
    ): void {
      if (type === 'message') this.messageListener = listener;
    }

    /** Deliver a single text frame to the receiver. */
    emit(data: string): void {
      this.messageListener?.({ data });
    }
  }

  test('one frame carrying two newline-delimited envelopes yields both objects in order', async () => {
    const ws = new FakeSocket();
    const receiver = new Receiver(ws);

    const first = JSON.stringify({ Type: 'mod.apphost.host_info_msg', Object: { Alias: 'one' } });
    const second = JSON.stringify({ Type: 'ack', Object: null });
    ws.emit(`${first}\n${second}`);

    const a = await receiver.next();
    const b = await receiver.next();

    expect(a).toEqual({ type: 'mod.apphost.host_info_msg', value: { Alias: 'one' } });
    expect(b).toEqual({ type: 'ack', value: null });
  });

  test('blank lines between envelopes are skipped', async () => {
    const ws = new FakeSocket();
    const receiver = new Receiver(ws);

    const only = JSON.stringify({ Type: 'ack', Object: null });
    ws.emit(`\n${only}\n\n`);

    expect(await receiver.next()).toEqual({ type: 'ack', value: null });
  });
});
