// api/services/consts — apphost op strings and wire type tags for the services protocol.

/** The `services.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  advertise: 'services.advertise',
  discover: 'services.discover',
} as const;

/** Wire type tags of the services protocol objects. */
export const Types = {
  update: 'services.update',
  ask: 'services.ask',
  answer: 'services.answer',
  change: 'services.change',
  incomplete: 'services.incomplete',
  removed: 'services.removed',
} as const;

/** Wire type tag of a `services.update` object. */
export const UPDATE_TYPE = Types.update;

/** The most services one advertise or discover call names. */
export const MAX_NAMES = 64;
