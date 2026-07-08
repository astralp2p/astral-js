// api/user — the user protocol client (swarm membership, node contracts, expulsion).
// Built on the apphost WebSocket client's query. Client-side ops: newNodeContract,
// acceptMembership, expel; app-facing ops: info, adopt, swarmStatus. Populated
// by: dev/api-user, dev/api-settings-app.

/**
 * The `user` protocol client: the app-facing slice of a node's swarm-membership
 * ceremony — build an unsigned node contract, counter-sign a membership
 * contract, and expel a node from the swarm.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `user.*` operations
 * exactly as the reference node serves them. Grounded in both reference
 * implementations, cross-checked with the protocol spec:
 *   - Go client: `api/user/client/{new_node_contract,accept_membership,expel}.go`
 *     (method names + arg keys + channel flow).
 *   - Go object types: `api/user/{contract,expulsion}.go`, `api/auth/contract.go`,
 *     `api/crypto/signature.go` (the wire type tags below).
 *   - astrald server ops: `mod/user/src/op_{new_node_contract,accept_membership,
 *     expel}.go` (query-arg vs streamed-object flow, reject codes, live-node
 *     preconditions).
 *   - Spec: `astral-docs .../protocols/user/ops/user.{new_node_contract,
 *     accept_membership,expel}.md`.
 *
 * Six operations live here: the three CLIENT-driven ceremony ops
 * ({@link User.newNodeContract}, {@link User.acceptMembership},
 * {@link User.expel}) and the three app-facing status/management ops
 * ({@link User.info}, {@link User.adopt}, {@link User.swarmStatus}), grounded
 * in the protocol spec (`astral-docs .../protocols/user/ops/user.{info,adopt,
 * swarm_status}.md`) and the astrald server ops
 * (`mod/user/src/op_{info,adopt,swarm_status}.go`). The remaining `user.*` op
 * strings (`user.assets`, `user.request_membership`, `user.list_siblings`,
 * `user.list_expelled`, `user.sync_with`, `user.sync_assets`,
 * `user.add_asset`, `user.remove_asset`, `user.accept_contract`) are
 * server/handler-side or lack a client method in the reference SDK, and are
 * intentionally omitted.
 *
 * SIGNED OBJECTS travel as their `{ Type, Object }` JSON envelopes and are
 * carried here as pass-through {@link AstralObject}s — the SDK does not impose a
 * schema on `mod.auth.contract`, `mod.crypto.signature`, or
 * `mod.user.signed_expulsion` (their nested `Permit` / `Bundle` shapes are not
 * fully typed). The {@link Contract}, {@link Signature}, and
 * {@link SignedExpulsion} aliases below name the expected type for readability;
 * each is exactly an {@link AstralObject}.
 *
 * @module api/user
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { eos, isError } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

/**
 * An unsigned authorization contract (`mod.auth.contract`) as a pass-through
 * {@link AstralObject}. Its `value` carries the Go `Contract`'s JSON shape
 * (`Issuer` / `Subject` / `Permits` / `ExpiresAt`); the nested `Permit` /
 * `Bundle` fields are intentionally left untyped.
 */
export type Contract = AstralObject;

/**
 * A signature (`mod.crypto.signature`) as a pass-through {@link AstralObject}.
 * Its `value` is the compact `<scheme>:<base64>` text the Go `Signature`
 * marshals to.
 */
export type Signature = AstralObject;

/**
 * A signed swarm ban (`mod.user.signed_expulsion`) as a pass-through
 * {@link AstralObject}. Its `value` carries the Go `SignedExpulsion`'s JSON
 * shape (the embedded `Expulsion` body plus `IssuerSig`).
 */
export type SignedExpulsion = AstralObject;

/**
 * A signed authorization contract (`mod.auth.signed_contract`) as a
 * pass-through {@link AstralObject}. Its `value` carries the embedded
 * {@link Contract} body plus its signatures; the nested shapes are
 * intentionally left untyped.
 */
export type SignedContract = AstralObject;

/**
 * The JSON `value` of a `mod.user.info` {@link AstralObject}: the user this
 * node belongs to, as reported by `user.info`. `Contract` is the active
 * signed contract and passes through untyped.
 */
export interface UserInfoValue {
  /** The node's alias. */
  NodeAlias: string;
  /** The user's alias. */
  UserAlias: string;
  /** The active contract's object id (`data1…` string). */
  ContractID: string;
  /** The active signed contract — pass-through, shape not imposed. */
  Contract?: unknown;
}

/**
 * The JSON `value` of a swarm-member {@link AstralObject}, one per node
 * streamed by `user.swarm_status`.
 */
export interface SwarmMemberValue {
  /** The member node's identity (66-hex string). */
  Identity: Identity;
  /** The member node's alias. */
  Alias: string;
  /** Whether a link to the member is currently up. */
  Linked: boolean;
}

/**
 * A client for the node's `user` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const user = new User(host);
 *
 * // Build an unsigned node contract for a user, then run the signing ceremony.
 * const contract = await user.newNodeContract('alice');       // mod.auth.contract
 * const subjectSig = await user.acceptMembership(contract, issuerSig); // mod.crypto.signature
 *
 * // Ban a node from the swarm (requires an active contract + issuer rights).
 * const ban = await user.expel('phone');                  // mod.user.signed_expulsion
 * ```
 */
export class User {
  private readonly host: Host;

  /** Bind a `user` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Build an unsigned node-binding {@link Contract} that grants swarm membership
   * to the user identified by `alias`.
   *
   * Sends query `user.new_node_contract?user=<alias>` and decodes the node's
   * single result — a `mod.auth.contract` object — returned verbatim as an
   * {@link AstralObject}. The contract is neither signed nor stored by the node;
   * the caller drives the signing ceremony (see {@link User.acceptMembership}).
   *
   * WIRE — arguments in the query string; the result is a single object. Note
   * the Go client and the spec name the argument `user` (an alias or identity of
   * the issuer), NOT `alias`: an empty/omitted value defaults to the node's own
   * user, so passing the wrong key silently yields the default contract rather
   * than one for the intended user.
   *
   * The node also accepts optional `node` (subject, defaulting to the local
   * node) and `duration` (Go-style, defaulting to ~one year) args; only the
   * issuer `user` is exposed here, matching the reference client's `NewContract`.
   *
   * Rejects with a {@link RemoteError} if the node streams an `error_message`
   * (e.g. the issuer identity could not be resolved), and with a
   * {@link ProtocolError} if the node accepts the query but returns no object.
   *
   * @param alias The issuer user's alias or identity string.
   * @returns The unsigned `mod.auth.contract` {@link AstralObject}.
   */
  async newNodeContract(alias: string): Promise<Contract> {
    const objs = await this.host.call(Ops.newNodeContract, { args: { user: alias } });
    if (objs.length === 0) {
      throw new ProtocolError('user.new_node_contract returned no contract');
    }
    return objs[0]!;
  }

  /**
   * Counter-sign a membership `contract` as its subject and return the node's
   * subject {@link Signature}.
   *
   * This is a bidirectional op with no query arguments. It opens the query
   * `user.accept_membership`, *streams* the `contract` (`mod.auth.contract`)
   * followed by the issuer's `issuerSig` (`mod.crypto.signature`), sends `eos` to
   * end the input, then awaits the node's reply: a single `mod.crypto.signature`
   * — the node's subject countersignature — which is returned verbatim as an
   * {@link AstralObject}. Both inputs travel as streamed objects (not query
   * args), so their full type/value round-trips intact, following the same
   * send-then-read shape as `tree.set` (Go `Client.AcceptMembership`, server
   * `OpAcceptMembership`).
   *
   * LIVE-NODE CAVEAT. The node rejects the query outright (reject code `2`,
   * surfaced as a {@link QueryRejected} from {@link Host.query}) when it already
   * holds an ACTIVE contract — a node accepts membership only once. It also
   * streams an `error_message` (surfaced as a {@link RemoteError}) when contract
   * validation fails: the subject must equal the node's identity, the contract
   * must retain a minimum remaining validity, the invite policy must approve, and
   * the issuer signature must verify. A node that already holds the issuer's ban
   * on this subject self-refuses with `ErrExpelled`.
   *
   * Rejects with a {@link RemoteError} on a streamed `error_message`, and with a
   * {@link ProtocolError} if the node replies with something other than the
   * subject signature (or ends the stream without one).
   *
   * @param contract The membership contract to counter-sign (`mod.auth.contract`).
   * @param issuerSig The issuer's signature over that contract (`mod.crypto.signature`).
   * @returns The node's subject `mod.crypto.signature` {@link AstralObject}.
   */
  async acceptMembership(contract: Contract, issuerSig: Signature): Promise<Signature> {
    const stream = await this.host.query(Ops.acceptMembership);
    try {
      // Both inputs stream as objects, contract first then the issuer signature,
      // matching the server's two sequential Expect reads; eos ends the input.
      stream.send(contract);
      stream.send(issuerSig);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        // The first non-error object is the node's subject signature.
        return o;
      }
      // The node closed/ended the stream without sending the subject signature.
      throw new ProtocolError('user.accept_membership returned no subject signature');
    } finally {
      stream.close();
    }
  }

  /**
   * Permanently ban `nodeID` from the swarm and return the signed
   * {@link SignedExpulsion} (the ban).
   *
   * Sends query `user.expel?target=<nodeID>` and decodes the node's single
   * result — a `mod.user.signed_expulsion` object — returned verbatim as an
   * {@link AstralObject}. The ban is identity-level and irreversible.
   *
   * WIRE — the target is a query argument (the Go client sends
   * `query.Args{"target": nodeID}`), NOT a streamed object; the result is a
   * single object. Passing an {@link Identity} or its string form both fold to
   * the same `target=<id>` arg.
   *
   * LIVE-NODE CAVEAT. The node rejects the query (surfaced as a
   * {@link QueryRejected} from {@link Host.query}) when it has no active contract
   * (reject code `2`), when `target` cannot be resolved to an identity (code
   * `3`), or when the caller is not authorized for the expel action (code `4`) —
   * in the reference node only the active contract's issuer is. On resolution or
   * expulsion failure past the accept gate the node streams an `error_message`,
   * surfaced as a {@link RemoteError}; an accepted query that yields no object
   * rejects with a {@link ProtocolError}.
   *
   * @param nodeID The node to expel (an {@link Identity} or its string form).
   * @returns The `mod.user.signed_expulsion` {@link AstralObject}.
   */
  async expel(nodeID: Identity | string): Promise<SignedExpulsion> {
    const objs = await this.host.call(Ops.expel, { args: { target: nodeID } });
    if (objs.length === 0) {
      throw new ProtocolError('user.expel returned no signed expulsion');
    }
    return objs[0]!;
  }

  /**
   * Read the user this node belongs to.
   *
   * Sends `user.info` (no arguments) and returns the `value` of the node's
   * single `mod.user.info` result, shaped like {@link UserInfoValue}: the user
   * and node aliases plus the active contract and its id.
   *
   * The caller must be the user (the active contract's issuer) or another node
   * in the same local swarm. The node rejects the query (a {@link QueryRejected}
   * from {@link Host.query}) with code `2` when it has no active contract — the
   * "no user yet" probe result — and with code `4` when the caller is not
   * authorized for the info action (`op_info.go`); an accepted query that
   * yields no object rejects with a {@link ProtocolError}.
   *
   * @returns The {@link UserInfoValue} of the node's active user.
   */
  async info(): Promise<UserInfoValue> {
    const objs = await this.host.call(Ops.info);
    if (objs.length === 0) {
      throw new ProtocolError('user.info returned no info');
    }
    return objs[0]!.value as UserInfoValue;
  }

  /**
   * Issue a swarm membership contract for the node `target` and return the
   * signed result.
   *
   * Sends `user.adopt?target=<target>` and decodes the node's single result —
   * a `mod.auth.signed_contract` object — returned verbatim as an
   * {@link AstralObject}. After indexing, the node pushes the signed contract
   * to the local swarm asynchronously and schedules a sync task for the new
   * member; a resolved call means the contract is issued, not that the member
   * is already synced.
   *
   * REJECT CODES (from the server source, `op_adopt.go` — the op's spec doc
   * under-lists them): `2` — no active contract; `3` — `target` could not be
   * resolved to an identity; `4` — the caller is not authorized for the adopt
   * action (in the reference node only the active contract's issuer is). Each
   * surfaces as a {@link QueryRejected} from {@link Host.query}, matching
   * `user.expel`'s code meanings. On issuance, indexing, or storage failure
   * past the accept gate the node streams an `error_message`, surfaced as a
   * {@link RemoteError}; an accepted query that yields no object rejects with a
   * {@link ProtocolError}.
   *
   * @param target The node to adopt (an alias, an {@link Identity}, or its
   *   string form).
   * @returns The issued `mod.auth.signed_contract` {@link AstralObject}.
   */
  async adopt(target: Identity | string): Promise<SignedContract> {
    const objs = await this.host.call(Ops.adopt, { args: { target } });
    if (objs.length === 0) {
      throw new ProtocolError('user.adopt returned no signed contract');
    }
    return objs[0]!;
  }

  /**
   * List the nodes currently in the user's swarm.
   *
   * Sends `user.swarm_status` (no arguments); the node streams one
   * swarm-member object per node holding an active SwarmAccess contract from
   * the same user, terminated by `eos`. Each member's `value` is returned
   * shaped like {@link SwarmMemberValue} (`Identity` / `Alias` / `Linked`).
   *
   * WIRE — the member objects are tagged `mod.users.swarm_member` (plural
   * `users`, unlike every other `mod.user.*` tag — confirmed in the Go
   * `SwarmMember.ObjectType()`, `api/user/swarm_member.go`); the tag is not
   * inspected here, so either form passes through. The node rejects the query
   * (a {@link QueryRejected}) with code `2` when it has no active contract; an
   * encoding failure streams an `error_message`, surfaced as a
   * {@link RemoteError} by {@link Host.call}.
   *
   * @returns One {@link SwarmMemberValue} per swarm member.
   */
  async swarmStatus(): Promise<SwarmMemberValue[]> {
    const objs = await this.host.call(Ops.swarmStatus);
    return objs.map((o) => o.value as SwarmMemberValue);
  }
}
