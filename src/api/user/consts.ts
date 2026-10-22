// api/user/consts — apphost op strings for the user protocol, one source of truth.

/** The `user.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  newNodeContract: 'user.new_node_contract',
  acceptMembership: 'user.accept_membership',
  acceptContract: 'user.accept_contract',
  expel: 'user.expel',
  info: 'user.info',
  adopt: 'user.adopt',
  swarmStatus: 'user.swarm_status',
  bootstrap: 'user.bootstrap',
  deriveIdentity: 'user.derive_identity',
  join: 'user.join',
} as const;

/** Wire type tag of the `user.bootstrap` reply. */
export const BOOTSTRAP_RESULT_TYPE = 'mod.user.bootstrap_result';

/** Wire type tag of the `user.derive_identity` reply. */
export const DERIVE_IDENTITY_RESULT_TYPE = 'mod.user.derive_identity_result';
