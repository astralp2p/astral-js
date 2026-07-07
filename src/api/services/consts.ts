// api/services/consts — apphost op strings for the services protocol, one source of truth.

/** The `services.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  discover: 'services.discover',
} as const;

/** Wire type tag of a `services.discover` update object. */
export const UPDATE_TYPE = 'services.update';
