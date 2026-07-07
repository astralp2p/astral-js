// api/objects — the objects protocol client (typed object retrieval).
// Built on the apphost WebSocket client's query. Basic ops: probe, contains,
// getType, find. (objects.read returns unframed raw bytes — deferred with the
// IPC transport.) Populated by: dev/api-objects.

/**
 * The `objects` protocol client: probe an object's descriptor, test local
 * availability, read its type, and find the identities that hold it.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `objects.*`
 * operations exactly as the reference node serves them
 * (`mod/objects/client/{probe,get_type,find}.go` and
 * `mod/objects/src/op_contains.go`). Each method folds its arguments into the
 * query string via {@link Host.call} / {@link Host.callOne} / {@link Host.query}
 * (which build `objects.<op>?<args>` through the shared query-string encoder):
 *
 *   - {@link Objects.probe} — query `objects.probe` with `{ id }`; the node
 *     replies with one descriptor object (`mod.objects.probe`, carrying `Type` /
 *     `Repo` / `Mime` / `Time`), returned as a raw {@link AstralObject} so the
 *     caller can read its `value` without this SDK imposing a schema (an empty
 *     response rejects with a {@link ProtocolError}).
 *   - {@link Objects.contains} — query `objects.contains` with `{ id }`; the node
 *     replies with one `bool`, coerced to a JS `boolean`.
 *   - {@link Objects.getType} — query `objects.get_type` with `{ id }`; the node
 *     replies with one `string8` (the object's type), returned verbatim.
 *   - {@link Objects.find} — query `objects.find` with `{ id }`; the node streams
 *     an `identity` per holder until `eos`, each decoded through
 *     {@link parseIdentity} and yielded from an async iterable.
 *
 * Only the BASIC operations live here. `objects.read` returns unframed raw bytes
 * (no astral framing) and is out of scope for the `astral.json.v1` transport;
 * the `describe` / `search` / `write` (create/store/delete/…) operations are
 * ADVANCED and intentionally omitted.
 *
 * Divergence from the Go client resolved here: Go's `Probe`/`Contains` also take
 * a `repo` argument (defaulting to the main repo server-side); following the
 * Python client (`protocols/objects.py`) and the BASIC scope, these methods fold
 * `{ id }` only, letting the node pick the default repository.
 *
 * @module api/objects
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { isError } from '../../astral/object.js';
import type { Identity } from '../../astral/identity.js';
import { parseIdentity, isAnyone } from '../../astral/identity.js';
import type { ObjectID } from '../../astral/objectid.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

/**
 * A client for the `objects` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const objects = new Objects(host);
 * const probe = await objects.probe('data1...');   // descriptor AstralObject
 * const has = await objects.contains('data1...');   // boolean
 * const type = await objects.getType('data1...');   // 'mod.dir.alias_map' etc.
 * for await (const holder of await objects.find('data1...')) {
 *   // holder: Identity
 * }
 * ```
 */
export class Objects {
  private readonly host: Host;

  /** Bind an `objects` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Probe `id` and return its descriptor object.
   *
   * Sends query `objects.probe?id=<id>` and returns the node's single descriptor
   * result as a raw {@link AstralObject} (`mod.objects.probe`, whose `value`
   * carries the object's `Type`, `Repo`, `Mime`, and probe `Time`) — returned
   * unwrapped so the caller can read the descriptor without this SDK imposing a
   * schema. Rejects with a {@link RemoteError} if the node cannot probe the
   * object (its op sends an error object). The reference op replies with exactly
   * one descriptor (Go `channel.Expect`); an empty response is a protocol
   * violation and rejects with a {@link ProtocolError}.
   *
   * @param id The object id to probe (an {@link ObjectID} or its `data1…` string).
   * @returns The descriptor {@link AstralObject}.
   */
  async probe(id: ObjectID | string): Promise<AstralObject> {
    const objs = await this.host.call(Ops.probe, { args: { id } });
    if (objs.length === 0) {
      throw new ProtocolError('objects.probe returned no descriptor');
    }
    return objs[0]!;
  }

  /**
   * Return whether the object `id` is available locally.
   *
   * Sends query `objects.contains?id=<id>` and coerces the node's single `bool`
   * result to a JS `boolean` (a missing result or a falsy value both yield
   * `false`). Rejects with a {@link RemoteError} if the node reports a failure
   * (e.g. an unknown repository).
   *
   * CAVEAT — needs live-node confirmation. Unlike `objects.probe` (which reads
   * the default repository), the Go `op_contains` looks up the repository under
   * the empty key, so `contains` with no `repo` arg may error on a node that has
   * no default (empty-keyed) repository registered. A `repo` argument is not yet
   * exposed here (basic scope).
   *
   * @param id The object id to test (an {@link ObjectID} or its `data1…` string).
   * @returns `true` if the node holds the object, `false` otherwise.
   */
  async contains(id: ObjectID | string): Promise<boolean> {
    const value = await this.host.callOne(Ops.contains, { args: { id } });
    return Boolean(value);
  }

  /**
   * Return the type of the object `id`.
   *
   * Sends query `objects.get_type?id=<id>` and returns the node's single
   * `string8` result verbatim (the object's registered type string, e.g.
   * `mod.dir.alias_map`). A `null` reply (no result object at all) is normalized
   * to `''`. Rejects with a {@link RemoteError} if the node reports a failure.
   *
   * @param id The object id whose type to read (an {@link ObjectID} or its
   *   `data1…` string).
   * @returns The object's type string, or `''` when the node returns none.
   */
  async getType(id: ObjectID | string): Promise<string> {
    const value = await this.host.callOne(Ops.getType, { args: { id } });
    return value == null ? '' : (value as string);
  }

  /**
   * Find the identities that hold the object `id`.
   *
   * Sends query `objects.find?id=<id>` and returns an async iterable that yields
   * one {@link Identity} per holder as the node streams them, ending when the
   * node sends `eos` (or the socket closes). Each streamed `identity` object is
   * decoded through {@link parseIdentity}; the zero/anonymous identity the node
   * may emit is skipped, matching the reference client. A transmittable error
   * object in the stream surfaces as a {@link RemoteError} thrown from the
   * iteration.
   *
   * The query is opened eagerly (so a reject / `route_not_found` rejects this
   * call before iteration begins); the {@link Stream} is drained lazily as the
   * caller iterates.
   *
   * @param id The object id to find holders for (an {@link ObjectID} or its
   *   `data1…` string).
   * @returns An async iterable of holder {@link Identity} values.
   */
  async find(id: ObjectID | string): Promise<AsyncIterable<Identity>> {
    const stream = await this.host.query(Ops.find, { args: { id } });
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Identity, void, undefined> {
        try {
          for await (const o of stream) {
            // The stream is drained directly (not via Host.call), so surface a
            // transmittable error object as a RemoteError, matching PassErrors.
            if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
            const identity = parseIdentity(o.value as string);
            // The node may emit the zero/anonymous identity; skip it, matching
            // the reference client's `!id.IsZero()` filter.
            if (isAnyone(identity)) continue;
            yield identity;
          }
        } finally {
          stream.close();
        }
      },
    };
  }
}
