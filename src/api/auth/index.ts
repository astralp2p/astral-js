// api/auth — the auth protocol client (permission contracts: sign).
// Built on the apphost WebSocket client's query. Basic op: signContract.
// Populated by: dev/api-auth.

/**
 * The `auth` protocol client: sign authorization contracts.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `auth.*` operations
 * exactly as the reference node serves them. Grounded in both implementations:
 *   - Go client: `api/auth/client/sign_contract.go`, method name constant from
 *     `api/auth/module.go` (`MethodSignContract` = `auth.sign_contract`).
 *   - Go node op: `mod/auth/src/op_sign_contract.go` (the wire flow).
 *
 * {@link Auth.signContract} queries `auth.sign_contract` with NO args, then
 * *streams* the {@link Contract} object followed by `eos`, and reads back the
 * single `mod.auth.signed_contract` reply. This is a bidirectional op like
 * `tree.set`: the contract travels as a streamed object (not a query arg) so
 * its full nested shape round-trips intact (Go `Client.SignContract` sends the
 * contract after the channel is established; node `OpSignContract` reads a
 * `Contract`, signs it, and sends the `SignedContract` back).
 *
 * Complex signed objects (the {@link Contract} and {@link SignedContract}) are
 * passed through as friendly {@link AstralObject}s: the caller supplies and
 * reads the object `value` directly. The type aliases below document the JSON
 * shape that is obvious from the Go types, but they remain structurally
 * `AstralObject`. A permit is typed as {@link PermitValue}: a flat
 * `{ Action, Constraints, Delegation }` object whose `Constraints` is a bundle,
 * a JSON array of `{ Type, Object }` envelopes ({@link BundleValue}).
 *
 * Only this BASIC op lives here. The node's contract-query / verify /
 * authorize surface is not exposed through this client.
 *
 * @module api/auth
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { eos, isError } from '../../astral/object.js';
import { RemoteError, ProtocolError, readErrorMessage } from '../../astral/errors.js';

export { PERMIT_TYPE, permit, toPermit } from './types.js';
export type { BundleValue, PermitInput, PermitValue } from './types.js';

/**
 * The unsigned body of an authorization grant, sent to {@link Auth.signContract}.
 *
 * Structurally an {@link AstralObject}: `type` is `'mod.auth.contract'` and
 * `value` is the JSON object the Go `auth.Contract` marshals to — `Issuer` /
 * `Subject` (identity envelopes), `Permits` (a list of flat
 * {@link PermitValue} objects), and `ExpiresAt` (a time envelope). The caller
 * builds and reads `value` directly (Go `api/auth/contract.go`).
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
    const stream = await this.host.query(Ops.signContract);
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
}
