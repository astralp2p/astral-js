// apphost — the astrald apphost WebSocket client (mirrors Go lib/apphost).
//
// A typed TypeScript port of the reference client (reference/apphost-js.js):
// speaks `astral.json.v1` at `/.ws`. connect() -> a Host that opens a fresh
// WebSocket per operation; host.query(...) -> a Stream (async-iterable to eos).
// Built on a narrow Session/Transport seam so a future binary/IPC transport
// slots in without changes to the Host/Stream state machine or the protocol
// clients. The inbound path (register/incoming queries) lands in a later phase.
//
// The root `astral-js` entry re-exports this surface (connect, Host, Stream).

export { connect, Host } from './host.js';
export type { QueryOptions } from './host.js';
export { Stream } from './stream.js';

export { JsonWsTransport, JsonWsSession } from './session.js';
export type { Session, Transport, HostInfo, OpenOptions } from './session.js';

export { MessageTypes } from './messages.js';
export type {
  MessageType,
  HostInfoMsg,
  AuthTokenMsg,
  AuthSuccessMsg,
  ErrorMsg,
  RouteQueryMsg,
  QueryAcceptedMsg,
  QueryRejectedMsg,
  RegisterServiceMsg,
  IncomingQueryMsg,
  AttachQueryMsg,
  RejectIncomingMsg,
} from './messages.js';
