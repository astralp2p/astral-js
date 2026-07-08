// The quick-start example in plain JavaScript — no TypeScript toolchain needed.
// Editors still get full hints from the bundled .d.ts.
//
// Node 22+ and browsers have a global WebSocket. On Node 18–21, first:
//   import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import { connect } from 'astral-js';
import { Dir } from 'astral-js/api/dir';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });
console.log('connected to', host.alias);

// A protocol client:
const dir = new Dir(host);
console.log('alice =', await dir.resolve('alice'));

// ...or call any op directly:
console.log('raw =', await host.callOne('dir.resolve', { args: { name: 'alice' } }));
