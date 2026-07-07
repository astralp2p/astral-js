// apphost — the astrald apphost WebSocket client (mirrors Go lib/apphost).
//
// A typed TypeScript port of the astrald apphost-js reference client: speaks
// `astral.json.v1` at `/.ws`. connect() -> a Host that opens a fresh WebSocket
// per operation; host.query(...) -> a Stream (async-iterable to eos);
// host.register(...) -> a Registration serving inbound queries (IncomingQuery
// accept/reject). Built on a narrow Session/Transport seam so a future
// binary/IPC transport slots in without changes to the Host/Stream state
// machine or the protocol clients.
//
// The root `astral-js` entry re-exports this surface (connect, Host, Stream,
// Registration, IncomingQuery).

export { connect, Host } from './host.js';
export type { QueryOptions } from './host.js';
export { Stream } from './stream.js';

export { Registration, IncomingQuery } from './serve.js';

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
