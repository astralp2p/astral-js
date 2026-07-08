# astral-js examples

Small runnable examples against a **local astrald node**. Each file sets
`ENDPOINT` (the apphost WebSocket URL) and `TOKEN` (an access token) at the top —
edit those to point at your node.

Run with [`tsx`](https://github.com/privatenumber/tsx) (or build the package and
run the `.js` with `node`):

```sh
npx tsx examples/basics.ts
node examples/basics.js
```

| File | Shows |
|------|-------|
| [`basics.ts`](./basics.ts) | connect, the **`dir`** protocol client, and calling raw ops directly (`host.callOne` / `host.query`) |
| [`crypto.ts`](./crypto.ts) | the **`crypto`** protocol client — derive a public key, sign text, verify a signature |
| [`serve.ts`](./serve.ts) | register a handler and respond to inbound queries |
| [`basics.js`](./basics.js) | the basics example in plain JavaScript (no TypeScript toolchain) |

Two ways to talk to the node:

- **Protocol clients** — `import { Dir } from 'astral-js/api/dir'` and call typed
  methods (`dir.resolve(...)`).
- **Raw ops** — `host.callOne('dir.resolve', { args })` for a single value,
  `host.call(...)` to collect a stream, or `host.query(...)` for a `Stream` you
  iterate with `for await`. Works for any astrald op, even ones without a client.
