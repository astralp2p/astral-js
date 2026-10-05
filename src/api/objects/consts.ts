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
  repositories: 'objects.repositories',
  search: 'objects.search',
  describe: 'objects.describe',
} as const;

/** Wire type tag of an `objects.repositories` repository descriptor. */
export const REPOSITORY_INFO_TYPE = 'mod.objects.repository_info';

/** Wire type tag of one `objects.search` match. */
export const SEARCH_RESULT_TYPE = 'mod.objects.search_result';

/** Wire type tag of one `objects.describe` descriptor. */
export const DESCRIBE_RESULT_TYPE = 'mod.objects.describe_result';
