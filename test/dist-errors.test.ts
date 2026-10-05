import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Options } from 'tsup';
import config from '../tsup.config.js';
import { parseIdentity } from '../src/astral/identity.js';
import type { Session, Transport } from '../src/apphost/session.js';

// The other tests run against src/, where every entry shares one module graph.
// This one builds the package with the real tsup config and checks that an
// error thrown from a subpath entry passes `instanceof` against the class
// imported from the root entry, in both ESM and CJS.

const NODE = parseIdentity('02' + 'a'.repeat(64));
const GUEST = parseIdentity('02' + 'c'.repeat(64));

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'astral-js-dist-'));
  await build({
    ...(config as Options),
    outDir,
    dts: false,
    sourcemap: false,
    silent: true,
  });
}, 180_000);

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

/** A transport that accepts the query, streams one `error_message`, then closes. */
function erroringTransport(QueryAccepted: string): Transport {
  const queue = [
    { type: QueryAccepted, value: {} },
    { type: 'error_message', value: 'boom' },
  ];
  return {
    async open() {
      return {
        hostInfo: { identity: NODE, alias: 'node' },
        guestID: GUEST,
        send() {},
        async recv() {
          return queue.shift() ?? null;
        },
        close() {},
      } as unknown as Session;
    },
  };
}

/** The built entries, typed by the sources they are built from. */
interface Modules {
  root: typeof import('../src/index.js');
  apphost: typeof import('../src/apphost/index.js');
  objects: typeof import('../src/api/objects/index.js');
}

async function thrownFromSubpath({ apphost, objects }: Modules): Promise<unknown> {
  const host = new apphost.Host(
    erroringTransport(apphost.MessageTypes.QueryAccepted),
    NODE,
    'node',
    GUEST,
  );
  try {
    for await (const _ of await new objects.Objects(host).search('x')) void _;
  } catch (err) {
    return err;
  }
  throw new Error('search did not throw');
}

describe('error classes across entries', () => {
  it('ESM: a subpath error is an instance of the root class', async () => {
    const load = (p: string) => import(pathToFileURL(join(outDir, p)).href);
    const mods: Modules = {
      root: await load('index.mjs'),
      apphost: await load('apphost/index.mjs'),
      objects: await load('api/objects/index.mjs'),
    };
    const err = await thrownFromSubpath(mods);
    expect(err).toBeInstanceOf(mods.root.RemoteError);
    expect(err).toBeInstanceOf(mods.root.AstralError);
    expect(mods.root.RemoteError).toBe((await load('astral/index.mjs')).RemoteError);
  });

  it('CJS: a subpath error is an instance of the root class', async () => {
    const require = createRequire(join(outDir, 'index.cjs'));
    const mods: Modules = {
      root: require('./index.cjs'),
      apphost: require('./apphost/index.cjs'),
      objects: require('./api/objects/index.cjs'),
    };
    const err = await thrownFromSubpath(mods);
    expect(err).toBeInstanceOf(mods.root.RemoteError);
    expect(err).toBeInstanceOf(mods.root.AstralError);
    expect(mods.root.RemoteError).toBe(require('./astral/index.cjs').RemoteError);
  });
});
