// apphost — the astrald apphost WebSocket client (mirrors Go lib/apphost).
//
// A typed TypeScript port of the reference client (reference/apphost-js.js):
// speaks `astral.json.v1` at `/.ws`. connect() -> a Host that opens a fresh
// WebSocket per operation; host.query(...) -> a Stream (async-iterable to eos);
// host.register(...) -> serve inbound queries. Built on a narrow Session/
// Transport seam so a future binary/IPC transport slots in without changes to
// the Host/Stream state machine or the protocol clients.
//
// The root `astral-js` entry re-exports this surface (connect, Host, Stream,
// errors). Populated by: dev/apphost-session, dev/apphost-query, dev/apphost-serve.
export {};
