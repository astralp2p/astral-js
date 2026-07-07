// api/dir — the directory protocol client (identity <-> alias resolution).
// Built on the apphost WebSocket client's query. Basic ops: resolve, getAlias,
// setAlias. Populated by: dev/api-dir.

/**
 * The `dir` protocol client: resolve node identities by name/alias and read or
 * write their human-readable aliases.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `dir.*` operations
 * exactly as the reference node serves them
 * (`mod/dir/src/op_{resolve,get_alias,set_alias}.go`). Each method folds its
 * arguments into the query string via {@link Host.call} / {@link Host.callOne}
 * (which build `dir.<op>?<args>` through the shared query-string encoder) and
 * decodes the single scripted result:
 *
 *   - {@link Dir.resolve} — query `dir.resolve` with `{ name }`; the node replies
 *     with one `identity` object, decoded through {@link parseIdentity}.
 *   - {@link Dir.getAlias} — query `dir.get_alias` with `{ id }`; the node replies
 *     with one `string8` (the alias, empty when the identity has none).
 *   - {@link Dir.setAlias} — query `dir.set_alias` with `{ id, alias }`; the node
 *     replies with a single `ack`, so the method resolves `void`.
 *
 * Only the BASIC operations live here. The node's `apply_filters`, `alias_map`,
 * and `filters` operations are ADVANCED and intentionally omitted.
 *
 * @module api/dir
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { Identity } from '../../astral/identity.js';
import { parseIdentity } from '../../astral/identity.js';

/**
 * A client for the `dir` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const dir = new Dir(host);
 * const id = await dir.resolve('alice');      // Identity
 * const alias = await dir.getAlias(id);        // 'alice' or ''
 * await dir.setAlias(id, 'alice');             // resolves void
 * ```
 */
export class Dir {
  private readonly host: Host;

  /** Bind a `dir` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Resolve `name` — a hex public key or a registered alias — to a full
   * {@link Identity}.
   *
   * Sends query `dir.resolve?name=<name>` and decodes the node's single
   * `identity` result through {@link parseIdentity}. Rejects with a
   * {@link RemoteError} if the node cannot resolve the name (its op sends an
   * error object), and with a `TypeError` if the returned value is not a valid
   * identity string.
   *
   * @param name A hex public key or an alias to look up.
   * @returns The resolved node identity.
   */
  async resolve(name: string): Promise<Identity> {
    const value = await this.host.callOne(Ops.resolve, { args: { name } });
    return parseIdentity(value as string);
  }

  /**
   * Return the alias registered for `id`, or `''` when it has none.
   *
   * Sends query `dir.get_alias?id=<id>` and returns the node's single `string8`
   * result verbatim — the reference op sends an empty string when no alias is
   * set, so callers get `''` rather than `null`. A `null` reply (no result
   * object at all) is likewise normalized to `''`.
   *
   * @param id The identity whose alias to read (an {@link Identity} or its
   *   string form).
   * @returns The alias string, or `''` when the identity has no alias.
   */
  async getAlias(id: Identity | string): Promise<string> {
    const value = await this.host.callOne(Ops.getAlias, { args: { id } });
    return value == null ? '' : (value as string);
  }

  /**
   * Set (or clear) the alias for `id`.
   *
   * Sends query `dir.set_alias?id=<id>&alias=<alias>` and awaits the node's
   * single `ack`, resolving `void`. Passing an empty string (or omitting
   * `alias`) clears the identity's alias, matching the reference op, which
   * treats an empty alias as a delete. Rejects with a {@link RemoteError} if the
   * node reports a failure.
   *
   * @param id The identity to (re)alias (an {@link Identity} or its string form).
   * @param alias The alias to set; omit or pass `''` to clear it. Defaults to `''`.
   */
  async setAlias(id: Identity | string, alias = ''): Promise<void> {
    await this.host.call(Ops.setAlias, { args: { id, alias } });
  }
}
