// api/user/consts — apphost op strings for the user protocol, one source of truth.

/** The `user.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  newNodeContract: 'user.new_node_contract',
  acceptMembership: 'user.accept_membership',
  expel: 'user.expel',
} as const;
