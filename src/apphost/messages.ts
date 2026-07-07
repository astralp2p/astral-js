/**
 * The `mod.apphost.*` control-message payloads and their type tags.
 *
 * These interfaces describe the `Object` payload of each apphost control
 * message on the `astral.json.v1` wire. Field names are the Go-exported names
 * verbatim (they are the JSON keys), verified against
 * `mod/apphost/*_msg.go` in astrald. Fields typed as astral primitives reuse
 * the {@link Identity} / {@link Nonce} / {@link Zone} string types; Go
 * `*astral.Identity` pointer fields (which JSON-encode to `null` when unset)
 * map to `Identity | null`.
 *
 * The {@link MessageTypes} map holds the verbatim wire type strings — the
 * `Type` field of each {@link WireEnvelope} — including the bare `'ack'` /
 * `'eos'` sentinels.
 *
 * @module apphost/messages
 */

import type { Identity } from '../astral/identity.js';
import type { Nonce } from '../astral/nonce.js';
import type { Zone } from '../astral/zone.js';

/**
 * `mod.apphost.host_info_msg` — the first frame the host sends on every
 * connection, announcing its own identity and human alias.
 */
export interface HostInfoMsg {
  /** The host node's identity, or `null` if unset. */
  Identity: Identity | null;
  /** The host's human-readable alias. */
  Alias: string;
}

/** `mod.apphost.auth_token_msg` — the guest's access token, offered after host info. */
export interface AuthTokenMsg {
  /** The access token string. */
  Token: string;
}

/** `mod.apphost.auth_success_msg` — the host's acknowledgement of a valid token. */
export interface AuthSuccessMsg {
  /** The identity the host assigned to this authenticated guest, or `null`. */
  GuestID: Identity | null;
}

/** `mod.apphost.error_msg` — a control-plane failure carrying a string code. */
export interface ErrorMsg {
  /** The error code, e.g. `'auth_failed'`, `'route_not_found'`. */
  Code: string;
}

/** `mod.apphost.route_query_msg` — a request to route an outbound query. */
export interface RouteQueryMsg {
  /** A fresh nonce pairing this query with its response. */
  Nonce: Nonce;
  /** The caller identity, or `null` to let the host fill in its own. */
  Caller: Identity | null;
  /** The target identity, or `null`. */
  Target: Identity | null;
  /** The query string, e.g. `'user.info?name=alice'`. */
  Query: string;
  /** The reachability zone (e.g. `'dvn'`). */
  Zone: Zone;
  /** Optional routing filters, or `null`. */
  Filters: string[] | null;
}

/** `mod.apphost.query_accepted_msg` — the host accepted an outbound query (empty payload). */
export type QueryAcceptedMsg = Record<string, never>;

/** `mod.apphost.query_rejected_msg` — the host rejected an outbound query with a numeric code. */
export interface QueryRejectedMsg {
  /** The rejection code (0–255). */
  Code: number;
}

/** `mod.apphost.register_service_msg` — register this connection as a handler for an identity. */
export interface RegisterServiceMsg {
  /** The identity whose inbound queries this connection will handle, or `null`. */
  Identity: Identity | null;
}

/** `mod.apphost.incoming_query_msg` — the host announces an inbound query awaiting handling. */
export interface IncomingQueryMsg {
  /** The query's id (also the attach pairing token). */
  QueryID: Nonce;
  /** The caller identity, or `null`. */
  Caller: Identity | null;
  /** The target identity, or `null`. */
  Target: Identity | null;
  /** The full query string. */
  Query: string;
}

/** `mod.apphost.attach_query_msg` — attach a fresh per-query connection to an announced query. */
export interface AttachQueryMsg {
  /** The id of the pending inbound query to attach to. */
  QueryID: Nonce;
}

/** `mod.apphost.reject_incoming_msg` — decline an announced inbound query with a numeric code. */
export interface RejectIncomingMsg {
  /** The id of the pending inbound query to reject. */
  QueryID: Nonce;
  /** The rejection code (0–255). */
  Code: number;
}

/**
 * The verbatim wire type strings for apphost control messages and the bare
 * stream sentinels. These are the `Type` field of the {@link WireEnvelope}.
 */
export const MessageTypes = {
  HostInfo: 'mod.apphost.host_info_msg',
  AuthToken: 'mod.apphost.auth_token_msg',
  AuthSuccess: 'mod.apphost.auth_success_msg',
  Error: 'mod.apphost.error_msg',
  RouteQuery: 'mod.apphost.route_query_msg',
  QueryAccepted: 'mod.apphost.query_accepted_msg',
  QueryRejected: 'mod.apphost.query_rejected_msg',
  RegisterService: 'mod.apphost.register_service_msg',
  IncomingQuery: 'mod.apphost.incoming_query_msg',
  AttachQuery: 'mod.apphost.attach_query_msg',
  RejectIncoming: 'mod.apphost.reject_incoming_msg',
  Ack: 'ack',
  Eos: 'eos',
} as const;

/** Any of the {@link MessageTypes} wire type strings. */
export type MessageType = (typeof MessageTypes)[keyof typeof MessageTypes];
