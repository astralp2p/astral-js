// api/bip137sig/consts — apphost op strings for the bip137sig protocol, one source of truth.

/** The `bip137sig.*` operation names, sent as the op of an apphost query. */
export const Ops = {
  newEntropy: 'bip137sig.new_entropy',
  mnemonic: 'bip137sig.mnemonic',
  seed: 'bip137sig.seed',
  deriveKey: 'bip137sig.derive_key',
} as const;
