// api/dir/consts — apphost op strings for the dir protocol, one source of truth.

/** The `dir.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  resolve: 'dir.resolve',
  getAlias: 'dir.get_alias',
  setAlias: 'dir.set_alias',
} as const;
