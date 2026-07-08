// api/nearby/consts — apphost op strings for the nearby protocol, one source of truth.

/** The `nearby.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  broadcast: 'nearby.broadcast',
  list: 'nearby.list',
} as const;
