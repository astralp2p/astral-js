// api/auth/consts — apphost op strings for the auth protocol, one source of truth.

/** The `auth.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  signContract: 'auth.sign_contract',
  index: 'auth.index',
} as const;
