import { describe, expect, it } from 'vitest';
import { parseIdentity } from '../src/astral/index.js';
import { discoveryPermit } from '../src/api/services/index.js';

describe('discoveryPermit', () => {
  it('scopes discovery to the named services', () => {
    expect(JSON.stringify(discoveryPermit(['inference']))).toBe(
      '{"Action":"mod.services.service_discovery_action","Constraints":[{"Type":"mod.services.discovery_scope","Object":{"Rules":[{"Services":["inference"],"Nodes":[]}]}}],"Delegation":0}',
    );
  });

  it('carries the nodes', () => {
    const node = parseIdentity('02' + 'b'.repeat(64));

    const p = discoveryPermit(['inference', 'chat'], { nodes: [node] });

    expect(p.Constraints![0]!.Object).toEqual({
      Rules: [{ Services: ['inference', 'chat'], Nodes: [node] }],
    });
  });

  it.each([
    ['an empty list', []],
    ['a name with a comma', ['a,b']],
  ])('refuses %s', (_, services) => {
    expect(() => discoveryPermit(services)).toThrow(TypeError);
  });
});
