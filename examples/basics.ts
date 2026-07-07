/**
 * Connect to a local astrald node, resolve an alias, and stream a query.
 *
 * Run against a real node (e.g. `npx tsx examples/basics.ts`). Set ENDPOINT and
 * TOKEN to your node's apphost WebSocket URL and an access token.
 */
import { connect } from 'astral-js';
import { Dir } from 'astral-js/api/dir';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });
console.log('connected to', host.alias, host.identity);

// Resolve a name to an identity via the dir protocol client.
const dir = new Dir(host);
const alice = await dir.resolve('alice');
console.log('alice =', alice);

// Run a raw query and stream its results until end-of-stream.
const stream = await host.query('objects.search', { args: { q: 'invoice' } });
for await (const { type, value } of stream) {
  console.log(type, value);
}
