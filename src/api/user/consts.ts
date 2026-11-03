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

/** Wire type tag of the `user.info` reply. */
export const INFO_TYPE = 'mod.user.info';

/**
 * The node states `user.info` reports in `State`. `fresh`: no manager and no
 * active contract ever held; the node admits the appointment of a manager.
 * `unclaimed`: no active contract, and a manager is appointed or a contract was
 * held before. `claimed`: the node has an active contract.
 */
export const NodeStates = {
  fresh: 'fresh',
  unclaimed: 'unclaimed',
  claimed: 'claimed',
} as const;

/** One of the {@link NodeStates}. */
export type NodeState = (typeof NodeStates)[keyof typeof NodeStates];

/** Wire type tag of the `user.bootstrap` reply. */
export const BOOTSTRAP_RESULT_TYPE = 'mod.user.bootstrap_result';

/** Wire type tag of the `user.derive_identity` reply. */
export const DERIVE_IDENTITY_RESULT_TYPE = 'mod.user.derive_identity_result';
