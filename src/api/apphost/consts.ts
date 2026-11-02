// api/apphost/consts — apphost op strings and wire type tags for the apphost protocol, one source of truth.

/** The `apphost.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  register: 'apphost.register',
  grant: 'apphost.grant',
  requestGrant: 'apphost.request_grant',
  listGrants: 'apphost.list_grants',
  revoke: 'apphost.revoke',
} as const;

/** Wire type tags of the apphost protocol objects. */
export const Types = {
  accessToken: 'apphost.access_token',
  grant: 'mod.apphost.grant',
  registerRequest: 'mod.apphost.register_request',
  grantRequest: 'mod.apphost.grant_request',
  requestGrantRequest: 'mod.apphost.request_grant_request',
} as const;

/**
 * The `error_message` texts of the apphost refusals, surfaced as the message of
 * a `RemoteError`. A message refusing an invalid permit starts with
 * `invalid permit: <action>:` and continues with the reason.
 */
export const Refusals = {
  registrationDeclined: 'registration declined',
  grantDeclined: 'grant declined',
  notPermitted: 'not permitted',
  invalidPermit: 'invalid permit',
} as const;
