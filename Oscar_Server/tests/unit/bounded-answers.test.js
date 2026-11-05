// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The server reads a provider's answer up to a size: a token endpoint or an
 * OSDM API answering without end is cut off with an error, and the server
 * keeps running. A real local server streams the answer.
 */

const http = require('node:http');

const { readBody } = require('../../src/utils/boundedBody');
const { osdmGet, MAX_OSDM_ANSWER_BYTES } = require('../../src/utils/osdm-client');
const { fetchToken } = require('../../src/worker/auth-profiles');

const quiet = { info() {}, error() {}, warn() {}, debug() {} };
const MB = 1024 * 1024;

let server;
let base;
let sent;

// Streams `size` bytes of a JSON string, 64 KB a write, and stops when the
// client goes away. `sent` counts what was written.
function stream(res, size) {
  const chunk = Buffer.alloc(64 * 1024, 'a');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{"access_token":"');
  sent = 0;
  const more = () => {
    while (sent < size) {
      sent += chunk.length;
      if (!res.write(chunk)) return res.once('drain', more);
    }
    res.end('"}');
  };
  res.on('close', () => { sent = Math.min(sent, size); });
  more();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const size = Number(new URL(req.url, 'http://x').searchParams.get('size'));
    stream(res, size);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('readBody()', () => {
  const answer = (text) => new Response(text);

  test('reads an answer within the size', async () => {
    expect(await readBody(answer('{"a":1}'), 100)).toBe('{"a":1}');
  });

  test('an answer of exactly the size is read', async () => {
    expect(await readBody(answer('x'.repeat(10)), 10)).toBe('x'.repeat(10));
  });

  test('a longer answer throws ANSWER_TOO_LARGE', async () => {
    await expect(readBody(answer('x'.repeat(11)), 10)).rejects.toMatchObject({ code: 'ANSWER_TOO_LARGE' });
  });

  test('no body reads as empty', async () => {
    expect(await readBody({ body: null }, 10)).toBe('');
  });
});

describe('a provider answering without end', () => {
  test('a token answer over 1 MB fails with a plain reason, and is not read to its end', async () => {
    const ctx = { tokenUrl: `${base}/token?size=${64 * MB}`, clientId: 'id', clientSecret: 's', scope: '' };
    await expect(fetchToken('oauth2_post', ctx, quiet)).rejects.toThrow(/larger than 1024 KB/);
    expect(sent).toBeLessThan(16 * MB);
  });

  test('a token answer within the size still works', async () => {
    const ctx = { tokenUrl: `${base}/token?size=${64 * 1024}`, clientId: 'id', clientSecret: 's', scope: '' };
    await expect(fetchToken('oauth2_post', ctx, quiet)).resolves.toBeTruthy();
  });

  test('an OSDM answer over the limit throws instead of filling the memory', async () => {
    await expect(osdmGet(base, `places?size=${MAX_OSDM_ANSWER_BYTES + 4 * MB}`, 'token'))
      .rejects.toMatchObject({ code: 'ANSWER_TOO_LARGE' });
  });

  test('an OSDM answer within the limit is read', async () => {
    const r = await osdmGet(base, `places?size=${MB}`, 'token');
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeGreaterThan(MB);
  });
});
