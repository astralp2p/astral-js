/**
 * The crypto protocol client — derive a public key, sign text and a hash, and
 * verify the signatures.
 *
 * Run against a real node:  npx tsx examples/crypto.ts
 */
import { connect } from 'astral-js';
import { Crypto } from 'astral-js/api/crypto';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });
const crypto = new Crypto(host);

// Public keys and signatures are compact "<scheme>:<hex-or-base64>" strings.
const key = await crypto.publicKey();
console.log(`public key = ${key}`);

const sig = await crypto.signText('hello world');
console.log(`signature = ${sig}`);

const valid = await crypto.verifyTextSignature('hello world', sig, key);
console.log(`valid? = ${valid}`);

// Hash signing takes a hex digest instead of the text itself — e.g. an
// object's content hash (sha-256 of 'hello world' here).
const digest = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
const hashSig = await crypto.signHash(digest);
console.log(`hash signature = ${hashSig}`);

const hashValid = await crypto.verifyHashSignature(digest, hashSig, key);
console.log(`hash valid? = ${hashValid}`);
