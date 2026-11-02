# AI context — astral-js

Context for an AI assistant helping a developer **build an app on astral-js**
(and for maintaining the SDK itself). The protocol truth is the `system`
submodule (astral-docs); this file is the map.

## What astral-js is

A browser JavaScript client (TypeScript typings) for **astrald** over the
**apphost WebSocket**, speaking **`astral.json.v1`**. Everything is JSON: values
are their JSON forms (Identity = 66-hex string or `'anyone'`; ObjectID =
`data1…` string, or `data0…` for a partial id, which is read and never emitted;
Nonce = 16-hex; Zone = `dvn` subset; bytes = base64). There is
no binary codec here — a native IPC transport is a future addition behind the
same `Session` / `Transport` seam.

## Layers (mirrors astral-go: `astral/` + `lib/apphost` + `api/<p>`)

- `src/astral/` — pure wire primitives, no I/O. The `AstralObject` `{ type, value }`
  model and the `{ Type, Object }` wire envelope (`wrap`/`unwrap`); `obj`/`ack`/
  `eos`/`error` + `isEos`/`isAck`/`isError`; `Identity`/`ObjectID`/`Nonce`/`Zone`
  string types + `parseIdentity`/`parseObjectID`; `decodeObjectID`/
  `encodeObjectID` (an id ↔ its 8-byte size + 32-byte sha256 digest, mirroring
  astral-go's `ParseID`/`String`: both text forms decode, `data1` alone
  encodes); the error hierarchy +
  `queryErrorForCode`; `buildQueryString` (255-byte cap). Exported at
  `astral-js/astral` and re-exported from the root.
- `src/apphost/` — the WebSocket client, a faithful port of the astrald
  apphost-js reference client onto the primitives. `connect(url,{token})` →
  `Host`; `Host.query(qs, opts)` → `Stream`; `Host.call`/`callOne` (collect to
  eos); `Host.register(id, handler)` → `Registration`; `IncomingQuery` with
  `accept()`/`reject(code)`. Behind `transport.ts` (the only socket creator),
  `receiver.ts` (NDJSON queue), and `session.ts` (the `Session`/`Transport`
  seam). Exported at `astral-js/apphost`; the root `astral-js` re-exports just
  `connect` (plus the primitives) as a convenience entry.
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
- **crypto** — `publicKey({scheme?})`, `signText(text,{key?,scheme?})`, `verifyTextSignature(text,sig,key)→boolean`,
  `signHash(hash,{key?,scheme?})` (scheme sent explicitly, `asn1` default), `verifyHashSignature(hash,sig,key)→boolean`.
- **tree** — `get(path,{follow?})` (object, or a live `Stream` with `follow`),
  `set(path, value)` (bidirectional: stream the value + eos, read ack),
  `list(path)→AsyncIterable<string>`, `delete(path,{recursive?})`.
- **objects** — `probe(id)`, `contains(id)→boolean`,
  `find(id)→AsyncIterable<Identity>`,
  `store(objects,{repo?})→ObjectID[]` (bidirectional: stream the objects + eos,
  collect one id per object),
  `registerBlueprint(bp|bp[])→ObjectID[]` (batch: define an object type; struct
  or alias kind — node-memory-only, requires `mod.auth.store_objects_action`),
  `getBlueprint(type)→Blueprint` (read a registered type back),
  `repositories()→RepositoryInfoValue[]` (the repository tree; `Kind` is
  `repository` or `group` — an empty group looks like a leaf in `Children`).
- **user** — swarm membership: `newNodeContract(alias)`, `acceptMembership(contract, issuerSig)`, `expel(nodeID)`;
  status/management: `info()→UserInfoValue`, `adopt(target)`,
  `swarmStatus()→SwarmMemberValue[]` (member tag is the plural
  `mod.users.swarm_member`); setup of an unclaimed node:
  `deriveIdentity(words?, {passphrase?})→DeriveIdentityResultValue` (the user
  the words derive, with the derivation of `bootstrap`; claims nothing),
  `bootstrap(words?, {passphrase?})→BootstrapResultValue` (claims the node in
  one call; the reply's `Token` is an apphost access token for the user), and
  `join(node)→SignedContract` (the node requests membership from a swarm node).
  For `deriveIdentity` and `bootstrap` the words travel in the stream, never in
  the query; no words sends `generate=true` and the reply's `Mnemonic` carries
  the generated words.
- **auth** — permission contracts: `signContract(contract)`.
- **services** — provider: `advertise(handlers)→Binding` (`{ [service]: (caller) => Offering | null }`;
  `change(...callers)`, `changeAll()`, `close()`, `done`); consumer: `discover(names, follow?)→DiscoveryStream`
  of `update` / `removed` / `initial` events, and `watch(names)→Watcher` (`offerings()`, `initial`,
  `onChange`, `done`, `close`). `{ reach: 'swarm' }` on discover/watch carries the discovery to the
  node's swarm. Names travel as one comma-separated `services` argument. No
  re-advertise after a disconnect: the app opens a new binding.
- **nearby** — LAN discovery: `broadcast()`, `list()→AstralObject[]` of
  `mod.nearby.status` (alias travels inside the `Attachments` bundle).
- **nodes** — links and endpoints: `links()→AstralObject[]` of
  `mod.nodes.link_info` (a fact about now), `resolveEndpoints(id)→AstralObject[]`
  of `mod.nodes.endpoint_with_ttl` (a fact about the past; empty is an answer,
  not a failure), `newLink(target,{endpoint?,strategies?})→LinkInfoValue`.
  Endpoints nested in a value stay `{Type,Object}` wire adapters — the library
  unwraps the frame envelope only.
- **bip137sig** — BIP-39 key ceremony (all key material stays node-side):
  `newEntropy({bits?})`, `mnemonic(entropy)→string`,
  `seed(phrase,{passphrase?})`, `deriveKey(seed,{path?})` (the three input ops
  stream one object + eos, read one reply).
- **apphost** (ops, `astral-js/api/apphost` — distinct from the client lib) —
  `register({name?, permits?, contractPermits?})→AccessTokenValue` (mint a
  guest identity + token; streams one `mod.apphost.register_request`),
  `grant(identity, permits, {durationMs?})` (streams one
  `mod.apphost.grant_request`, reads `ack`),
  `requestGrant(permits, {durationMs?})` (streams one
  `mod.apphost.request_grant_request`, reads `ack`; waits while a delegate
  decides), `listGrants(identity)→GrantValue[]` (`mod.apphost.grant`:
  `{ID, Permit, ExpiresAt}`, `ExpiresAt` `null` until revoked),
  `revoke(identity, {id} | {action})`. Refusals are `RemoteError`s whose
  messages are listed in `Refusals`. `discoveryPermit(services)` (at
  `api/services`) builds a scoped discovery permit.

Method names mirror the op strings (camelCase of the op's operation segment):
`user.new_node_contract`→`newNodeContract`, `dir.resolve`→`resolve`, etc. The three
above (user/auth/services) pass complex signed objects — `Contract`,
`Signature`, `SignedExpulsion`, `services.update` — through as `AstralObject`
(a `Permit` is typed as `PermitValue`, `{Action, Constraints, Delegation}`,
at `api/auth`; `Contract` and `Bundle` contents stay pass-through). They need
**live-node confirmation** of the
signing/exchange choreography before being treated as frozen.

## Deferred / caveats

- Deferred: native IPC (binary unix/tcp) transport, `objects.read` (raw
  unframed bytes — not representable over JSON), the advanced protocol ops
  (`dir.apply_filters`/`alias_map`, `tree.mount`,
  the `objects` write ops beyond `store`/blueprint
  registration, the `apphost` token-management ops).
- **Needs live-node confirmation** (flagged in the source JSDoc): `crypto.public_key`
  and `crypto.verify_text_signature` (the Go ops read a _streamed_ key/signature
  object, not the query arg — the astral-py query form is used here), and
  `objects.contains` (default-repository dependency), and the settings-app
  batch (`nearby`, `bip137sig`, `user.{info,adopt,swarm_status}`,
  `objects.store`, `apphost.register` — grounded in the spec + the astrald
  server ops, exercised only by the settings app's earlier hand-rolled
  client). Confirm against a running node before treating these as frozen.

## Spec (the `system` submodule = astral-docs)

- Transport / encoding: `system/topics/astral-ipc.md`, `ws-transport.md`,
  `json-encoding.md`, `op-modes.md`.
- Per-protocol: `system/protocols/<name>/` (apphost, dir, crypto, tree, objects, …).
- Pinned at a specific commit; update it deliberately via `git submodule update --remote`.

## Working on the SDK

- `npm run check` = typecheck + lint + test + build; every change must keep it green.
- Tests are deliberately basic: dependency-free unit tests for the astral-core
  primitives (`test/astral.test.ts` — envelope, identity, nonce, zone,
  query-string encoding, errors), and protocol client tests on a scripted
  transport (`test/helpers/recording-transport.ts`) that records the routed
  query and every streamed object and replays canned replies. Live-node
  behaviour is confirmed by exercising the clients against a running node.
- The published surface is validated by `npm run verify:pkg` (publint) plus a
  packed-tarball ESM/CJS/`.d.ts` consumer smoke.
