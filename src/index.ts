/**
 * astral-js — a browser JavaScript client (with TypeScript typings) for astrald.
 *
 * Talks to a local astrald node over the apphost WebSocket using the
 * `astral.json.v1` protocol. Authored in TypeScript, consumed from plain
 * JavaScript (bundled `.d.ts`, dual ESM/CJS).
 *
 * Three layers, each on its own import path (mirrors astral-go's
 * `astral` / `lib/apphost` / `api/<p>` split):
 *
 *   astral-js/astral       wire primitives (Object, Identity, Zone, errors, …)
 *   astral-js/apphost      the apphost WebSocket client lib (connect, Host, Stream, register)
 *   astral-js/api/<p>      protocol clients ('astral-js/api/{dir,crypto,tree,objects}')
 *
 * This root is a thin convenience entry: `connect` plus the primitives. For the
 * full apphost surface (Host, Stream, Registration, IncomingQuery, the
 * transports and message types) import from `astral-js/apphost`; for a protocol
 * client import from its `astral-js/api/<p>` path.
 *
 * A native IPC transport (Node unix/tcp + binary) is a future addition behind
 * the same transport seam; this build is WebSocket + JSON only.
 */

/** The package version. */
export const version = '0.1.0';

// The wire primitives (and the error hierarchy) — so `import { obj, ObjectID,
// ConnectError } from 'astral-js'` works. Full set: `astral-js/astral`.
export * from './astral/index.js';

// The entry point of the apphost client. The rest of the apphost lib (Host,
// Stream, Registration, IncomingQuery, transports, message types) lives at
// `astral-js/apphost`.
export { connect } from './apphost/index.js';
