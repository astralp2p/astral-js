// api/auth — the auth protocol client (permission contracts: sign, index).
// Built on the apphost WebSocket client's query. Basic ops: signContract,
// index. Populated by: dev/api-auth.

/**
 * The `auth` protocol client: sign authorization contracts and index a signed
 * contract into the node's auth store.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `auth.*` operations
 * exactly as the reference node serves them. Grounded in both implementations:
 *   - Go client: `api/auth/client/{sign_contract,index_contract}.go`, method
 *     name constants from `api/auth/module.go` (`MethodSignContract` =
 *     `auth.sign_contract`, `MethodIndex` = `auth.index`).
 *   - Go node ops: `mod/auth/src/op_{sign_contract,index}.go` (the wire flow).
 *
 * The two ops differ in how their arguments reach the node, so they use
 * different transport shapes:
 *
 *   - {@link Auth.signContract} — query `auth.sign_contract` with NO args, then
 *     *stream* the {@link Contract} object followed by `eos`, and read back the
 *     single `mod.auth.signed_contract` reply. This is a bidirectional op like
 *     `tree.set`: the contract travels as a streamed object (not a query arg) so
 *     its full nested shape round-trips intact (Go `Client.SignContract` sends
 *     the contract after the channel is established; node `OpSignContract` reads
 *     a `Contract`, signs it, and sends the `SignedContract` back).
 *   - {@link Auth.index} — query `auth.index` with `{ id }` folded into
 *     the query string, and await the node's single `ack` (resolving `void`).
 *     The object id is a query argument, not a streamed object (Go
 *     `Client.IndexContract` passes `query.Args{"id": objectID}`; node `OpIndex`
 *     reads the arg, loads the signed contract by id, indexes it, and acks).
 *
 * Complex signed objects (the {@link Contract} and {@link SignedContract}) are
 * passed through as friendly {@link AstralObject}s: the SDK does not impose a
 * schema on `Permit` / `Bundle` (those serialize as nested `{ Type, Object }`
 * envelopes per the Go `MarshalJSON`), so the caller supplies and reads the
 * object `value` directly. The type aliases below document the JSON shape that
 * is obvious from the Go types, but they remain structurally `AstralObject`.
 *
 * Only these BASIC ops live here. The node's contract-query / verify /
 * authorize surface is not exposed through this client.
 *
 * @module api/auth
 */

import type { Host } from '../../apphost/host.js';
import type { AstralObject } from '../../astral/object.js';
import { eos, isError, isAck } from '../../astral/object.js';
import type { ObjectID } from '../../astral/objectid.js';
import { parseObjectID } from '../../astral/objectid.js';
import { RemoteError, ProtocolError, readErrorMessage } from '../../astral/errors.js';

/**
 * The unsigned body of an authorization grant, sent to {@link Auth.signContract}.
 *
 * Structurally an {@link AstralObject}: `type` is `'mod.auth.contract'` and
 * `value` is the JSON object the Go `auth.Contract` marshals to — `Issuer` /
 * `Subject` (identity envelopes), `Permits` (a list of `mod.auth.permit`
 * envelopes), and `ExpiresAt` (a time envelope). The SDK does NOT type the
 * nested `Permit` / `Bundle` shapes; the caller builds and reads `value`
 * directly (Go `api/auth/contract.go`).
 */
export type Contract = AstralObject;

/**
 * The signed form of a {@link Contract}, returned by {@link Auth.signContract}.
 *
 * Structurally an {@link AstralObject}: `type` is `'mod.auth.signed_contract'`
 * and `value` is the JSON the Go `auth.SignedContract` marshals to — the
 * embedded contract fields plus `IssuerSig` / `SubjectSig` (`crypto.Signature`
 * envelopes, either possibly absent before signing completes). Passed through
 * unschematized (Go `api/auth/signed_contract.go`).
 */
export type SignedContract = AstralObject;

/**
 * A client for the `auth` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const auth = new Auth(host);
 *
 * // Ask the node to sign an unsigned contract; get the signed form back.
 * const signed = await auth.signContract({
 *   type: 'mod.auth.contract',
 *   value: { Issuer, Subject, Permits, ExpiresAt },
 * });
 *
 * // Index a signed contract the node already holds, by its object id.
 * await auth.index('data1...');   // resolves void
 * ```
 */
export class Auth {
  private readonly host: Host;

  /** Bind an `auth` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Submit an unsigned {@link Contract} for the node to sign, returning the
   * signed form.
   *
   * This is a bidirectional op (like `tree.set`). It opens the query
   * `auth.sign_contract` with NO arguments, *streams* `contract` as an object,
   * sends `eos` to end the input, then reads the node's reply: a single
   * `mod.auth.signed_contract` object resolves as the returned
   * {@link SignedContract}; a streamed `error_message` rejects with a
   * {@link RemoteError}; any other reply rejects with a {@link ProtocolError}.
   * The contract travels as a streamed object rather than a query argument, so
   * its full nested shape round-trips intact (Go `Client.SignContract` +
   * node `OpSignContract`).
   *
   * LIVE-NODE CAVEAT: the node signs as the contract's `Issuer` and `Subject`,
   * so it must hold both private keys and neither signature may already be set —
   * otherwise its op sends an error (`already signed`, or a signing failure),
   * surfaced here as a {@link RemoteError}. The reply is returned verbatim as an
   * {@link AstralObject}; the SDK does not verify the signatures.
   *
   * @param contract The unsigned contract object to sign (type
   *   `mod.auth.contract`).
   * @returns The signed contract object (type `mod.auth.signed_contract`).
   */
  async signContract(contract: Contract): Promise<SignedContract> {
    const stream = await this.host.query('auth.sign_contract');
    try {
      stream.send(contract);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        return o;
      }
      // The node closed/ended the stream without sending the signed contract.
      throw new ProtocolError('auth.sign_contract returned no signed contract');
    } finally {
      stream.close();
    }
  }

  /**
   * Index the signed contract identified by `objectID` into the node's auth
   * store.
   *
   * Sends query `auth.index?id=<id>` and awaits the node's single `ack`,
   * resolving `void`. The object id travels as a query argument (not a streamed
   * object); the node loads the `mod.auth.signed_contract` at that id, verifies
   * and indexes it, then acks (Go `Client.IndexContract` + node `OpIndex`).
   * Rejects with a {@link RemoteError} if the node reports a failure — the id is
   * unknown, the stored object is not a signed contract, or a signature does not
   * verify — and with a {@link ProtocolError} if the node ends the stream
   * without acking.
   *
   * The id is validated through {@link parseObjectID} before the call, so a
   * malformed id rejects with a `TypeError` without touching the network.
   *
   * @param objectID The object id of the signed contract to index (an
   *   {@link ObjectID} or its `data1…` string).
   */
  async index(objectID: ObjectID | string): Promise<void> {
    const id = parseObjectID(objectID);
    const stream = await this.host.query('auth.index', { args: { id } });
    try {
      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (isAck(o)) return;
        throw new ProtocolError(`auth.index expected an ack, got ${o.type}`);
      }
      // The node ended the stream without acking.
      throw new ProtocolError(`auth.index for ${JSON.stringify(id)} was not acknowledged`);
    } finally {
      stream.close();
    }
  }
}
