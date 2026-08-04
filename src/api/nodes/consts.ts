// api/nodes/consts — apphost op strings for the nodes protocol, one source of truth.

/** The `nodes.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  links: 'nodes.links',
  resolveEndpoints: 'nodes.resolve_endpoints',
  newLink: 'nodes.new_link',
} as const;
