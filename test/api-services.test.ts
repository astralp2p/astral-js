/**
 * Tests for the `services` protocol client ({@link Services}), driven against
 * the in-process mock apphost (`test/mock-apphost.ts`) via its `routes` option.
 *
 * Each route is keyed on the EXACT folded query string the client sends
 * (`services.discover?<args>`), so every test asserts both the decoded stream
 * values and — by the route matching at all — the outgoing query string (an
 * unmatched query is answered `route_not_found`, which would surface when the
 * stream is drained).
 *
 * Covers the one BASIC op: `discover` in snapshot mode (default, no `follow`
 * arg), `discover(true)` in follow mode (asserting the folded `follow=true` and
 * the snapshot it yields before the separator), the decoded `services.update`
 * value shape, an empty snapshot, and a streamed error surfacing as a
 * {@link RemoteError}.
 *
 * NOTE on follow mode: the mock's accept path streams the scripted objects then
 * a single `eos` and then leaves the socket open. That single `eos` plays the
 * snapshot/live separator, so a follow test can assert the folded query and the
 * snapshot updates by draining the first (snapshot) segment and breaking out —
 * breaking closes the underlying stream via the iterator's `finally`. The mock
 * cannot emit a second (live) segment, so the two-segment live flow past the
 * separator is exercised against a live node, not here.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { connect } from '../src/apphost/host.js';
import type { AstralObject } from '../src/astral/object.js';
import { Services } from '../src/api/services/index.js';
import type { ServiceUpdateValue } from '../src/api/services/index.js';
import { RemoteError } from '../src/astral/errors.js';
import {
  startMockApphost,
  installGlobalWebSocket,
  DEFAULT_GOOD_TOKEN,
} from './mock-apphost.js';

/** A provider identity in wire form (a fixed, valid 66-hex string). */
const PROVIDER_ID = 'c'.repeat(66);

/** A representative `services.update` value, shaped like the Go struct's JSON. */
function updateValue(name: string, available: boolean): ServiceUpdateValue {
  return { Available: available, Name: name, ProviderID: PROVIDER_ID, Info: [] };
}

describe('Services protocol client against the mock apphost', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installGlobalWebSocket();
  });

  afterAll(() => {
    restore();
  });

  test('discover() omits the follow arg and yields each services.update', async () => {
    // Snapshot mode folds no args at all: the query string is the bare op.
    const query = 'services.discover';
    const first = updateValue('chat', true);
    const second = updateValue('files', true);
    const server = await startMockApphost({
      routes: {
        [query]: {
          accept: [
            { type: 'services.update', value: first },
            { type: 'services.update', value: second },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      const updates: AstralObject[] = [];
      for await (const u of await services.discover()) updates.push(u);

      // Each update round-trips as a raw AstralObject: type tag preserved and
      // the value shaped like the Go struct's JSON (verbatim PascalCase keys).
      expect(updates).toEqual([
        { type: 'services.update', value: first },
        { type: 'services.update', value: second },
      ]);
    } finally {
      await server.close();
    }
  });

  test('discover() decodes the update value into the documented shape', async () => {
    const query = 'services.discover';
    const value = updateValue('chat', true);
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'services.update', value }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      const seen: ServiceUpdateValue[] = [];
      for await (const u of await services.discover()) {
        seen.push(u.value as ServiceUpdateValue);
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        Available: true,
        Name: 'chat',
        ProviderID: PROVIDER_ID,
        Info: [],
      });
    } finally {
      await server.close();
    }
  });

  test('discover() yields nothing for an empty snapshot', async () => {
    const query = 'services.discover';
    const server = await startMockApphost({
      routes: {
        // No scripted objects: the mock sends query_accepted then eos, so the
        // iterable completes without yielding.
        [query]: { accept: [] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      const updates: AstralObject[] = [];
      for await (const u of await services.discover()) updates.push(u);

      expect(updates).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('discover(true) folds follow=true and yields the snapshot segment', async () => {
    // Follow mode folds &follow=true; the route only matches that exact folded
    // query, so a match asserts the client sent it. The mock's single eos plays
    // the snapshot/live separator: the first (snapshot) segment yields the
    // scripted updates, then breaking out closes the stream.
    const query = 'services.discover?follow=true';
    const first = updateValue('chat', true);
    const second = updateValue('files', false);
    const server = await startMockApphost({
      routes: {
        [query]: {
          accept: [
            { type: 'services.update', value: first },
            { type: 'services.update', value: second },
          ],
        },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      const updates: AstralObject[] = [];
      for await (const u of await services.discover(true)) {
        updates.push(u);
        // Stop once the snapshot is drained; breaking closes the stream (via the
        // iterator's finally) before the second, live segment would block on the
        // still-open socket.
        if (updates.length === 2) break;
      }

      expect(updates).toEqual([
        { type: 'services.update', value: first },
        { type: 'services.update', value: second },
      ]);
    } finally {
      await server.close();
    }
  });

  test('discover() surfaces a streamed error as a RemoteError', async () => {
    const query = 'services.discover';
    const server = await startMockApphost({
      routes: {
        // The node accepts the query, then streams an error object when
        // discovery fails (astrald OpDiscover sends astral.NewError).
        [query]: { accept: [{ type: 'error_message', value: 'discovery failed' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of await services.discover()) {
            /* drain */
          }
        })(),
      ).rejects.toBeInstanceOf(RemoteError);
    } finally {
      await server.close();
    }
  });

  test('discover() surfaces the error message from the streamed error object', async () => {
    const query = 'services.discover';
    const server = await startMockApphost({
      routes: {
        [query]: { accept: [{ type: 'error_message', value: 'discovery failed' }] },
      },
    });
    try {
      const host = await connect(server.url, { token: DEFAULT_GOOD_TOKEN });
      const services = new Services(host);

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of await services.discover()) {
            /* drain */
          }
        })(),
      ).rejects.toThrow('discovery failed');
    } finally {
      await server.close();
    }
  });
});
