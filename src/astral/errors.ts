/**
 * The error hierarchy raised by the SDK, and the mapping from apphost error
 * codes to error classes.
 *
 * `astral.json.v1` reports failures two ways: a control `error_msg` carrying a
 * string `Code` (mapped by {@link queryErrorForCode}), and a `query_rejected`
 * carrying a numeric code (surfaced as {@link QueryRejected}). A responder can
 * also stream an `error_message` object (read with {@link readErrorMessage}).
 *
 * @module astral/errors
 */

import type { AstralObject } from './object.js';
import { isError } from './object.js';

/** Base class for every error this SDK throws. */
export class AstralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The connection could not be established or dropped unexpectedly. */
export class ConnectError extends AstralError {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Authentication with the host failed (bad or missing token). */
export class AuthError extends AstralError {
  readonly code?: string;
  constructor(code?: string) {
    super(`authentication failed${code ? `: ${code}` : ''}`);
    this.code = code;
  }
}

/** The peer spoke the protocol incorrectly (unexpected/malformed message). */
export class ProtocolError extends AstralError {}

/** The host rejected an outbound query with a numeric code. */
export class QueryRejected extends AstralError {
  readonly code: number;
  constructor(code: number, message?: string) {
    super(message ?? `query rejected (code ${code})`);
    this.code = code;
  }
}

/** No handler is registered for the queried route. */
export class RouteNotFound extends AstralError {
  constructor(message = 'route not found') {
    super(message);
  }
}

/** The target identity is not permitted for this query. */
export class TargetNotAllowed extends AstralError {}
/** The query was denied by policy. */
export class Denied extends AstralError {}
/** The query was canceled. */
export class Canceled extends AstralError {}
/** The operation timed out. */
export class Timeout extends AstralError {}
/** The host reported an internal error. */
export class InternalError extends AstralError {}
/** A responder streamed an `error_message` object as its result. */
export class RemoteError extends AstralError {}

/** A value could not be encoded for the wire (e.g. an over-long query string). */
export class EncodingError extends AstralError {}

/** The apphost `error_msg` string codes. */
export const ErrorCodes = {
  AuthFailed: 'auth_failed',
  Denied: 'denied',
  RouteNotFound: 'route_not_found',
  TargetNotAllowed: 'target_not_allowed',
  Canceled: 'canceled',
  Timeout: 'timeout',
  ProtocolError: 'protocol_error',
  InternalError: 'internal_error',
} as const;

/** Map an apphost `error_msg` string code to the corresponding error instance. */
export function queryErrorForCode(code: string): AstralError {
  switch (code) {
    case ErrorCodes.AuthFailed:
      return new AuthError(code);
    case ErrorCodes.RouteNotFound:
      return new RouteNotFound();
    case ErrorCodes.TargetNotAllowed:
      return new TargetNotAllowed(code);
    case ErrorCodes.Denied:
      return new Denied(code);
    case ErrorCodes.Canceled:
      return new Canceled(code);
    case ErrorCodes.Timeout:
      return new Timeout(code);
    case ErrorCodes.InternalError:
      return new InternalError(code);
    case ErrorCodes.ProtocolError:
      return new ProtocolError(code);
    default:
      return new ProtocolError(`unknown error code: ${code}`);
  }
}

/** Read the message from a wire `error_message` object, or `undefined` otherwise. */
export function readErrorMessage(o: AstralObject): string | undefined {
  if (!isError(o)) return undefined;
  return typeof o.value === 'string' ? o.value : String(o.value ?? '');
}
