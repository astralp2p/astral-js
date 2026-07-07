# CLAUDE.md

AI context for this repository lives in **[`.ai/README.md`](./.ai/README.md)** —
read it first. The authoritative protocol specification is the **`.ai/system`**
submodule ([astral-docs](https://github.com/cryptopunkscc/astral-docs)); the
transport/encoding truth is `.ai/system/topics/` (`astral-ipc.md`,
`ws-transport.md`, `json-encoding.md`) and the per-protocol specs are
`.ai/system/protocols/<name>/`.

## What this is

`astral-js` is a browser JavaScript client (with TypeScript typings) for astrald
over the apphost WebSocket, speaking `astral.json.v1`. It is authored in
TypeScript under `src/` and shipped as dual ESM+CJS with bundled `.d.ts`.

- `src/astral/` — pure, I/O-free wire primitives (the `{ type, value }`
  `AstralObject` and its `{ Type, Object }` JSON envelope, Identity / ObjectID /
  Nonce / Zone as JSON string forms, errors, the query-string encoder).
- `src/apphost/` — the WebSocket client (`connect` → `Host`; `Host.query` →
  `Stream`; `Host.register` → `Registration` / `IncomingQuery`) on a narrow
  `Session` / `Transport` seam.
- `src/api/<p>/` — one thin client per protocol (`dir`, `crypto`, `tree`,
  `objects`) built on `Host.query` / `Host.call`.

## Authority

1. User instruction
2. Code / tests in this repo
3. `.ai/system/` (the protocol spec)
4. `.ai/README.md`

Call out conflicts rather than guessing.
