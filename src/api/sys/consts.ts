// api/sys/consts — sys op strings and wire type tags for the sys protocol, one source of truth.

/** The `sys.*` operation names, sent as the op of a sys query. */
export const Ops = {
  registerManager: 'sys.register_manager',
} as const;

/** Wire type tags of the sys protocol objects. */
export const Types = {
  registerManagerRequest: 'mod.sys.register_manager_request',
  policyBinding: 'mod.sys.policy_binding',
  /** The answer of `sys.register_manager`, an apphost type. */
  accessToken: 'apphost.access_token',
} as const;

/**
 * The `error_message` texts of the sys refusals, surfaced as the message of a
 * `RemoteError`.
 */
export const Refusals = {
  notFresh: 'node is not fresh',
} as const;

/**
 * The policy names a `mod.sys.policy_binding` takes. Each names the
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
