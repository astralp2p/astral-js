/**
 * The astral object model and its JSON wire envelope.
 *
 * Over `astral.json.v1` every message on the wire is a JSON envelope
 * `{ Type, Object }` (Go-exported field names; `Object` is omitted when empty).
 * Throughout this SDK we work with the friendlier {@link AstralObject}
 * `{ type, value }` and convert at the single seam of {@link wrap}/{@link unwrap}.
 *
 * @module astral/object
 */

/** A decoded astral object: a type tag plus its already-JSON-parsed value. */
export interface AstralObject {
  /** The object type tag, e.g. `'string8'`, `'ack'`, `'mod.dir.alias_map'`. */
  type: string;
  /** The object's value in its JSON form (string, number, boolean, object, array, or `null`). */
  value: unknown;
}

/** The on-the-wire JSON envelope. `Object` is absent/omitted when the value is empty. */
export interface WireEnvelope {
  Type: string;
  Object?: unknown;
}

/** Well-known short-form object type tags used on the `astral.json.v1` wire. */
export const ObjectTypes = {
  /** Acknowledgement sentinel (empty). */
  Ack: 'ack',
  /** End-of-stream sentinel (empty). */
  Eos: 'eos',
  /** A transmittable error carrying a message string. */
  ErrorMessage: 'error_message',
  /** A node identity (66-hex string or `'anyone'`). */
  Identity: 'identity',
  /** An object id (opaque `data1…` string). */
  ObjectID: 'object_id.sha256',
  /** A 64-bit nonce (16-hex string). */
  Nonce: 'nonce64',
  /** A reachability zone (`'dvn'` subset string). */
  Zone: 'zone',
  /** Length-prefixed strings — plain JSON strings in JSON mode. */
  String8: 'string8',
  String16: 'string16',
  String32: 'string32',
  /** A byte buffer — a base64 JSON string in JSON mode. */
  Bytes32: 'bytes32',
} as const;

/** Any of the well-known {@link ObjectTypes} tag values. */
export type ObjectTypeName = (typeof ObjectTypes)[keyof typeof ObjectTypes];

/** Convert a friendly {@link AstralObject} to its wire {@link WireEnvelope}. */
export function wrap(object: AstralObject): WireEnvelope {
  return { Type: object.type, Object: object.value === undefined ? null : object.value };
}

/** Convert a wire {@link WireEnvelope} to a friendly {@link AstralObject}. */
export function unwrap(envelope: WireEnvelope): AstralObject {
  return { type: envelope.Type, value: envelope.Object === undefined ? null : envelope.Object };
}

/** Construct an astral object with the given type and value. */
export function obj(type: string, value: unknown = null): AstralObject {
  return { type, value };
}

/** The acknowledgement sentinel object `{ type: 'ack', value: null }`. */
export function ack(): AstralObject {
  return { type: ObjectTypes.Ack, value: null };
}

/** The end-of-stream sentinel object `{ type: 'eos', value: null }`. */
export function eos(): AstralObject {
  return { type: ObjectTypes.Eos, value: null };
}

/** A transmittable error object carrying `message`. */
export function error(message: string): AstralObject {
  return { type: ObjectTypes.ErrorMessage, value: message };
}

/** Shared immutable sentinels. */
export const EOS: AstralObject = Object.freeze(eos());
export const ACK: AstralObject = Object.freeze(ack());
/** The untyped empty object `{ type: '', value: null }`. */
export const EMPTY: AstralObject = Object.freeze({ type: '', value: null });

/** Whether `o` is the end-of-stream sentinel (tolerates the `astral.eos` alias). */
export function isEos(o: AstralObject): boolean {
  return o.type === ObjectTypes.Eos || o.type === 'astral.eos';
}

/** Whether `o` is an acknowledgement (tolerates the `astral.ack` alias). */
export function isAck(o: AstralObject): boolean {
  return o.type === ObjectTypes.Ack || o.type === 'astral.ack';
}

/** Whether `o` is a transmittable error object. */
export function isError(o: AstralObject): boolean {
  return o.type === ObjectTypes.ErrorMessage || o.type === 'astral.error_message';
}

/** Whether `o` carries no value (`null`/`undefined`). */
export function isEmpty(o: AstralObject): boolean {
  return o.value === null || o.value === undefined;
}

/** Whether `o` is untyped (empty type tag) — the pass-through shape for unknown data. */
export function isUntyped(o: AstralObject): boolean {
  return o.type === '';
}
