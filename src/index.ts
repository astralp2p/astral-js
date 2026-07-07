/**
 * astral-js — a browser JavaScript client (with TypeScript typings) for astrald.
 *
 * Talks to a local astrald node over the apphost WebSocket using the
 * `astral.json.v1` protocol. Authored in TypeScript, consumed from plain
 * JavaScript (bundled `.d.ts`, dual ESM/CJS).
 *
 * Layout (mirrors astral-go):
 *   astral/    wire primitives   — import from 'astral-js/astral'
 *   apphost/   the WebSocket client (connect/Host/Stream) — bundled into this root entry (PR: apphost-*)
 *   api/<p>/   protocol clients   — 'astral-js/api/{dir,crypto,tree,objects}' (PR: api-*)
 *
 * A full IPC transport (Node unix/tcp + binary) is a future milestone; this
 * build is WebSocket + JSON only.
 */

/** The package version. */
export const version = '0.1.0';

// astral-core primitives are re-exported here so `import { obj, buildQueryString }
// from 'astral-js'` works. The apphost client surface (connect, Host, Stream,
// errors) is added at this root in the apphost phase.
export * from './astral/index.js';
