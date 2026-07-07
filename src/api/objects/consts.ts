// api/objects/consts — apphost op strings for the objects protocol, one source of truth.

/** The `objects.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  probe: 'objects.probe',
  contains: 'objects.contains',
  getType: 'objects.get_type',
  find: 'objects.find',
} as const;
