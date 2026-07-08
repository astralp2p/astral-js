/**
 * Quick start — connect to a local astrald node, use a protocol client, and
 * call raw ops directly.
 *
 * Run against a real node:  npx tsx examples/basics.ts
 * Set ENDPOINT / TOKEN below to your node's apphost WebSocket URL and an access
 * token.
 */
import { connect } from 'astral-js';
import { Dir } from 'astral-js/api/dir';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

// connect() handshakes with the node and returns a Host.
const host = await connect(ENDPOINT, { token: TOKEN });
console.log('connected to', host.alias, `(${host.identity})`);

// ── Using a protocol client (dir) ────────────────────────────────
// Each protocol has a small typed client that wraps the Host.
const dir = new Dir(host);
const alice = await dir.resolve('alice'); // a name/alias -> an Identity
console.log('resolved alice =', alice);
console.log('alias of alice =', await dir.getAlias(alice));

// ── Calling any astrald op directly (no protocol client needed) ──
// host.callOne(op, { args }) runs a query and returns the first result's value.
const sameAlice = await host.callOne('dir.resolve', { args: { name: 'alice' } });
console.log('raw dir.resolve =', sameAlice);

// host.query(op, { args }) returns a Stream you iterate to end-of-stream.
const children = await host.query('tree.list', { args: { path: '/' } });
for await (const { value } of children) {
  console.log('tree child:', value);
}
