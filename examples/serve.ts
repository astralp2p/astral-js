/**
 * Register a handler for inbound queries and respond to callers.
 *
 * Each inbound query is an IncomingQuery: accept() it (returning a responder
 * stream) or reject(code). You have ~5 seconds to respond.
 */
import { connect, obj, eos } from 'astral-js';

const ENDPOINT = 'ws://127.0.0.1:8624/.ws';
const TOKEN = '…';

const host = await connect(ENDPOINT, { token: TOKEN });

const reg = await host.register(host.guestID ?? host.identity ?? 'anyone', async (q) => {
  console.log('incoming', q.caller, '→', q.query, q.params);

  if (q.query.startsWith('forbidden')) {
    q.reject(1);
    return;
  }

  const stream = await q.accept();
  stream.send(obj('string8', `hello, ${q.caller}`));
  stream.send(eos());
  stream.close();
});

console.log('serving as', host.guestID ?? host.identity);

// The registration stays live until you call reg.unregister() (or the process
// ends). In a long-running app, keep the process alive and unregister on
// shutdown, e.g. process.on('SIGINT', () => reg.unregister()).
void reg;
