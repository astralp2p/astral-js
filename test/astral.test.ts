import { describe, test, expect } from 'vitest';
import {
  wrap,
  unwrap,
  obj,
  ack,
  eos,
  error,
  isEos,
  isAck,
  isError,
  isEmpty,
  isUntyped,
  parseIdentity,
  isAnyone,
  fingerprint,
  Anyone,
  ANYONE_KEY,
  parseObjectID,
  isObjectID,
  decodeObjectID,
  encodeObjectID,
  newNonce,
  parseNonce,
  parseZone,
  ZoneDefault,
  buildQueryString,
  toText,
  queryErrorForCode,
  readErrorMessage,
  AuthError,
  RouteNotFound,
  ProtocolError,
  EncodingError,
  blueprintToValue,
  blueprintFromValue,
} from '../src/astral/index.js';
import type { Blueprint } from '../src/astral/index.js';

describe('object envelope', () => {
  test('wrap/unwrap round-trip', () => {
    const o = obj('string8', 'hi');
    expect(wrap(o)).toEqual({ Type: 'string8', Object: 'hi' });
    expect(unwrap(wrap(o))).toEqual(o);
  });

  test('wrap normalizes undefined value to null', () => {
    expect(wrap({ type: 'x', value: undefined })).toEqual({ Type: 'x', Object: null });
  });

  test('unwrap treats a missing Object as null', () => {
    expect(unwrap({ Type: 'ack' })).toEqual({ type: 'ack', value: null });
  });

  test('constructors', () => {
    expect(ack()).toEqual({ type: 'ack', value: null });
    expect(eos()).toEqual({ type: 'eos', value: null });
    expect(error('boom')).toEqual({ type: 'error_message', value: 'boom' });
  });

  test('predicates (with astral.* aliases)', () => {
    expect(isEos(eos())).toBe(true);
    expect(isEos({ type: 'astral.eos', value: null })).toBe(true);
    expect(isAck(ack())).toBe(true);
    expect(isAck({ type: 'astral.ack', value: null })).toBe(true);
    expect(isError(error('x'))).toBe(true);
    expect(isEmpty(ack())).toBe(true);
    expect(isEmpty(obj('string8', 'hi'))).toBe(false);
    expect(isUntyped({ type: '', value: 1 })).toBe(true);
    expect(isUntyped(obj('string8', 'hi'))).toBe(false);
  });
});

describe('identity', () => {
  const hex = 'a'.repeat(66);
  test('parses 66-hex', () => {
    expect(parseIdentity(hex)).toBe(hex);
  });
  test('normalizes anyone and all-zero to Anyone', () => {
    expect(parseIdentity('anyone')).toBe(Anyone);
    expect(parseIdentity(ANYONE_KEY)).toBe(Anyone);
    expect(isAnyone(Anyone)).toBe(true);
  });
  test('rejects bad input', () => {
    expect(() => parseIdentity('nope')).toThrow();
    expect(() => parseIdentity('z'.repeat(66))).toThrow();
  });
  test('fingerprint', () => {
    expect(fingerprint(hex)).toBe('aaaaaaaa:aaaaaaaa');
    expect(fingerprint(Anyone)).toBe('anyone');
  });
});

describe('object id', () => {
  test('accepts data1… strings', () => {
    expect(isObjectID('data1abcdef')).toBe(true);
    expect(parseObjectID('data1abcdef')).toBe('data1abcdef');
  });
  test('rejects non-data1', () => {
    expect(isObjectID('nope')).toBe(false);
    expect(() => parseObjectID('nope')).toThrow();
  });
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // Reference vectors: ids produced by a live node, size/hash confirmed with
  // astral-go's ParseID. Both are 53 characters — the decoder's leading-zero
  // padding path (11 characters) is exercised, not just the full width.
  test('decodes node-produced ids to their size and digest', () => {
    const a = decodeObjectID('data1n55r4y4broyysufxq4mbgjy6brf6k31bysboxcyc8gug3quxz9srq');
    expect(a.size).toBe(45n);
    expect(hex(a.hash)).toBe('ec9a0682480016995eed2c26483c1217cacc820b060f6018734cd974df7fd88e');
    const b = decodeObjectID('data1dfgshzq9p7jtfadmrf5myzw3anezqnkq5a8qnrfhysh4womfknxkr');
    expect(b.size).toBe(50n);
    expect(hex(b.hash)).toBe('9adcbbbedea625c0d642ed60bd338122ee129dbc1dc221780b735482caa13d44');
  });
  test('encodes a decoded id back to the same string', () => {
    const id = parseObjectID('data1n55r4y4broyysufxq4mbgjy6brf6k31bysboxcyc8gug3quxz9srq');
    expect(encodeObjectID(decodeObjectID(id))).toBe(id);
  });
  test('round-trips an arbitrary size/digest pair', () => {
    const hash = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const decoded = decodeObjectID(encodeObjectID({ size: 1234567n, hash }));
    expect(decoded.size).toBe(1234567n);
    expect(decoded.hash).toEqual(hash);
  });
  test('round-trips the zero id as data1', () => {
    const zero = decodeObjectID('data1');
    expect(zero.size).toBe(0n);
    expect(zero.hash).toEqual(new Uint8Array(32));
    expect(encodeObjectID(zero)).toBe('data1');
  });
  test('rejects malformed input with EncodingError', () => {
    expect(() => decodeObjectID('nope1abc')).toThrow(EncodingError);
    expect(() => decodeObjectID('data1' + 'y'.repeat(65))).toThrow(EncodingError);
    expect(() => decodeObjectID('data1ab0cd')).toThrow(EncodingError); // '0' is not z-base-32
    expect(() => encodeObjectID({ size: -1n, hash: new Uint8Array(32) })).toThrow(EncodingError);
    expect(() => encodeObjectID({ size: 1n, hash: new Uint8Array(31) })).toThrow(EncodingError);
  });
});

describe('nonce', () => {
  test('newNonce is 16 lowercase hex chars', () => {
    const n = newNonce();
    expect(n).toMatch(/^[0-9a-f]{16}$/);
    expect(newNonce()).not.toBe(n); // overwhelmingly likely
  });
  test('parseNonce validates', () => {
    expect(parseNonce('00ff00ff00ff00ff')).toBe('00ff00ff00ff00ff');
    expect(() => parseNonce('xyz')).toThrow();
  });
});

describe('zone', () => {
  test('canonicalizes order and drops junk', () => {
    expect(parseZone('nd')).toBe('dn');
    expect(parseZone('vnd')).toBe('dvn');
    expect(parseZone('xq')).toBe('');
    expect(ZoneDefault).toBe('dvn');
  });
});

describe('encoding', () => {
  test('toText renders booleans before numbers', () => {
    expect(toText(true)).toBe('true');
    expect(toText(false)).toBe('false');
    expect(toText(42)).toBe('42');
    expect(toText('x')).toBe('x');
    expect(toText(null)).toBe('');
  });
  test('buildQueryString folds args, skips null, URI-encodes', () => {
    expect(buildQueryString('dir.resolve')).toBe('dir.resolve');
    expect(buildQueryString('dir.resolve', { name: 'alice', zone: 'dvn' })).toBe(
      'dir.resolve?name=alice&zone=dvn',
    );
    expect(buildQueryString('op', { a: null, b: 1 })).toBe('op?b=1');
    expect(buildQueryString('op', { q: 'a b&c' })).toBe('op?q=a%20b%26c');
    expect(buildQueryString('op?x=1', { y: 2 })).toBe('op?x=1&y=2');
  });
  test('buildQueryString enforces the 255-byte cap', () => {
    expect(() => buildQueryString('op', { big: 'x'.repeat(300) })).toThrow(EncodingError);
  });
});

describe('blueprint', () => {
  test('struct round-trips through the astral.blueprint value, all keys present', () => {
    const bp: Blueprint = {
      type: 'test.chat.message',
      fields: [
        { name: 'Author', spec: { kind: 'primitive', primitiveType: 'identity' } },
        { name: 'Body', spec: { kind: 'primitive', primitiveType: 'string16' } },
      ],
    };
    const value = blueprintToValue(bp) as Record<string, unknown>;
    expect(value).toEqual({
      Type: 'test.chat.message',
      Underlying: '',
      Fields: [
        {
          Name: 'Author',
          Spec: { Type: 'astral.blueprint.primitive_spec', Object: { PrimitiveType: 'identity' } },
        },
        {
          Name: 'Body',
          Spec: { Type: 'astral.blueprint.primitive_spec', Object: { PrimitiveType: 'string16' } },
        },
      ],
    });
    expect(blueprintFromValue(value)).toEqual(bp);
  });
  test('alias round-trips and omits fields', () => {
    const bp: Blueprint = { type: 'test.mode', underlying: 'uint8' };
    const value = blueprintToValue(bp) as Record<string, unknown>;
    expect(value).toEqual({ Type: 'test.mode', Fields: [], Underlying: 'uint8' });
    expect(blueprintFromValue(value)).toEqual(bp);
  });
  test('every Spec carrier round-trips, keeping ref/ptr distinct', () => {
    const bp: Blueprint = {
      type: 'test.every',
      fields: [
        { name: 'p', spec: { kind: 'primitive', primitiveType: 'uint32' } },
        { name: 'r', spec: { kind: 'ref', type: 'some.thing' } },
        { name: 'sl', spec: { kind: 'slice', type: 'object_id.sha256' } },
        { name: 'het', spec: { kind: 'slice' } },
        { name: 'ar', spec: { kind: 'array', type: 'uint8', length: 4 } },
        { name: 'mp', spec: { kind: 'map', keyType: 'string16', valueType: 'uint32' } },
        { name: 'pt', spec: { kind: 'ptr', type: 'some.thing' } },
        { name: 'ob', spec: { kind: 'object' } },
      ],
    };
    expect(blueprintFromValue(blueprintToValue(bp))).toEqual(bp);
  });
  test('rejects a malformed value and an unknown carrier', () => {
    expect(() => blueprintFromValue(null)).toThrow(EncodingError);
    expect(() => blueprintFromValue({ Fields: [] })).toThrow(EncodingError);
    expect(() =>
      blueprintFromValue({
        Type: 't',
        Underlying: '',
        Fields: [{ Name: 'x', Spec: { Type: 'astral.blueprint.bogus_spec', Object: {} } }],
      }),
    ).toThrow(EncodingError);
  });
});

describe('errors', () => {
  test('queryErrorForCode maps codes to classes', () => {
    expect(queryErrorForCode('auth_failed')).toBeInstanceOf(AuthError);
    expect(queryErrorForCode('route_not_found')).toBeInstanceOf(RouteNotFound);
    expect(queryErrorForCode('protocol_error')).toBeInstanceOf(ProtocolError);
    expect(queryErrorForCode('something_else')).toBeInstanceOf(ProtocolError);
  });
  test('instanceof works across the hierarchy', () => {
    expect(queryErrorForCode('auth_failed')).toBeInstanceOf(Error);
  });
  test('readErrorMessage reads error_message objects', () => {
    expect(readErrorMessage(error('boom'))).toBe('boom');
    expect(readErrorMessage(obj('string8', 'hi'))).toBeUndefined();
  });
});
