// api/user — the user protocol client (swarm membership, node contracts, expulsion).
// Built on the apphost WebSocket client's query. Client-side ops: newNodeContract,
// acceptMembership, acceptContract, expel; app-facing ops: info, adopt, swarmStatus;
// setup ops: deriveIdentity, bootstrap, join. Populated by: dev/api-user,
// dev/api-settings-app, dev/user-accept-contract, dev/user-bootstrap,
// dev/confine-token-less-sessions.

/**
 * The `user` protocol client: the app-facing slice of a node's swarm-membership
 * ceremony — build an unsigned node contract, counter-sign a membership
 * contract, and expel a node from the swarm.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `user.*` operations
 * exactly as the reference node serves them. Grounded in both reference
 * implementations, cross-checked with the protocol spec:
 *   - Go client: `api/user/client/{new_node_contract,accept_membership,accept_contract,expel}.go`
 *     (method names + arg keys + channel flow).
 *   - Go object types: `api/user/{contract,expulsion}.go`, `api/auth/contract.go`,
 *     `api/crypto/signature.go` (the wire type tags below).
 *   - astrald server ops: `mod/user/src/op_{new_node_contract,accept_membership,
 *     accept_contract,expel}.go` (query-arg vs streamed-object flow, reject
 *     codes, live-node preconditions).
 *   - Spec: `astral-docs .../protocols/user/ops/user.{new_node_contract,
 *     accept_membership,expel}.md`.
 *
 * Ten operations live here: the four CLIENT-driven ceremony ops
 * ({@link User.newNodeContract}, {@link User.acceptMembership},
 * {@link User.acceptContract}, {@link User.expel}), the three app-facing
 * status/management ops ({@link User.info}, {@link User.adopt},
 * {@link User.swarmStatus}), and the three setup ops of an unclaimed node
 * ({@link User.deriveIdentity}, {@link User.bootstrap}, {@link User.join}),
 * grounded in the protocol spec
 * (`astral-docs .../protocols/user/ops/user.{info,adopt,swarm_status,derive_identity,bootstrap,join}.md`,
 * `.../protocols/user/types/mod.user.{derive_identity_result,bootstrap_result}.md`),
 * the astrald server ops
 * (`mod/user/src/op_{info,adopt,swarm_status,derive_identity,bootstrap,join}.go`),
 * and the Go client (`api/user/client/{derive_identity,bootstrap,join}.go`,
 * `api/user/{derive_identity_result,bootstrap_result}.go`). The
 * remaining `user.*` op strings (`user.assets`, `user.request_membership`,
 * `user.list_siblings`, `user.list_expelled`, `user.sync_with`,
 * `user.sync_assets`, `user.add_asset`, `user.remove_asset`) are
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
import { Ops, BOOTSTRAP_RESULT_TYPE, DERIVE_IDENTITY_RESULT_TYPE } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { ObjectTypes, eos, isAck, isError } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';
import { parseIdentity } from '../../astral/identity.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

export { BOOTSTRAP_RESULT_TYPE, DERIVE_IDENTITY_RESULT_TYPE } from './consts.js';

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
 * The JSON `value` of a `mod.user.bootstrap_result` {@link AstralObject}: the
 * reply of `user.bootstrap`. Field names are the Go struct's exported names
 * (astral-docs `protocols/user/types/mod.user.bootstrap_result.md`).
 */
export interface BootstrapResultValue {
  /** The user that now owns the node: the issuer of its active contract. */
  Identity: Identity;
  /**
   * The BIP-39 words the node generated, separated by single spaces. Empty when
   * the caller sent the words.
   */
  Mnemonic: string;
  /**
   * An apphost access token issued for the user, valid for 365 days. A session
   * that connects with it acts as the user. Empty when the node sent none.
   */
  Token: string;
}

/**
 * The JSON `value` of a `mod.user.derive_identity_result` {@link AstralObject}:
 * the reply of `user.derive_identity`. Field names are the Go struct's exported
 * names (astral-docs `protocols/user/types/mod.user.derive_identity_result.md`).
 */
export interface DeriveIdentityResultValue {
  /**
   * The user the words derive along `m/1791'/0'/0'/0/0`: the user
   * `user.bootstrap` claims the node for with the same words and passphrase.
   */
  Identity: Identity;
  /**
   * The BIP-39 words the node generated, separated by single spaces. Empty when
   * the caller sent the words.
   */
  Mnemonic: string;
}

/** Options for {@link User.bootstrap} and {@link User.deriveIdentity}. */
export interface BootstrapOptions {
  /** The BIP-39 passphrase of the seed. The seed has no passphrase when omitted or empty. */
  passphrase?: string;
}

/** Options for {@link User.deriveIdentity}: the options of {@link User.bootstrap}. */
export type DeriveIdentityOptions = BootstrapOptions;

/** Read an optional string field of a reply value; absent or `null` reads as empty. */
function optionalString(type: string, v: Record<string, unknown>, field: string): string {
  const s = v[field];
  if (s === undefined || s === null) return '';
  if (typeof s !== 'string') throw new ProtocolError(`${type}: ${field} is not a string`);
  return s;
}

/**
 * Parse a reply of `op` that must be an object of `type` carrying `Identity`
 * and `Mnemonic`, rejecting any other shape with a {@link ProtocolError}.
 * Returns the parsed identity and words plus the raw value for further fields.
 */
function parseWordsResult(
  op: string,
  type: string,
  o: AstralObject,
): { Identity: Identity; Mnemonic: string; value: Record<string, unknown> } {
  if (o.type !== type) {
    throw new ProtocolError(`${op}: unexpected object type ${JSON.stringify(o.type)}`);
  }
  const v = o.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ProtocolError(`${o.type}: value is not an object`);
  }
  const value = v as Record<string, unknown>;
  const mnemonic = optionalString(o.type, value, 'Mnemonic');
  try {
    return { Identity: parseIdentity(value.Identity as string), Mnemonic: mnemonic, value };
  } catch (err) {
    throw new ProtocolError(`${o.type}: ${(err as Error).message}`);
  }
}

/** Parse the `user.bootstrap` reply, rejecting any other shape with a {@link ProtocolError}. */
function parseBootstrapResult(o: AstralObject): BootstrapResultValue {
  const {
    Identity: id,
    Mnemonic: mnemonic,
    value,
  } = parseWordsResult(Ops.bootstrap, BOOTSTRAP_RESULT_TYPE, o);
  return { Identity: id, Mnemonic: mnemonic, Token: optionalString(o.type, value, 'Token') };
}

/** Parse the `user.derive_identity` reply, rejecting any other shape with a {@link ProtocolError}. */
function parseDeriveIdentityResult(o: AstralObject): DeriveIdentityResultValue {
  const { Identity: id, Mnemonic: mnemonic } = parseWordsResult(
    Ops.deriveIdentity,
    DERIVE_IDENTITY_RESULT_TYPE,
    o,
  );
  return { Identity: id, Mnemonic: mnemonic };
}

/**
 * Run an op that takes BIP-39 words the way `user.bootstrap` and
 * `user.derive_identity` do, and parse its single reply with `parse`.
 *
 * Omitted `words` sends `generate=true` and streams nothing; given `words`
 * stream as one `string16` followed by `eos`. Empty or blank `words` throw a
 * `TypeError` before any query is sent. `passphrase` travels as the
 * `passphrase` query argument, omitted when empty.
 */
async function wordsOp<T>(
  host: Host,
  op: string,
  words: string | undefined,
  opts: BootstrapOptions,
  parse: (o: AstralObject) => T,
): Promise<T> {
  // why: an empty form field must not reach the node as words the caller
  // never sees; generating is asked for by omitting the words.
  if (words !== undefined && words.trim() === '') {
    throw new TypeError(`${op}: words are empty; omit them to generate new words`);
  }
  const generate = words === undefined;
  const stream = await host.query(op, {
    args: {
      generate: generate ? true : undefined,
      passphrase: opts.passphrase || undefined,
    },
  });
  try {
    if (!generate) {
      // why: a query string is logged, the stream is not.
      stream.send({ type: ObjectTypes.String16, value: words });
      stream.send(eos());
    }

    for await (const o of stream) {
      if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
      return parse(o);
    }
    // The node closed/ended the stream without a result.
    throw new ProtocolError(`${op} returned no result`);
  } finally {
    stream.close();
  }
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
   * Activate a fully-signed node contract as this node's active contract.
   *
   * The local-setup / cold-card counterpart of {@link User.acceptMembership}:
   * instead of running the signing ceremony, the caller supplies a `signed`
   * contract already signed by BOTH the issuer and the subject, and the node
   * validates, stores, and activates it. This is the setup-time replacement for
   * a raw `tree.set` of the active-contract path (now a protected op); the node
   * carries `user.accept_contract` on its pre-user setup allowlist so an
   * anonymous web guest can complete first-time setup with it.
   *
   * WIRE — a bidirectional op with no query arguments, following the same
   * send-then-ack shape as `tree.set`: it opens `user.accept_contract`,
   * *streams* the `signed` contract (`mod.auth.signed_contract`), sends `eos` to
   * end the input, then awaits the node's single `ack`. Resolves once the node
   * has acknowledged activation (Go `Client.AcceptContract`, server
   * `OpAcceptContract`).
   *
   * LIVE-NODE CAVEAT. The node rejects the query outright (reject code `2`,
   * surfaced as a {@link QueryRejected} from {@link Host.query}) when it ALREADY
   * holds an active contract — claiming a node is a one-time transition. It also
   * streams an `error_message` (surfaced as a {@link RemoteError}) when contract
   * validation fails: the signatures must verify, the subject must equal the
   * node, the contract must not be expired, and it must grant swarm membership.
   *
   * Rejects with a {@link RemoteError} on a streamed `error_message`, and with a
   * {@link ProtocolError} if the node ends the stream without acknowledging.
   *
   * @param signed The fully-signed node contract to activate
   *   (`mod.auth.signed_contract`).
   */
  async acceptContract(signed: SignedContract): Promise<void> {
    const stream = await this.host.query(Ops.acceptContract);
    try {
      // The signed contract streams on the body (like tree.set's value); eos
      // ends the input, then the node replies with a single ack.
      stream.send(signed);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (isAck(o)) return;
        throw new ProtocolError(`user.accept_contract expected an ack, got ${o.type}`);
      }
      // The node closed/ended the stream without acking.
      throw new ProtocolError('user.accept_contract was not acknowledged');
    } finally {
      stream.close();
    }
  }

  /**
   * Permanently ban `nodeID` from the swarm and return the signed
   * {@link SignedExpulsion} (the ban).
   *
   * Sends query `user.expel?identity=<nodeID>` and decodes the node's single
   * result — a `mod.user.signed_expulsion` object — returned verbatim as an
   * {@link AstralObject}. The ban is identity-level and irreversible.
   *
   * WIRE — the node to expel is the `identity` query argument (the server op
   * reads `Identity`, `op_expel.go`), NOT a streamed object; the result is a
   * single object. Passing an {@link Identity} or its string form both fold to
   * the same `identity=<id>` arg.
   *
   * LIVE-NODE CAVEAT. The node rejects the query (surfaced as a
   * {@link QueryRejected} from {@link Host.query}) when it has no active contract
   * (reject code `2`), when `nodeID` cannot be resolved to an identity (code
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
    const objs = await this.host.call(Ops.expel, { args: { identity: nodeID } });
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
   * Sends `user.adopt?identity=<target>` and decodes the node's single result —
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
    const objs = await this.host.call(Ops.adopt, { args: { identity: target } });
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

  /**
   * Return the user that BIP-39 `words` derive, without claiming the node.
   *
   * The node derives the user's key from the words along `m/1791'/0'/0'/0/0`
   * with the derivation of {@link User.bootstrap}, so the same words and
   * passphrase give the identity `user.bootstrap` claims the node for. The node
   * stores nothing, signs nothing and changes no state. The reply is a
   * `mod.user.derive_identity_result`, returned as its
   * {@link DeriveIdentityResultValue}. Omitted `words` asks the node to
   * generate 24 words; the reply's `Mnemonic` then carries them and the node
   * keeps no copy. With `words` given, `Mnemonic` is empty. Empty or blank
   * `words` throw a `TypeError` before any query is sent.
   *
   * A client that sets up a node for a new user calls this without `words`,
   * shows the words and the identity, and sends the same words to
   * {@link User.bootstrap} once the user has recorded them. A client that
   * restores a user sends the user's words and shows the identity before the
   * claim.
   *
   * WIRE — as {@link User.bootstrap}: `words` travel in the stream as one
   * `string16` followed by `eos`, never in the query string; without `words`
   * the query carries `generate=true` and the stream carries nothing;
   * `passphrase` travels as the `passphrase` query argument, omitted when
   * empty. (Go `Client.DeriveIdentity`, server `OpDeriveIdentity`.)
   *
   * LIVE-NODE CAVEAT. The node rejects the query (a {@link QueryRejected} from
   * {@link Host.query}) without a code when its origin is not local. The
   * node's apphost admits `user.derive_identity` from a session without a
   * token only while the node is unclaimed, and from a web session without a
   * token only when its origin is a trusted web source; otherwise the session
   * gets a wire `denied` (a {@link Denied} from {@link Host.query}). Past the
   * accept gate the node streams an `error_message`, surfaced as a
   * {@link RemoteError}, when the words are not valid BIP-39 words, when the
   * node runs without the `bip137sig` module, or when word generation fails.
   * A reply other than a `mod.user.derive_identity_result`, or none, rejects
   * with a {@link ProtocolError}.
   *
   * @param words The BIP-39 words, separated by whitespace; the node generates
   *   24 words when omitted.
   * @param opts.passphrase The BIP-39 passphrase of the seed.
   * @returns The {@link DeriveIdentityResultValue}: the user's identity and,
   *   when the node generated them, the words.
   */
  async deriveIdentity(
    words?: string,
    opts: DeriveIdentityOptions = {},
  ): Promise<DeriveIdentityResultValue> {
    return wordsOp(this.host, Ops.deriveIdentity, words, opts, parseDeriveIdentityResult);
  }

  /**
   * Claim this unclaimed node for the user that BIP-39 `words` derive, in one
   * call, and return that user with an access token for it.
   *
   * The node derives the user's key from the words along `m/1791'/0'/0'/0/0`,
   * signs the claim contract as the user and as itself, stores the user's key,
   * activates the contract, and issues an apphost access token for the user.
   * The reply is a `mod.user.bootstrap_result`, returned as its
   * {@link BootstrapResultValue}. Omitted `words` asks the node to generate 24
   * words; the reply's `Mnemonic` then carries them and is the only copy
   * anywhere. With `words` given, `Mnemonic` is empty. Empty or blank `words`
   * throw a `TypeError` before any query is sent. A client that confirms the
   * user's backup before the claim draws the words with
   * {@link User.deriveIdentity} and sends them here.
   *
   * WIRE — `words` travel in the stream as one `string16` followed by `eos`,
   * never in the query string: a query string is logged, the stream is not.
   * Without `words` the query carries `generate=true` and the stream carries
   * nothing. `passphrase` travels as the `passphrase` query argument, a name
   * the node redacts in its logs; it is omitted when empty. (Go
   * `Client.Bootstrap`, server `OpBootstrap`.)
   *
   * LIVE-NODE CAVEAT. The node rejects the query (a {@link QueryRejected} from
   * {@link Host.query}) without a code when its origin is not local, with code
   * `2` when the node already has an active contract, and with code `4` when
   * the caller is not the node itself. A caller with no identity counts as the
   * node: a session without a token has none, and the node's apphost admits
   * `user.bootstrap` for such sessions only while the node is unclaimed, and
   * from a web session only when its origin is a trusted web source. On a
   * claimed node a session without a token gets a wire `denied` (a
   * {@link Denied} from {@link Host.query}) instead of code `2`. Past the
   * accept gate the node streams an `error_message`, surfaced as a
   * {@link RemoteError}, when the words are not valid BIP-39 words, when the
   * claim rule of `auth.sign_contract` refuses the user, when the node runs
   * without the `bip137sig` module, when signing or storage fails, or when the
   * access token cannot be issued (the node is then claimed). A reply other
   * than a `mod.user.bootstrap_result`, or none, rejects with a
   * {@link ProtocolError}.
   *
   * @param words The BIP-39 words, separated by whitespace; the node generates
   *   24 words when omitted.
   * @param opts.passphrase The BIP-39 passphrase of the seed.
   * @returns The {@link BootstrapResultValue}: the user's identity, the user's
   *   access token and, when the node generated them, the words.
   */
  async bootstrap(words?: string, opts: BootstrapOptions = {}): Promise<BootstrapResultValue> {
    return wordsOp(this.host, Ops.bootstrap, words, opts, parseBootstrapResult);
  }

  /**
   * Make this unclaimed node request membership from `node`, a node of a
   * swarm, and return the membership contract this node now holds as its
   * active contract.
   *
   * Sends `user.join?node=<node>`. The node sends `user.request_membership` to
   * `node` as itself; the swarm node's join policy decides the request and, on
   * admission, sends a contract signed by its user to this node's
   * `user.accept_membership`, which this node's invite policy decides. The
   * reply is the signed contract — a `mod.auth.signed_contract` object —
   * returned verbatim as an {@link AstralObject}. (Go `Client.Join`, server
   * `OpJoin`.)
   *
   * REJECT CODES (each a {@link QueryRejected} from {@link Host.query}): none
   * when the origin is not local; `2` — the node already has an active
   * contract; `4` — the caller is not the node itself (a caller with no
   * identity counts as the node); `3` — `node` does not resolve, resolves to
   * the anonymous identity, or names this node. The node's apphost admits
   * `user.join` from a session without a token only while the node is
   * unclaimed, and from a web session only when its origin is a trusted web
   * source; otherwise the session gets a wire `denied` (a {@link Denied}).
   * Past the accept gate the node streams an `error_message`, surfaced as a
   * {@link RemoteError}: `request declined` (the swarm node's join policy),
   * `invitation declined` (this node's invite policy), `query rejected (2)`
   * (the swarm node has no active contract), or another message when the swarm
   * node cannot be reached or issuing, signing or storing fails. An accepted
   * query that yields no object rejects with a {@link ProtocolError}.
   *
   * @param node The swarm node to join: an alias, an {@link Identity}, or its
   *   string form.
   * @returns The `mod.auth.signed_contract` {@link AstralObject}.
   */
  async join(node: Identity | string): Promise<SignedContract> {
    const objs = await this.host.call(Ops.join, { args: { node } });
    if (objs.length === 0) {
      throw new ProtocolError('user.join returned no signed contract');
    }
    return objs[0]!;
  }
}
