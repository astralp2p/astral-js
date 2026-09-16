// api/objects — the objects protocol client (typed object retrieval).
// Built on the apphost WebSocket client's query. Basic ops: probe, contains,
// find. (objects.read returns unframed raw bytes — deferred with the IPC
// transport.) Populated by: dev/api-objects.

/**
 * The `objects` protocol client: probe an object's descriptor, test local
 * availability, and find the identities that hold it.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `objects.*`
 * operations exactly as the reference node serves them
 * (`mod/objects/client/{probe,find}.go` and
 * `mod/objects/src/op_contains.go`). Each method folds its arguments into the
 * query string via {@link Host.call} / {@link Host.callOne} / {@link Host.query}
 * (which build `objects.<op>?<args>` through the shared query-string encoder):
 *
 *   - {@link Objects.probe} — query `objects.probe` with `{ id }`; the node
 *     replies with one descriptor object (`mod.objects.probe`, carrying `Type` /
 *     `Repo` / `Mime` / `Time`), returned as a raw {@link AstralObject} so the
 *     caller can read its `value` without this SDK imposing a schema (an empty
 *     response rejects with a {@link ProtocolError}).
 *   - {@link Objects.contains} — query `objects.contains` with `{ repo, id }`;
 *     the node replies with one `bool`, coerced to a JS `boolean`.
 *   - {@link Objects.find} — query `objects.find` with `{ id }`; the node streams
 *     an `identity` per holder until `eos`, each decoded through
 *     {@link parseIdentity} and yielded from an async iterable.
 *   - {@link Objects.store} — query `objects.store` with `{ repo? }`, then
 *     *stream* the objects to store followed by `eos` (the bidirectional
 *     `tree.set` shape); the node replies with one `object_id.sha256` per
 *     stored object.
 *   - {@link Objects.repositories} — query `objects.repositories` with no
 *     arguments; the node streams one `mod.objects.repository_info` per
 *     repository or group, returned as {@link RepositoryInfoValue}s.
 *
 * Only the BASIC operations plus `store` live here. `objects.read` returns
 * unframed raw bytes (no astral framing) and is out of scope for the
 * `astral.json.v1` transport; the `describe` / `search` and the remaining write
 * (create/delete/push/…) operations are ADVANCED and intentionally omitted.
 *
 * `repo` follows what astrald requires of each op, not a uniform SDK choice:
 * `objects.probe` leaves `Repo` optional and {@link Objects.probe} omits it,
 * letting the node pick the default repository; `objects.contains` tags `Repo`
 * `query:"required"` and {@link Objects.contains} takes it positionally, as the
 * Python client does.
 *
 * @module api/objects
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { AstralObject } from '../../astral/object.js';
import { obj, eos, isEos, isError } from '../../astral/object.js';
import type { Zone } from '../../astral/zone.js';
import type { Identity } from '../../astral/identity.js';
import { parseIdentity, isAnyone } from '../../astral/identity.js';
import type { ObjectID } from '../../astral/objectid.js';
import { parseObjectID } from '../../astral/objectid.js';
import type { Blueprint } from '../../astral/blueprint.js';
import { BLUEPRINT_TYPE, blueprintToValue, blueprintFromValue } from '../../astral/blueprint.js';
import { ProtocolError, RemoteError, readErrorMessage } from '../../astral/errors.js';

export { REPOSITORY_INFO_TYPE } from './consts.js';

/** Options for {@link Objects.store}. */
export interface StoreOptions {
  /** The repository to write into; the node's write-default when omitted. */
  repo?: string;
}

/** Options for {@link Objects.scan}. */
export interface ScanOptions {
  /** Keep the scan open and tail live additions. */
  follow?: boolean;
  /** Zone filter for the scan context. */
  zone?: Zone;
  /**
   * Called once, in follow mode only, when the snapshot/live boundary is
   * crossed — after the last pre-existing id and before the first live one.
   * Lets a caller tell an empty repository from one still streaming its
   * history, without a second scan or a timer. Never called in one-shot mode.
   */
  onHistoryComplete?: () => void;
}

/**
 * The JSON `value` of a `mod.objects.repository_info` {@link AstralObject}: one
 * entry of the node's repository tree, either a repository or a group of them.
 *
 * The field names are the Go struct's exported names verbatim (astral-go
 * `21acd1b`, `api/objects/repository_info.go`).
 *
 * {@link RepositoryInfoValue.Kind} tells the two apart, not
 * {@link RepositoryInfoValue.Children}: a leaf repository and an empty group
 * both carry an empty `Children` array.
 */
export interface RepositoryInfoValue {
  /** The entry's name — the `repo` argument the other `objects.*` ops take. */
  Name: string;
  /** The entry's human-readable label. */
  Label: string;
  /**
   * Free space in bytes. For a group, the sum of what its members report — a
   * member reporting unknown space adds nothing, and a member that fails to
   * report makes the whole sum `0`.
   *
   * PRECISION — a `uint64` on the wire, decoded as a JSON number. A value above
   * `Number.MAX_SAFE_INTEGER` (2^53 − 1, ~9 PB) loses precision here. This
   * follows the SDK's existing uint64 convention (`LinkInfoValue.BytesThroughput`);
   * a caller needing exact byte counts at that scale reads the raw JSON itself.
   */
  Free: number;
  /** `repository` for a single repository, `group` for a group of them. */
  Kind: string;
  /** The names of a group's members, in lookup order; empty for a repository. */
  Children: string[];
  /**
   * How a group reads: `true` races every member and takes the first success,
   * `false` tries them in `Children` order. Reads only — a group creates and
   * scans the same way either way. `false` for a repository.
   */
  Concurrent: boolean;
}

/**
 * A client for the `objects` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const objects = new Objects(host);
 * const probe = await objects.probe('data1...');   // descriptor AstralObject
 * const type = (probe.value as { Type: string }).Type; // 'mod.dir.alias_map' etc.
 * const has = await objects.contains('local', 'data1...'); // boolean
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
   * Return whether the repository `repo` holds the object `id`.
   *
   * Sends query `objects.contains?repo=<repo>&id=<id>` and coerces the node's
   * single `bool` result to a JS `boolean` (a missing result or a falsy value
   * both yield `false`). Rejects with a {@link RemoteError} if the node reports
   * a failure (e.g. an unknown repository).
   *
   * `repo` is required and positional, matching the Python client. astrald tags
   * it `query:"required"` (`mod/objects/src/op_contains.go:11`), so a query
   * without it is rejected with `QueryRejected` before the op runs — unlike
   * {@link Objects.probe}, whose `Repo` is optional. Use
   * {@link Objects.repositories} to discover the names a node serves; `local`
   * is the usual default.
   *
   * @param repo The repository to test (a `Name` from {@link Objects.repositories}).
   * @param id The object id to test (an {@link ObjectID} or its `data1…` string).
   * @returns `true` if the repository holds the object, `false` otherwise.
   */
  async contains(repo: string, id: ObjectID | string): Promise<boolean> {
    const value = await this.host.callOne(Ops.contains, { args: { repo, id } });
    return Boolean(value);
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

  /**
   * Store typed objects as new repository entries and return their ids.
   *
   * Opens `objects.store` (folding `repo` into the query string when given),
   * *streams* each object in `objects` followed by `eos`, then collects the
   * node's replies: one `object_id.sha256` per stored input, in order,
   * returned as `data1…` strings. Follows the same send-then-read shape as
   * `tree.set` — the node reads input until `eos`, encodes and commits each
   * object as a separate entry, and answers with the ids. An unknown
   * repository or a failed store streams an `error_message`, surfaced as a
   * {@link RemoteError}.
   *
   * @param objects The typed objects to store, each committed as its own entry.
   * @param opts.repo The repository to write into; the node's write-default
   *   repository when omitted.
   * @returns One {@link ObjectID} (`data1…` string) per stored object, in order.
   */
  async store(objects: AstralObject[], opts: StoreOptions = {}): Promise<ObjectID[]> {
    const stream = await this.host.query(Ops.store, { args: { repo: opts.repo } });
    try {
      for (const o of objects) stream.send(o);
      stream.send(eos());

      const ids: ObjectID[] = [];
      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        ids.push(parseObjectID(o.value as string));
      }
      return ids;
    } finally {
      stream.close();
    }
  }

  /**
   * Stream the ids of every object in `repo`, optionally following live
   * additions.
   *
   * Sends `objects.scan?repo=<repo>` (with `follow`/`zone` when given) and
   * yields one {@link ObjectID} per `object_id.sha256` the node streams. In the
   * default one-shot mode iteration ends at the node's terminating `eos`. In
   * **follow** mode the node sends the snapshot, an `eos` *separator*, then live
   * ids as they are added; this uses {@link Stream.frames} so that separator
   * `eos` does not end iteration — the loop tails until the caller `break`s or
   * the socket closes. `opts.onHistoryComplete` fires once at that separator, so
   * a caller can tell an empty repository from one still streaming its history
   * without a second scan. A streamed `error_message` surfaces as a
   * {@link RemoteError}.
   *
   * @param repo The repository to scan.
   * @param opts See {@link ScanOptions}.
   * @returns An async iterable of object ids.
   */
  async scan(repo: string, opts: ScanOptions = {}): Promise<AsyncIterable<ObjectID>> {
    const stream = await this.host.query(Ops.scan, {
      args: { repo, follow: opts.follow, zone: opts.zone },
    });
    const follow = opts.follow === true;
    const onHistoryComplete = opts.onHistoryComplete;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ObjectID, void, undefined> {
        try {
          const source = follow ? stream.frames() : stream[Symbol.asyncIterator]();
          for await (const o of source) {
            if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
            if (isEos(o)) {
              onHistoryComplete?.(); // follow: snapshot/live separator (one-shot mode never reaches here)
              continue;
            }
            yield parseObjectID(o.value as string);
          }
        } finally {
          stream.close();
        }
      },
    };
  }

  /**
   * Load the object `id` and return its decoded typed representation, or `null`
   * if the node returns nothing.
   *
   * Sends `objects.load?id=<id>` (with `repo`/`zone` when given) and returns the
   * node's single decoded object (`objects.load` decodes astral payloads into
   * their typed form; non-astral payloads come back as `blob`). Unlike
   * `objects.read` (raw bytes, no framing — out of scope for this transport),
   * `objects.load` is a normal typed reply, collected via {@link Host.call}; a
   * streamed `error_message` surfaces as a {@link RemoteError}.
   *
   * @param id The object id to load.
   * @param opts.repo Repository to read from; the node's read-default when omitted.
   * @param opts.zone Zone filter for the read context.
   * @returns The decoded {@link AstralObject}, or `null` when the node returns none.
   */
  async load(
    id: ObjectID | string,
    opts: { repo?: string; zone?: Zone } = {},
  ): Promise<AstralObject | null> {
    const objs = await this.host.call(Ops.load, {
      args: { id, repo: opts.repo, zone: opts.zone },
    });
    return objs.length > 0 ? objs[0]! : null;
  }

  /**
   * Register one or more {@link Blueprint} descriptors and return their ids.
   *
   * Opens `objects.register_blueprint` (a batch op), *streams* each descriptor
   * as an `astral.blueprint` object followed by `eos`, then reads the node's
   * replies: one `object_id.sha256` per descriptor, in order, plus a final
   * `eos` the stream iterator stops at. A descriptor the node rejects (invalid
   * schema, wire-corrupt) streams an `error_message`, surfaced as a
   * {@link RemoteError}.
   *
   * Registration lives in the node's memory: it covers **one node** and does
   * **not survive a restart**. The caller must hold
   * `mod.auth.store_objects_action`; a caller without it is rejected before the
   * node opens a repository.
   *
   * A type name is still first-come within the node's lifetime: any holder of
   * `mod.auth.store_objects_action` can take a name, and a name is not
   * reclaimable the way a stored object is.
   *
   * @param blueprints One descriptor or an array of them.
   * @returns One {@link ObjectID} (`data1…` string) per descriptor, in order —
   *   the id of the blueprint's own canonical form.
   */
  async registerBlueprint(blueprints: Blueprint | Blueprint[]): Promise<ObjectID[]> {
    const list = Array.isArray(blueprints) ? blueprints : [blueprints];
    const stream = await this.host.query(Ops.registerBlueprint);
    try {
      for (const bp of list) stream.send(obj(BLUEPRINT_TYPE, blueprintToValue(bp)));
      stream.send(eos());

      const ids: ObjectID[] = [];
      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        ids.push(parseObjectID(o.value as string));
      }
      return ids;
    } finally {
      stream.close();
    }
  }

  /**
   * Read a registered type's {@link Blueprint} back from the node.
   *
   * Sends `objects.get_blueprint?type=<type>` and decodes the single
   * `astral.blueprint` reply. Lets a consumer read a type it does not itself
   * define. A primitive type (no blueprint) or an unregistered name streams an
   * `error_message`, surfaced as a {@link RemoteError}.
   *
   * @param type The registered object type name.
   * @returns The decoded {@link Blueprint} descriptor.
   */
  async getBlueprint(type: string): Promise<Blueprint> {
    const value = await this.host.callOne(Ops.getBlueprint, { args: { type } });
    if (value == null) throw new ProtocolError('objects.get_blueprint returned no blueprint');
    return blueprintFromValue(value);
  }

  /**
   * List the repositories the node serves.
   *
   * Sends `objects.repositories` (no arguments); the node streams one
   * `mod.objects.repository_info` per entry, terminated by `eos`. Each entry's
   * `value` is returned shaped like {@link RepositoryInfoValue}.
   *
   * The entries form a tree: an entry of kind `group` names its members in
   * `Children`, and each name resolves to another entry in the same stream. An
   * entry of kind `repository` is a leaf. `Children` alone does not separate the
   * two — an empty group has an empty `Children` array, exactly like a leaf.
   *
   * An empty result is an answer, not a failure: the node replied and serves no
   * repository. A per-entry encoding failure streams an `error_message`,
   * surfaced as a {@link RemoteError} by {@link Host.call}.
   *
   * @returns One {@link RepositoryInfoValue} per repository or group.
   */
  async repositories(): Promise<RepositoryInfoValue[]> {
    const objs = await this.host.call(Ops.repositories);
    return objs.map((o) => o.value as RepositoryInfoValue);
  }
}
