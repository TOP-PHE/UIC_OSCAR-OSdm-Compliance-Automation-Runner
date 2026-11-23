// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A kept run pod sends its run's output to the internal port (#1309; part 2 =
 * #1318): in order, in numbered batches, sent again while the server cannot
 * take it.
 */

const { OutputSender, piecesOf, MAX_BATCH_BYTES } = require('../../src/run-pod/outputSender');
const { reasonOf } = require('../../src/run-pod/runPod');

const URL = 'http://internal.example/v1/runs/r/output';
const SECRET = 'a'.repeat(64);

// A server that answers each batch with the next status of `statuses` (200 once they are spent).
function serverOf(statuses = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const status = statuses.length > 0 ? statuses.shift() : 200;
    if (status instanceof Error) throw status;
    return { status };
  };
  return { calls, fetchImpl };
}

function senderOf(server, extra = {}) {
  const lines = [];
  const pauses = [];
  const sender = new OutputSender({
    url: URL, secret: SECRET, fetchImpl: server.fetchImpl, reasonOf,
    log: (l) => lines.push(l), sleep: async (ms) => { pauses.push(ms); }, flushMs: 10_000, ...extra,
  });
  return { sender, lines, pauses };
}

const textOf = (calls, stream) => calls.flatMap((c) => c.body.parts).filter(([s]) => s === stream).map(([, t]) => t).join('');

describe('the run\'s output', () => {
  test('the parts keep their order and their stream; one stream\'s chunks in a row are one part', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    sender.push('out', Buffer.from('a'));
    sender.push('out', Buffer.from('b'));
    sender.push('err', Buffer.from('c'));
    sender.push('out', Buffer.from('d'));
    expect(await sender.end()).toEqual({ batches: 1, leftOut: 0 });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].body).toEqual({ seq: 0, parts: [['out', 'ab'], ['err', 'c'], ['out', 'd']] });
  });

  test('sent with the run\'s secret, as JSON, never following a redirect', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    sender.push('out', Buffer.from('x'));
    await sender.end();
    const { url, init } = server.calls[0];
    expect(url).toBe(URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'X-OSCAR-Run-Secret': SECRET, 'Content-Type': 'application/json' } });
  });

  test('a character cut between two chunks arrives whole', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    const bytes = Buffer.from('é€😀');
    for (let i = 0; i < bytes.length; i++) sender.push(i % 2 ? 'out' : 'out', bytes.subarray(i, i + 1));
    const err = Buffer.from('ü');
    sender.push('err', err.subarray(0, 1));
    await sender.end();
    expect(textOf(server.calls, 'out')).toBe('é€😀');
    expect(textOf(server.calls, 'err')).toBe(String.fromCodePoint(0xFFFD));   // a cut character at the very end is replaced (written by its code: #1412)
  });

  test('much output goes in batches of at most 64 KB, numbered, in order', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    const text = Array.from({ length: 30000 }, (_, i) => `line ${i} ✓\n`).join('');
    const buffer = Buffer.from(text);
    for (let at = 0; at < buffer.length; at += 4000) sender.push(at % 8000 ? 'out' : 'out', buffer.subarray(at, at + 4000));
    const { batches } = await sender.end();
    expect(batches).toBeGreaterThan(4);
    expect(server.calls.map((c) => c.body.seq)).toEqual([...Array(batches).keys()]);
    for (const call of server.calls) expect(Buffer.byteLength(call.body.parts.map(([, t]) => t).join(''))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(textOf(server.calls, 'out')).toBe(text);
  });

  test('64 KB waiting go at once, without waiting for the flush time', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    sender.push('out', Buffer.from('x'.repeat(MAX_BATCH_BYTES + 10)));
    await new Promise((r) => setImmediate(r));
    expect(server.calls.length).toBeGreaterThan(0);
    await sender.end();
  });

  test('a little output goes after the flush time, without waiting for the end', async () => {
    const server = serverOf();
    const { sender } = senderOf(server, { flushMs: 20 });
    sender.push('err', Buffer.from('soon'));
    const until = Date.now() + 2000;
    while (server.calls.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(server.calls[0].body).toEqual({ seq: 0, parts: [['err', 'soon']] });
    await sender.end();
    expect(server.calls).toHaveLength(1);
  });

  test('a server that cannot take it yet gets the same batch again', async () => {
    const server = serverOf([503, new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), 200, 200]);
    const { sender, pauses } = senderOf(server);
    sender.push('out', Buffer.from('first'));
    sender.flush();
    sender.push('out', Buffer.from('second'));
    await sender.end();
    expect(server.calls.map((c) => c.body)).toEqual([
      { seq: 0, parts: [['out', 'first']] }, { seq: 0, parts: [['out', 'first']] }, { seq: 0, parts: [['out', 'first']] },
      { seq: 1, parts: [['out', 'second']] },
    ]);
    expect(pauses).toEqual([1000, 2000]);
  });

  test('the pauses are the run\'s: once spent, the rest is not sent, and the pod says so', async () => {
    const server = serverOf([503, 503, 503, 503, 503]);
    const { sender, lines } = senderOf(server);
    sender.push('out', Buffer.from('lost'));
    sender.flush();
    sender.push('err', Buffer.from('lost too'));
    expect(await sender.end()).toEqual({ batches: 0, leftOut: 12 });
    expect(server.calls).toHaveLength(5);
    expect(lines).toEqual([
      '[kept-pod] the run\'s output is not sent any more (HTTP 503)',
      '[kept-pod] 12 bytes of the run\'s output were not sent',
    ]);
  });

  test('a refusal is not sent again, nor anything after it', async () => {
    for (const status of [400, 403, 409, 413, 500]) {
      const server = serverOf([status]);
      const { sender, pauses } = senderOf(server);
      sender.push('out', Buffer.from('refused'));
      sender.flush();
      sender.push('out', Buffer.from('after'));
      expect(await sender.end()).toEqual({ batches: 0, leftOut: 12 });
      expect(server.calls).toHaveLength(1);
      expect(pauses).toEqual([]);
    }
  });

  test('output that has not gone yet is kept up to its limit; the newest is left out', async () => {
    const server = serverOf();
    const { sender } = senderOf(server, { maxPendingBytes: 10, maxBatchBytes: 1000 });
    sender.push('out', Buffer.from('12345678'));
    sender.push('out', Buffer.from('abc'));
    sender.push('out', Buffer.from('xy'));
    expect(await sender.end()).toEqual({ batches: 1, leftOut: 3 });
    expect(textOf(server.calls, 'out')).toBe('12345678xy');
  });

  test('a stream that is not out or err is ignored', async () => {
    const server = serverOf();
    const { sender } = senderOf(server);
    sender.push('in', Buffer.from('nothing'));
    expect(await sender.end()).toEqual({ batches: 0, leftOut: 0 });
    expect(server.calls).toEqual([]);
  });
});

describe('piecesOf()', () => {
  test('never cuts a character made of two code units', () => {
    const text = '😀'.repeat(10);
    for (let max = 1; max <= 7; max++) {
      const pieces = piecesOf(text, max);
      expect(pieces.join('')).toBe(text);
      for (const piece of pieces) expect(piece.isWellFormed()).toBe(true);
    }
    expect(piecesOf('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(piecesOf('', 4)).toEqual([]);
  });
});
