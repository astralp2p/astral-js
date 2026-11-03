// api/apphost/consts — apphost op strings and wire type tags for the apphost protocol, one source of truth.

/** The `apphost.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  register: 'apphost.register',
  registerManager: 'apphost.register_manager',
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
  registerManagerRequest: 'mod.apphost.register_manager_request',
  policyBinding: 'mod.apphost.policy_binding',
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
  notFresh: 'node is not fresh',
} as const;

/**
 * The policy names a `mod.apphost.policy_binding` takes. Each names the
 * admission policy of one op: `app_register` and `grant_request` decide
 * `apphost.register` and `apphost.request_grant`; `swarm_join`,
 * `swarm_invite` and `contract_accept` decide `user.request_membership`,
 * `user.accept_membership` and `user.accept_contract`.
 */
export const Policies = {
  appRegister: 'app_register',
  grantRequest: 'grant_request',
  swarmJoin: 'swarm_join',
  swarmInvite: 'swarm_invite',
  contractAccept: 'contract_accept',
} as const;

/** One of the {@link Policies} names. */
export type PolicyName = (typeof Policies)[keyof typeof Policies];
