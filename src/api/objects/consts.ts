// api/objects/consts — apphost op strings for the objects protocol, one source of truth.

/** The `objects.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  probe: 'objects.probe',
  contains: 'objects.contains',
  find: 'objects.find',
  store: 'objects.store',
  scan: 'objects.scan',
  load: 'objects.load',
  registerBlueprint: 'objects.register_blueprint',
  getBlueprint: 'objects.get_blueprint',
} as const;
