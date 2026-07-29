/**
 * Blueprints — runtime descriptions of an astral object type.
 *
 * A node knows an object type either from a compiled-in prototype or from a
 * registered {@link Blueprint}. Registering one lets an app define its own
 * object types instead of smuggling app data as JSON inside a generic string:
 * the node then indexes objects of that type and reports the type on `get_type`.
 *
 * A `Blueprint` is one of two kinds, mutually exclusive:
 *   - **struct** — an ordered list of named {@link Field}s; `underlying` is unset.
 *   - **alias** — `underlying` names a primitive; the alias-typed value is wire-
 *     identical to that primitive, and the alias name lives only in the registry.
 *
 * This module is pure wire shaping: it converts between the friendly
 * descriptor model and the `astral.blueprint` JSON value. The `Spec` slot of a
 * field is interface-typed on the wire — a nested `{ Type, Object }` container
 * naming the carrier — so it is encoded and decoded explicitly here rather than
 * left to a flat mapping (grounded in astral-go `astral/blueprint.go` and the
 * spec `topics/blueprints.md#json`).
 *
 * @module astral/blueprint
 */

import { EncodingError } from './errors.js';

/** The astral type tag of a blueprint descriptor object. */
export const BLUEPRINT_TYPE = 'astral.blueprint';

/**
 * The primitive astral types a {@link PrimitiveSpec} may name. The node's
 * allowlist; a value outside it is rejected at registration.
 */
export type PrimitiveType =
  | 'string8'
  | 'string16'
  | 'string32'
  | 'string64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'bytes8'
  | 'bytes16'
  | 'bytes32'
  | 'bytes64'
  | 'bool'
  | 'time'
  | 'identity'
  | 'object_id.sha256'
  | 'nonce64'
  | 'duration'
  | 'zone';

/**
 * One field's wire shape. The carrier set is closed; the `kind` discriminates
 * it, mirroring astral-go's `Spec` carriers.
 *
 * - `primitive` — a primitive from the allowlist.
 * - `ref` — another registered object type, inlined (no type tag).
 * - `slice` — a slice of `type` elements; an absent `type` means heterogeneous.
 * - `array` — a fixed-length array of `type` elements; an absent `type` means
 *   heterogeneous. `length` is part of the schema.
 * - `map` — a map keyed by `keyType` (`string16` or `uintN`) with `valueType`
 *   values; an absent `valueType` means heterogeneous.
 * - `ptr` — an optional value of `type`.
 * - `object` — an arbitrary object carried with its own type tag.
 */
export type Spec =
  | { kind: 'primitive'; primitiveType: PrimitiveType }
  | { kind: 'ref'; type: string }
  | { kind: 'slice'; type?: string }
  | { kind: 'array'; type?: string; length: number }
  | { kind: 'map'; keyType: string; valueType?: string }
  | { kind: 'ptr'; type: string }
  | { kind: 'object' };

/** A single named slot in a struct {@link Blueprint}. */
export interface Field {
  /** The field name — ASCII, unique within the blueprint (case-insensitive). */
  name: string;
  /** The field's wire shape. */
  spec: Spec;
}

/**
 * A runtime object-type description. Set `fields` for a struct kind or
 * `underlying` for an alias kind, never both.
 */
export interface Blueprint {
  /** The object type name this blueprint defines (ASCII, non-empty). */
  type: string;
  /** Struct kind: the ordered fields. Omit (or empty) for an alias. */
  fields?: Field[];
  /** Alias kind: the underlying primitive name. Omit for a struct. */
  underlying?: string;
}

/** The carrier type tag for each {@link Spec} kind. */
const SPEC_TYPE: Record<Spec['kind'], string> = {
  primitive: 'astral.blueprint.primitive_spec',
  ref: 'astral.blueprint.ref_spec',
  slice: 'astral.blueprint.slice_spec',
  array: 'astral.blueprint.array_spec',
  map: 'astral.blueprint.map_spec',
  ptr: 'astral.blueprint.ptr_spec',
  object: 'astral.blueprint.object_spec',
};

/** The nested `{ Type, Object }` container for a field's interface-typed Spec slot. */
interface SpecEnvelope {
  Type: string;
  Object: Record<string, unknown>;
}

/** Encode a {@link Spec} to its wire envelope. */
function specToWire(spec: Spec): SpecEnvelope {
  const Type = SPEC_TYPE[spec.kind];
  switch (spec.kind) {
    case 'primitive':
      return { Type, Object: { PrimitiveType: spec.primitiveType } };
    case 'ref':
    case 'ptr':
      return { Type, Object: { Type: spec.type } };
    case 'slice':
      return { Type, Object: { Type: spec.type ?? '' } };
    case 'array':
      return { Type, Object: { Type: spec.type ?? '', Length: spec.length } };
    case 'map':
      return { Type, Object: { KeyType: spec.keyType, ValueType: spec.valueType ?? '' } };
    case 'object':
      return { Type, Object: {} };
  }
}

/** Decode a Spec wire envelope back to a {@link Spec}. */
function specFromWire(env: unknown): Spec {
  if (typeof env !== 'object' || env === null) {
    throw new EncodingError(`invalid spec envelope: ${JSON.stringify(env)}`);
  }
  const { Type, Object: o } = env as { Type?: string; Object?: Record<string, unknown> };
  const obj = o ?? {};
  switch (Type) {
    case SPEC_TYPE.primitive:
      return { kind: 'primitive', primitiveType: obj.PrimitiveType as PrimitiveType };
    case SPEC_TYPE.ref:
      return { kind: 'ref', type: obj.Type as string };
    case SPEC_TYPE.ptr:
      return { kind: 'ptr', type: obj.Type as string };
    case SPEC_TYPE.slice:
      return { kind: 'slice', type: (obj.Type as string) || undefined };
    case SPEC_TYPE.array:
      return { kind: 'array', type: (obj.Type as string) || undefined, length: Number(obj.Length) };
    case SPEC_TYPE.map:
      return {
        kind: 'map',
        keyType: obj.KeyType as string,
        valueType: (obj.ValueType as string) || undefined,
      };
    case SPEC_TYPE.object:
      return { kind: 'object' };
    default:
      throw new EncodingError(`unknown spec carrier: ${JSON.stringify(Type)}`);
  }
}

/**
 * Build the `astral.blueprint` JSON value for a {@link Blueprint} descriptor.
 *
 * Emits all three keys — `Type`, `Fields`, `Underlying` — always: a struct
 * carries its fields and an empty `Underlying`; an alias carries an empty
 * `Fields` array and its `Underlying` primitive. Each field's `Spec` is the
 * nested carrier container.
 *
 * @param blueprint The descriptor to encode.
 * @returns The value for the `Object` half of a `{ Type, Object }` envelope.
 */
export function blueprintToValue(blueprint: Blueprint): unknown {
  return {
    Type: blueprint.type,
    Fields: (blueprint.fields ?? []).map((f) => ({ Name: f.name, Spec: specToWire(f.spec) })),
    Underlying: blueprint.underlying ?? '',
  };
}

/**
 * Decode an `astral.blueprint` JSON value into a {@link Blueprint} descriptor.
 *
 * The inverse of {@link blueprintToValue}: a non-empty `Underlying` yields an
 * alias descriptor, otherwise a struct descriptor whose fields carry decoded
 * {@link Spec}s.
 *
 * @param value The value from an `astral.blueprint` object.
 * @returns The decoded {@link Blueprint}.
 * @throws {EncodingError} On a malformed value or an unknown Spec carrier.
 */
export function blueprintFromValue(value: unknown): Blueprint {
  if (typeof value !== 'object' || value === null) {
    throw new EncodingError(`invalid blueprint value: ${JSON.stringify(value)}`);
  }
  const v = value as { Type?: string; Fields?: unknown; Underlying?: string };
  if (typeof v.Type !== 'string' || v.Type.length === 0) {
    throw new EncodingError('blueprint value missing Type');
  }
  const underlying = v.Underlying ?? '';
  if (underlying.length > 0) return { type: v.Type, underlying };

  const rawFields = Array.isArray(v.Fields) ? v.Fields : [];
  const fields: Field[] = rawFields.map((f) => {
    const { Name, Spec } = f as { Name?: string; Spec?: unknown };
    if (typeof Name !== 'string') throw new EncodingError('field missing Name');
    return { name: Name, spec: specFromWire(Spec) };
  });
  return { type: v.Type, fields };
}
