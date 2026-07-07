// api/tree/consts — apphost op strings for the tree protocol, one source of truth.

/** The `tree.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  get: 'tree.get',
  set: 'tree.set',
  list: 'tree.list',
  delete: 'tree.delete',
} as const;
