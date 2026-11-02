// api/services/scope — a discovery permit scoped to named services.
//
// Mirrors astral-go api/services/service_discovery_action.go.

import type { Identity } from '../../astral/identity.js';
import type { PermitValue } from '../auth/types.js';
import { validateName } from './names.js';

/** The action a discovery permit authorizes. */
export const DISCOVERY_ACTION = 'mod.services.service_discovery_action';

/** Wire type tag of the constraint that scopes a discovery permit. */
export const DISCOVERY_SCOPE_TYPE = 'mod.services.discovery_scope';

/**
 * Build a discovery permit scoped to `services`: one `mod.services.discovery_scope`
 * with one rule. A discovery permit without a scope allows nothing, so the node
 * refuses one.
 *
 * @param services The services the permit allows discovering; at least one.
 * @param opts `nodes` limits the rule to providers contributed by these nodes;
 *   absent or empty allows every node.
 * @throws {TypeError} On an empty list or an invalid service name.
 */
export function discoveryPermit(
  services: string[],
  opts: { nodes?: Identity[] } = {},
): PermitValue {
  if (services.length === 0) throw new TypeError('no service names');
  for (const name of services) {
    try {
      validateName(name);
    } catch (err) {
      throw new TypeError((err as Error).message);
    }
  }
  return {
    Action: DISCOVERY_ACTION,
    Constraints: [
      {
        Type: DISCOVERY_SCOPE_TYPE,
        Object: { Rules: [{ Services: [...services], Nodes: [...(opts.nodes ?? [])] }] },
      },
    ],
    Delegation: 0,
  };
}
