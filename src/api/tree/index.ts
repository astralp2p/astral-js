// api/tree — the tree protocol client (the node's config/value tree).
// Built on the apphost WebSocket client's query. Basic ops: get, set, list,
// delete. Populated by: dev/api-tree.

/**
 * The `tree` protocol client: a hierarchical key/value store where each path
 * holds one typed {@link AstralObject} and may have named children.
 *
 * A thin, typed wrapper over a {@link Host} that speaks the `tree.*` operations
 * exactly as the reference node serves them. Grounded in both reference
 * implementations:
 *   - Go: `mod/tree/client/node.go` + `mod/tree/client/server.go` (`NodeOps`),
 *     method names from `mod/tree/module.go` (`MethodGet`/`MethodSet`/…).
 *   - Python: `astral-py/.../protocols/tree.py` (class `Tree`).
 *
 * Each method folds its arguments into the query string via the shared encoder
 * (`tree.<op>?<args>`) and drives the matching request/response shape:
 *
 *   - {@link Tree.get} — query `tree.get` with `{ path, follow? }`. A one-shot
 *     read returns the single stored {@link AstralObject}; a `follow` read keeps
 *     the {@link Stream} open so the caller receives the current value and every
 *     subsequent update (Go `Node.Get(ctx, follow)`).
 *   - {@link Tree.set} — query `tree.set` with `{ path }`, then *stream* the
 *     value object followed by `eos` and await a single `ack`. This is the one
 *     bidirectional op: the value travels as a streamed object, not a query arg
 *     (Go `NodeOps.setBatch`, Python `Tree.set`).
 *   - {@link Tree.list} — query `tree.list` with `{ path }`; the node streams one
 *     `string8` per child name, ending in `eos` (Go `NodeOps.List`).
 *   - {@link Tree.delete} — query `tree.delete` with `{ path, recursive? }`; the
 *     node replies with a single `ack` (Go `NodeOps.Delete`).
 *
 * Only the BASIC operations live here. The node's `tree.mount_remote` /
 * `tree.unmount` operations are ADVANCED and intentionally omitted.
 *
 * @module api/tree
 */

import type { Host } from '../../apphost/host.js';
import { Ops } from './consts.js';
import type { Stream } from '../../apphost/stream.js';
import type { AstralObject } from '../../astral/object.js';
import { eos, isError, isAck } from '../../astral/object.js';
import { RemoteError, ProtocolError, readErrorMessage } from '../../astral/errors.js';

/** Options for {@link Tree.get}. */
export interface GetOptions {
  /**
   * When `true`, keep the stream open and receive the current value followed by
   * every subsequent update, instead of a single one-shot read.
   */
  follow?: boolean;
}

/** Options for {@link Tree.delete}. */
export interface DeleteOptions {
  /** When `true`, delete the whole subtree at `path`, not just the node itself. */
  recursive?: boolean;
}

/**
 * A client for the node's `tree` protocol, bound to a connected {@link Host}.
 *
 * @example
 * ```ts
 * const host = await connect('ws://127.0.0.1:8625', { token });
 * const tree = new Tree(host);
 *
 * const obj = await tree.get('/net/alias');          // AstralObject
 * await tree.set('/net/alias', { type: 'string8', value: 'alice' });
 * for await (const name of await tree.list('/net')) console.log(name);
 * await tree.delete('/net/alias');
 *
 * // Follow a value and its updates:
 * const stream = (await tree.get('/net/alias', { follow: true })) as Stream;
 * for await (const update of stream) console.log(update.value);
 * ```
 */
export class Tree {
  private readonly host: Host;

  /** Bind a `tree` client to a connected {@link Host}. */
  constructor(host: Host) {
    this.host = host;
  }

  /**
   * Read the value stored at `path`.
   *
   * One-shot (the default): sends `tree.get?path=<path>`, reads the node's
   * single result, closes the stream, and returns it as the full
   * {@link AstralObject} (type tag preserved so the caller can decode it).
   * Rejects with a {@link RemoteError} if the node reports the path is missing
   * (it streams an `error_message`), and with a {@link ProtocolError} if the
   * node accepts the query but sends no value at all.
   *
   * Follow mode (`opts.follow === true`): sends `tree.get?path=<path>&follow=true`
   * and returns the live {@link Stream} *without* draining or closing it. The
   * caller iterates it to receive the current value first and then each update,
   * and must `close()` it when done (Go `Node.Get(ctx, follow)`).
   *
   * @param path The tree path to read (e.g. `/net/alias`).
   * @param opts.follow Keep the stream open for live updates.
   * @returns The stored {@link AstralObject} (one-shot), or the live
   *   {@link Stream} of value updates (follow mode).
   */
  async get(path: string, opts: GetOptions = {}): Promise<AstralObject | Stream> {
    const follow = opts.follow ?? false;
    const stream = await this.host.query(Ops.get, {
      args: { path, follow: follow ? true : undefined },
    });

    // Follow mode hands back the live stream: the caller drives iteration and
    // owns closing it, mirroring the reference client's open follow channel.
    if (follow) return stream;

    // One-shot: read exactly the first object, surface a remote error, then
    // close the stream. Reading past the first object is unnecessary — the node
    // sends a single value then eos for a non-follow get.
    try {
      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        return o;
      }
    } finally {
      stream.close();
    }
    throw new ProtocolError(`tree.get returned no value for ${JSON.stringify(path)}`);
  }

  /**
   * Store the typed `value` at `path`, creating the node if needed.
   *
   * This is the one bidirectional op. It opens the query
   * `tree.set?path=<path>`, *streams* `value` as an object, sends `eos` to end
   * the input, then awaits the node's reply: a single `ack` resolves `void`; a
   * streamed `error_message` rejects with a {@link RemoteError}; any other reply
   * rejects with a {@link ProtocolError}. The value travels as a streamed object
   * rather than a query argument, so its full type/value round-trips intact (Go
   * `NodeOps.setBatch`, Python `Tree.set`).
   *
   * @param path The tree path to write (e.g. `/net/alias`).
   * @param value The typed object to store at `path`.
   */
  async set(path: string, value: AstralObject): Promise<void> {
    const stream = await this.host.query(Ops.set, { args: { path } });
    try {
      stream.send(value);
      stream.send(eos());

      for await (const o of stream) {
        if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
        if (isAck(o)) return;
        throw new ProtocolError(`tree.set expected an ack, got ${o.type}`);
      }
      // The node closed/ended the stream without acking.
      throw new ProtocolError(`tree.set for ${JSON.stringify(path)} was not acknowledged`);
    } finally {
      stream.close();
    }
  }

  /**
   * List the immediate child names under `path`.
   *
   * Sends `tree.list?path=<path>`; the node streams one `string8` per child,
   * ending in `eos` (Go `NodeOps.List`). Returns an {@link AsyncIterable} that
   * yields each child name as a string, lazily draining the underlying
   * {@link Stream}. Iterating to completion consumes the `eos` and lets the
   * stream close; a `RemoteError` is thrown if the node streams an
   * `error_message` (e.g. the path is missing).
   *
   * @param path The tree path whose children to list (e.g. `/net`).
   * @returns An async iterable of child name strings.
   */
  async list(path: string): Promise<AsyncIterable<string>> {
    const stream = await this.host.query(Ops.list, { args: { path } });
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
        try {
          for await (const o of stream) {
            if (isError(o)) throw new RemoteError(readErrorMessage(o) ?? 'remote error');
            yield String(o.value);
          }
        } finally {
          stream.close();
        }
      },
    };
  }

  /**
   * Delete the node at `path`.
   *
   * Sends `tree.delete?path=<path>` (adding `&recursive=true` when
   * `opts.recursive` is set) and awaits the node's single `ack`, resolving
   * `void`. With `recursive`, the node removes the whole subtree leaves-first
   * before the target node (Go `NodeOps.Delete`); without it, only the node's
   * own value is removed. Rejects with a {@link RemoteError} if the node reports
   * a failure.
   *
   * @param path The tree path to delete (e.g. `/net/alias`).
   * @param opts.recursive Delete the whole subtree rooted at `path`.
   */
  async delete(path: string, opts: DeleteOptions = {}): Promise<void> {
    const recursive = opts.recursive ?? false;
    await this.host.call(Ops.delete, {
      args: { path, recursive: recursive ? true : undefined },
    });
  }
}
