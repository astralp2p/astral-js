import { describe, expect, it } from 'vitest';
import { permit, toPermit, type PermitValue } from '../src/api/auth/index.js';

const SCOPE = [{ Type: 'mod.services.discovery_scope', Object: { Rules: [] } }];

describe('toPermit', () => {
  it('reads a string as an action without constraints', () => {
    expect(toPermit('mod.auth.see_objects_action')).toEqual({
      Action: 'mod.auth.see_objects_action',
      Constraints: null,
      Delegation: 0,
    });
  });

  it('keeps exactly Action, Constraints and Delegation', () => {
    const p = { Action: 'a.b', Constraints: SCOPE, Delegation: 2, Extra: 1 } as PermitValue;

    const out = toPermit(p);

    expect(Object.keys(out)).toEqual(['Action', 'Constraints', 'Delegation']);
    expect(out).toEqual({ Action: 'a.b', Constraints: SCOPE, Delegation: 2 });
    expect(out).not.toBe(p);
  });

  it('turns empty or absent constraints into null and absent delegation into 0', () => {
    expect(toPermit({ Action: 'a.b', Constraints: [] } as unknown as PermitValue)).toEqual({
      Action: 'a.b',
      Constraints: null,
      Delegation: 0,
    });
    expect(toPermit({ Action: 'a.b' } as PermitValue)).toEqual({
      Action: 'a.b',
      Constraints: null,
      Delegation: 0,
    });
  });

  it.each([
    ['an empty string', ''],
    ['an empty Action', { Action: '', Constraints: null, Delegation: 0 }],
    ['a fractional Delegation', { Action: 'a.b', Constraints: null, Delegation: 1.5 }],
    ['a negative Delegation', { Action: 'a.b', Constraints: null, Delegation: -1 }],
    ['a Delegation above 255', { Action: 'a.b', Constraints: null, Delegation: 256 }],
    ['a constraint without Type', { Action: 'a.b', Constraints: [{ Object: {} }], Delegation: 0 }],
    ['non-array Constraints', { Action: 'a.b', Constraints: { Type: 'x' }, Delegation: 0 }],
    ['null', null],
  ])('refuses %s', (_, p) => {
    expect(() => toPermit(p as unknown as PermitValue)).toThrow(TypeError);
  });
});

describe('permit', () => {
  it('builds a constrained permit', () => {
    expect(permit('a.b', SCOPE)).toEqual({ Action: 'a.b', Constraints: SCOPE, Delegation: 0 });
    expect(permit('a.b', null, { delegation: 1 })).toEqual({
      Action: 'a.b',
      Constraints: null,
      Delegation: 1,
    });
  });
});
