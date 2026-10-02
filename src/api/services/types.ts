// api/services/types — the JSON values of the services protocol objects.

import type { Identity } from '../../astral/identity.js';

/**
 * One offering view: the JSON `value` of a `services.update`. Field names are
 * the Go struct's exported names (astral-go `api/services/update.go`).
 */
export interface ServiceUpdateValue {
  /** Whether the provider offers the service to this caller. */
  Available: boolean;
  /** The service name. */
  Name: string;
  /** The provider's identity; the node fills it from the binding. */
  ProviderID: Identity | null;
  /** The offering's info bundle: a JSON array of `{ Type, Object }` envelopes. */
  Info: unknown;
}

/** One offering's key: the JSON value of a `services.offering_key`. */
export interface OfferingKeyValue {
  ProviderID: Identity;
  Name: string;
}

/** The node asking a provider for one caller's offering: `services.ask`. */
export interface AskValue {
  /** Echoed verbatim in the answer. */
  RequestID: string;
  CallerID: Identity;
  Service: string;
}

/** How the initial attempt of a discovery ended. */
export interface InitialOutcome {
  /** True when every provider asked answered in time. */
  complete: boolean;
  /** Requested services whose initial evaluation did not resolve. */
  incomplete: string[];
}

/** One event of a discovery stream. */
export type DiscoveryEvent =
  | { kind: 'update'; update: ServiceUpdateValue }
  | { kind: 'removed'; offerings: OfferingKeyValue[] }
  | { kind: 'initial'; outcome: InitialOutcome };

/** The key {@link watch} and consumers use for an offering. */
export function offeringKey(o: { ProviderID: Identity | null; Name: string }): string {
  return `${o.ProviderID ?? ''}/${o.Name}`;
}
