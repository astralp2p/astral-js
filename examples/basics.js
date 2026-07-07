// The basics example in plain JavaScript — no TypeScript toolchain required.
// Editors still get full type hints from the bundled .d.ts.
//
// Node 22+ and browsers have a global WebSocket. On Node 18–21, first:
//   import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import { connect } from 'astral-js';
import { Dir } from 'astral-js/api/dir';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });
console.log('connected to', host.alias, host.identity);

const dir = new Dir(host);
console.log('alice =', await dir.resolve('alice'));

const stream = await host.query('objects.search', { args: { q: 'invoice' } });
for await (const { type, value } of stream) {
  console.log(type, value);
}
