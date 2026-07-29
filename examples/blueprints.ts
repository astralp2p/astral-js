/**
 * The objects protocol client — define an object type with a blueprint, store
 * an instance of it, and read the type back.
 *
 * Run against a real node:  npx tsx examples/blueprints.ts
 */
import { connect } from 'astral-js';
import { obj } from 'astral-js/astral';
import { Objects } from 'astral-js/api/objects';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });
const objects = new Objects(host);

// Describe a two-field struct type and register it with the node.
// Registration is node-memory-only (does not survive a restart) and
// unauthenticated (any peer can claim a type name).
const [blueprintID] = await objects.registerBlueprint({
  type: 'example.message',
  fields: [
    { name: 'Author', spec: { kind: 'primitive', primitiveType: 'identity' } },
    { name: 'Body', spec: { kind: 'primitive', primitiveType: 'string16' } },
  ],
});
console.log(`registered blueprint = ${blueprintID}`);

// Read the type back — a consumer that did not define it can too.
const blueprint = await objects.getBlueprint('example.message');
console.log(`blueprint = ${JSON.stringify(blueprint)}`);

// Store an instance; the node reports it under the registered type.
const [id] = await objects.store([
  obj('example.message', { Author: host.identity, Body: 'hello blueprint' }),
]);
console.log(`stored = ${id}`);
console.log(`type = ${await objects.getType(id)}`); // 'example.message'
console.log(`loaded = ${JSON.stringify(await objects.load(id))}`);
