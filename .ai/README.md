# AI context — astral-js

Context for an AI assistant helping a developer **build an app on astral-js**
(and for maintaining the SDK itself). The protocol truth is the `system`
submodule (astral-docs); this file is the map.

## What astral-js is

A browser JavaScript client (TypeScript typings) for **astrald** over the
**apphost WebSocket**, speaking **`astral.json.v1`**. Everything is JSON: values
are their JSON forms (Identity = 66-hex string or `'anyone'`; ObjectID =
`data1…` string; Nonce = 16-hex; Zone = `dvn` subset; bytes = base64). There is
no binary codec here — a native IPC transport is a future addition behind the
same `Session` / `Transport` seam.

## Layers (mirrors astral-go: `astral/` + `lib/apphost` + `api/<p>`)

- `src/astral/` — pure wire primitives, no I/O. The `AstralObject` `{ type, value }`
  model and the `{ Type, Object }` wire envelope (`wrap`/`unwrap`); `obj`/`ack`/
  `eos`/`error` + `isEos`/`isAck`/`isError`; `Identity`/`ObjectID`/`Nonce`/`Zone`
  string types + `parseIdentity`/`parseObjectID`; the error hierarchy +
  `queryErrorForCode`; `buildQueryString` (255-byte cap). Exported at
  `astral-js/astral` and re-exported from the root.
- `src/apphost/` — the WebSocket client, a faithful port of the astrald
  apphost-js reference client onto the primitives. `connect(url,{token})` →
  `Host`; `Host.query(qs, opts)` → `Stream`; `Host.call`/`callOne` (collect to
  eos); `Host.register(id, handler)` → `Registration`; `IncomingQuery` with
  `accept()`/`reject(code)`. Behind `transport.ts` (the only socket creator),
  `receiver.ts` (NDJSON queue), and `session.ts` (the `Session`/`Transport`
  seam). Bundled into the root `astral-js` entry.
- `src/api/<p>/` — one client class per protocol, each taking a `Host`:
  `Dir` (`astral-js/api/dir`), `Crypto` (`api/crypto`), `Tree` (`api/tree`),
  `Objects` (`api/objects`). Each method folds args into a query string and
  decodes the result via astral-core.

## Load-bearing invariants (do not break)

- **`{ Type, Object }` ↔ `{ type, value }`** is mapped in exactly one place
  (`astral/object.ts` `wrap`/`unwrap`); everything above works in `{ type, value }`.
- **Fresh WebSocket per operation.** `connect` handshakes once and closes; every
  `query`/`register`/`accept` opens a new socket. No pooling. The registration
  socket is the one long-lived socket; each `accept()` opens its own.
- **The receiver attaches before the socket opens** — the node sends
  `host_info_msg` immediately on open, and neither the DOM `WebSocket` nor `ws`
  buffers pre-listener messages (see `transport.openSocket` + `session.open`).
- Wire object type tags are the **short forms** (`identity`, `object_id.sha256`,
  `nonce64`, `eos`, `ack`, `string8`, …), not the fully-qualified names in the
  spec prose.

## Protocol clients (basic ops)

- **dir** — `resolve(name)→Identity`, `getAlias(id)→string`, `setAlias(id, alias?)→void`.
- **crypto** — `publicKey({scheme?})`, `signText(text,{key?,scheme?})`, `verifyTextSignature(text,sig,key)→boolean`.
- **tree** — `get(path,{follow?})` (object, or a live `Stream` with `follow`),
  `set(path, value)` (bidirectional: stream the value + eos, read ack),
  `list(path)→AsyncIterable<string>`, `delete(path,{recursive?})`.
- **objects** — `probe(id)`, `contains(id)→boolean`, `getType(id)→string`,
  `find(id)→AsyncIterable<Identity>`.

## Deferred / caveats

- Deferred: native IPC (binary unix/tcp) transport, `objects.read` (raw
  unframed bytes — not representable over JSON), the advanced protocol ops
  (`dir.apply_filters`/`alias_map`, `crypto` hash-signing, `tree.mount`,
  `objects` write/describe/search), and the `user` protocol.
- **Needs live-node confirmation** (flagged in the source JSDoc): `crypto.public_key`
  and `crypto.verify_text_signature` (the Go ops read a *streamed* key/signature
  object, not the query arg — the astral-py query form is used here), and
  `objects.contains` (default-repository dependency). Confirm against a running
  node before treating these as frozen.

## Spec (the `system` submodule = astral-docs)

- Transport / encoding: `system/topics/astral-ipc.md`, `ws-transport.md`,
  `json-encoding.md`, `op-modes.md`.
- Per-protocol: `system/protocols/<name>/` (apphost, dir, crypto, tree, objects, …).
- Pinned at a specific commit; update it deliberately via `git submodule update --remote`.

## Working on the SDK

- `npm run check` = typecheck + lint + test + build; every change must keep it green.
- Tests use a real in-process `ws` mock apphost (`test/mock-apphost.ts`) with
  `globalThis.WebSocket` swapped in — the client's real socket path runs, no live
  node needed.
- The published surface is validated by `npm run verify:pkg` (publint) plus a
  packed-tarball ESM/CJS/`.d.ts` consumer smoke.
