/**
 * The crypto protocol client — derive a public key, sign text, and verify a
 * signature.
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
console.log('public key =', key);

const sig = await crypto.signText('hello world');
console.log('signature  =', sig);

const valid = await crypto.verifyTextSignature('hello world', sig, key);
console.log('valid?     =', valid);
