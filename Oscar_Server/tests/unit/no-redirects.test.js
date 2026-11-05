// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The server's own calls to a provider never follow a redirect. Two real
 * local servers: the first answers 302 to the second, which must never be
 * reached.
 */

const http = require('node:http');

const { osdmGet } = require('../../src/utils/osdm-client');
const { fetchToken } = require('../../src/worker/auth-profiles');

const quiet = { info() {}, error() {}, warn() {}, debug() {} };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

let target;
let redirector;
let targetHits;

beforeAll(async () => {
  targetHits = [];
  target = await listen((req, res) => {
    targetHits.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"access_token":"t","token_type":"Bearer","places":[]}');
  });
  redirector = await listen((req, res) => {
    res.writeHead(302, { Location: `${baseOf(target)}/stolen${req.url}` });
    res.end();
  });
});

afterAll(async () => {
  await new Promise((r) => redirector.close(r));
  await new Promise((r) => target.close(r));
});

beforeEach(() => { targetHits.length = 0; });

test('an OSDM read (stop places, versions) answers the redirect and does not follow it', async () => {
  const r = await osdmGet(baseOf(redirector), '/places', 'secret-token', { 'Ocp-Apim-Subscription-Key': 'key' });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(302);
  expect(targetHits).toEqual([]);
});

test('a token request answered by a redirect fails with a plain reason, nothing sent further', async () => {
  const ctx = { tokenUrl: `${baseOf(redirector)}/oauth/token`, clientId: 'id', clientSecret: 'client-secret', scope: '' };
  await expect(fetchToken('oauth2_basic', ctx, quiet)).rejects.toThrow(/redirect \(HTTP 302\).*does not follow/);
  await expect(fetchToken('oauth2_post', ctx, quiet)).rejects.toThrow(/does not follow/);
  expect(targetHits).toEqual([]);
});

test('the same calls still work without a redirect (the guard does not get in the way)', async () => {
  const r = await osdmGet(baseOf(target), '/places', 'secret-token');
  expect(r.ok).toBe(true);
  const ctx = { tokenUrl: `${baseOf(target)}/oauth/token`, clientId: 'id', clientSecret: 's', scope: '' };
  await expect(fetchToken('oauth2_basic', ctx, quiet)).resolves.toBeTruthy();
  expect(targetHits).toHaveLength(2);
});
