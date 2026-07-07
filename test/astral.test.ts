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
} from '../src/astral/index.js';

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
