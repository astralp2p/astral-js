/**
 * astral — the JSON-scoped wire primitives shared across the SDK.
 *
 * Pure, I/O-free building blocks for `astral.json.v1`: the {@link AstralObject}
 * value type and its `{ Type, Object }` envelope, the identity / object-id /
 * nonce / zone string types, numeric codes, the error hierarchy, and the
 * query-string encoder. Everything is JSON — there is no binary codec here.
 *
 * @module astral
 */

export type { AstralObject, WireEnvelope, ObjectTypeName } from './object.js';
export {
  ObjectTypes,
  wrap,
  unwrap,
  obj,
  ack,
  eos,
  error,
  EOS,
  ACK,
  EMPTY,
  isEos,
  isAck,
  isError,
  isEmpty,
  isUntyped,
} from './object.js';

export type { Identity } from './identity.js';
export {
  IDENTITY_HEX_LENGTH,
  ANYONE,
  ANYONE_KEY,
  Anyone,
  parseIdentity,
  isAnyone,
  fingerprint,
} from './identity.js';

export type { ObjectID } from './objectid.js';
export { OBJECT_ID_PREFIX, isObjectID, parseObjectID } from './objectid.js';

export type { Nonce } from './nonce.js';
export { NONCE_HEX_LENGTH, newNonce, parseNonce } from './nonce.js';

export type { Zone } from './zone.js';
export {
  ZoneDevice,
  ZoneVirtual,
  ZoneNetwork,
  ZoneDefault,
  ZoneAll,
  parseZone,
  formatZone,
} from './zone.js';

export {
  CodeSuccess,
  CodeRejected,
  CodeInvalidQuery,
  CodeCanceled,
  CodeInternalError,
  DefaultRejectCode,
} from './codes.js';

export {
  AstralError,
  ConnectError,
  AuthError,
  ProtocolError,
  QueryRejected,
  RouteNotFound,
  TargetNotAllowed,
  Denied,
  Canceled,
  Timeout,
  InternalError,
  RemoteError,
  EncodingError,
  ErrorCodes,
  queryErrorForCode,
  readErrorMessage,
} from './errors.js';

export type { QueryArgs } from './encoding.js';
export { MAX_QUERY_STRING, DEFAULT_ZONE, toText, buildQueryString } from './encoding.js';
