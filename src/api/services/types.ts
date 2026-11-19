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

/**
 * Why the node removed offerings from a discovery, named as in
 * `services.removed.md`. `unknown` is a value the spec does not define; a
 * reconnecting `Watcher` also gives it to an offering a reopened follow
 * no longer shows.
 */
export type RemovalCause =
  'member_lost' | 'member_left' | 'member_removed' | 'binding_closed' | 'hidden' | 'unknown';

/** The `Cause` wire values of a `services.removed`, by name. */
export const RemovalCauses: Readonly<Record<number, RemovalCause>> = {
  1: 'member_lost',
  2: 'member_left',
  3: 'member_removed',
  4: 'binding_closed',
  5: 'hidden',
};

/** The JSON value of a `services.removed`. */
export interface RemovedValue {
  Offerings: OfferingKeyValue[] | null;
  /** A wire value of {@link RemovalCauses}. */
  Cause: number;
}

/**
 * One event of a discovery stream. `open` is set on an update of a tagged
 * stream: the provider's visibility. `not_granted` lists the requested
 * services the caller holds no discovery permit for, and comes first.
 */
export type DiscoveryEvent =
  | { kind: 'update'; update: ServiceUpdateValue; open?: boolean }
  | { kind: 'removed'; offerings: OfferingKeyValue[]; cause: RemovalCause }
  | { kind: 'not_granted'; services: string[] }
  | { kind: 'initial'; outcome: InitialOutcome };

/** The key {@link watch} and consumers use for an offering. */
export function offeringKey(o: { ProviderID: Identity | null; Name: string }): string {
  return `${o.ProviderID ?? ''}/${o.Name}`;
}
