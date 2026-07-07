# astral-js

A browser JavaScript client — with TypeScript typings — for **astrald**, the
node daemon of the [Astral Network](https://github.com/cryptopunkscc/astral-docs).
It talks to a local node over the **apphost WebSocket** using the
`astral.json.v1` protocol, so web apps can route queries through the node, serve
inbound queries for identities they own, resolve aliases, sign data, and fetch
objects.

- **Browser-first.** Uses the global `WebSocket`; on Node 22+ that's built in,
  on older Node add the optional [`ws`](https://www.npmjs.com/package/ws) package.
- **TypeScript-authored, JavaScript-consumed.** Ships compiled ESM + CommonJS
  with bundled `.d.ts`, so plain-JS projects get full editor autocomplete with no
  TypeScript toolchain.
- **JSON over WebSocket only, for now.** A native IPC transport (Node unix/tcp)
  is a future addition; the API is built on a transport seam so it slots in
  without breaking changes.

## Install

```sh
npm install astral-js
# Node 18–21 only (no global WebSocket): also
npm install ws
```

```js
// Node < 22: install the global WebSocket before connecting
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
```

## Connect and query

`connect()` handshakes with the node and returns a `Host`. Each query opens its
own short-lived WebSocket and streams `{ type, value }` objects until end-of-stream.

```js
import { connect } from 'astral-js';

const host = await connect('ws://127.0.0.1:8624/.ws', { token: '…' });
console.log('connected to', host.alias, host.identity);

const stream = await host.query('objects.search', { args: { q: 'invoice' } });
for await (const { type, value } of stream) {
  console.log(type, value);
}
```

For single-result queries there are helpers on `Host`:

```js
const objs = await host.call('dir.get_alias', { args: { id } }); // AstralObject[]
const one = await host.callOne('dir.resolve', { args: { name: 'alice' } }); // first value
```

## Serve inbound queries

Register a handler for an identity you own. For each inbound query you get an
`IncomingQuery` to `accept()` (returning a responder stream) or `reject(code)`.
You have ~5 seconds to respond.

```js
const reg = await host.register(host.guestID, async (q) => {
  console.log('incoming', q.caller, '→', q.query, q.params);

  if (q.query.startsWith('forbidden')) return q.reject(1);

  const stream = await q.accept();
  stream.send({ type: 'string8', value: 'hello, ' + q.caller });
  stream.send({ type: 'eos', value: null });
  stream.close();
});

// later
reg.unregister();
```

## Protocol clients

Each protocol has a small typed client that wraps `Host`, imported from its own
subpath.

```js
import { Dir } from 'astral-js/api/dir';
import { Crypto } from 'astral-js/api/crypto';
import { Tree } from 'astral-js/api/tree';
import { Objects } from 'astral-js/api/objects';

const dir = new Dir(host);
const id = await dir.resolve('alice');       // Identity
const alias = await dir.getAlias(id);         // 'alice' or ''
await dir.setAlias(id, 'alice');              // '' clears it

const crypto = new Crypto(host);
const key = await crypto.publicKey();                              // 'scheme:hex'
const sig = await crypto.signText('hello');                        // 'scheme:base64'
const ok = await crypto.verifyTextSignature('hello', sig, key);    // boolean

const tree = new Tree(host);
const value = await tree.get('/net/alias');                        // AstralObject
await tree.set('/net/alias', { type: 'string8', value: 'alice' }); // write
for await (const name of await tree.list('/net')) console.log(name);
await tree.delete('/net/alias');

const objects = new Objects(host);
const has = await objects.contains(id);                            // boolean
const type = await objects.getType(id);                           // string
for await (const holder of await objects.find(id)) console.log(holder);
```

## Primitives

The wire primitives live at `astral-js/astral` (and are re-exported from the
root): the `AstralObject` `{ type, value }` model and its constructors, the
identity / object-id / nonce / zone string types, and the error hierarchy.

```js
import { obj, ack, eos, parseIdentity, buildQueryString } from 'astral-js/astral';
```

## Errors

```js
import { connect, ConnectError, AuthError, QueryRejected, RouteNotFound, RemoteError } from 'astral-js';

try {
  const host = await connect(url, { token: 'wrong' });
} catch (e) {
  if (e instanceof AuthError) console.warn('bad token');
  else if (e instanceof ConnectError) console.warn('cannot reach the node');
  else throw e;
}
```

`QueryRejected` (with a numeric `.code`) and `RouteNotFound` come from `host.query`;
`RemoteError` is thrown by `host.call`/`callOne` when the responder streams an error.

## Package layout

```
astral-js            → the apphost client: connect, Host, Stream, register, errors
astral-js/astral     → wire primitives (AstralObject, Identity, ObjectID, Zone, …)
astral-js/api/dir    → Dir
astral-js/api/crypto → Crypto
astral-js/api/tree   → Tree
astral-js/api/objects→ Objects
```

Runnable examples are in [`examples/`](./examples). AI-assistant context for
building on the SDK is in [`.ai/README.md`](./.ai/README.md) (see also
[`CLAUDE.md`](./CLAUDE.md)); the protocol specification is the `.ai/system`
submodule ([astral-docs](https://github.com/cryptopunkscc/astral-docs)).

## Status & caveats

`astral.json.v1` over WebSocket only. Not yet implemented (needs the future IPC
transport or is otherwise deferred): `objects.read` (raw bytes), the advanced
protocol ops, and the `user` protocol. A few wire shapes are inherited from the
Python reference client and marked in the source as needing confirmation against
a live node (`crypto.public_key`, `crypto.verify_text_signature`,
`objects.contains`).

## License

MIT — see [LICENSE](./LICENSE).
