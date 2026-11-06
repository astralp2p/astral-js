// api/sys/types — the JSON values of the sys protocol objects.
//
// Spec: .ai/system/protocols/sys/types/. Field names are the Go struct's
// exported names (astral-go api/sys).

import type { RegisterRequestValue } from '../apphost/types.js';

/**
 * One policy a manager decides: the JSON `value` of a
 * `mod.sys.policy_binding`, carried in a
 * {@link RegisterManagerRequestValue}.
 */
export interface PolicyBindingValue {
  /** The policy, one of the `Policies` names. */
  Policy: string;
  /** The op the node queries on the manager for each decision. */
  Operation: string;
  /** How long the node waits for one answer, in nanoseconds; `0` waits 10 minutes. */
  Timeout: number;
}

/**
 * The input of `sys.register_manager`: the JSON `value` of a
 * `mod.sys.register_manager_request`. `Name`, `GrantPermits` and
 * `ContractPermits` mean what they mean in a `mod.apphost.register_request`
 * ({@link RegisterRequestValue}).
 */
export interface RegisterManagerRequestValue extends RegisterRequestValue {
  /** The policies the manager decides, one binding each. */
  Policies: PolicyBindingValue[];
}
