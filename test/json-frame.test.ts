import { describe, expect, it } from 'vitest';
import { JsonWsSession, encodeFrame } from '../src/apphost/session.js';
import { Receiver } from '../src/apphost/receiver.js';
import type { WebSocketLike } from '../src/apphost/transport.js';

/** A WebSocketLike that records every frame written to it. */
function recordingSocket(): WebSocketLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
    close() {},
    readyState: 1,
    addEventListener() {},
  };
}

describe('JSON frame encoding', () => {
  it('terminates every envelope with a newline', () => {
    expect(encodeFrame({ Type: 'ack', Object: null })).toBe('{"Type":"ack","Object":null}\n');
  });

  it('writes each sent object as one newline-terminated envelope', () => {
    const ws = recordingSocket();
    const session = new JsonWsSession(ws, new Receiver(ws), { identity: null, alias: 'node' }, null);

    session.send({ type: 'astral.string8', value: 'pong' });
    session.send({ type: 'eos', value: null });

    expect(ws.sent).toEqual([
      '{"Type":"astral.string8","Object":"pong"}\n',
      '{"Type":"eos","Object":null}\n',
    ]);
  });

  it('concatenates into the NDJSON byte stream astrald re-frames on newlines', () => {
    // astrald reads a guest socket as a byte stream and relays a responder's
    // bytes verbatim to the caller, whose wsConn.Write splits them on '\n'. An
    // envelope with no terminator never leaves that buffer.
    const ws = recordingSocket();
    const session = new JsonWsSession(ws, new Receiver(ws), { identity: null, alias: 'node' }, null);

    session.send({ type: 'astral.string8', value: 'pong' });
    session.send({ type: 'eos', value: null });

    const stream = ws.sent.join('');
    expect(stream.endsWith('\n')).toBe(true);
    expect(stream.split('\n').filter((line) => line !== '')).toHaveLength(2);
  });
});
