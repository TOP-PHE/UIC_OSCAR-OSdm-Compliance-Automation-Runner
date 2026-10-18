// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * process.test.js — the real server.js over stdio, against a stub OSCAR on
 * this machine (#503 PR 3): the messages an MCP client sends, what reaches
 * OSCAR, and that the key never shows in what the process writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const KEY = `oscar_0123abcd_${'k'.repeat(43)}`;

function stubOscar(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, agent: req.headers['user-agent'] });
    const [status, body, headers] = answer(req);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** Start server.js, send `messages`, close stdin; resolve with what it wrote. */
function session(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err, answers: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) }));
    for (const m of messages) child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
    child.stdin.end();
  });
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const call = (id, name, args) => rpc(id, 'tools/call', { name, arguments: args });

test('a client session: initialize, list, call; only GETs to /v1/api, with the key', async (t) => {
  const oscar = await stubOscar((req) => {
    if (req.url === '/v1/api/runs?status=FAILED') return [200, { total: 1, runs: [{ id: 'r1', status: 'FAILED' }] }];
    if (req.url === '/v1/api/runs/r1/assertions?result=failed') return [200, { run: { id: 'r1' }, suites: [] }];
    if (req.url === '/v1/api/runs/nope') return [404, { status: 404, detail: 'No such run.' }];
    if (req.url === '/v1/api/queue') return [302, '', { Location: 'https://elsewhere.example/' }];
    return [500, { detail: 'unexpected' }];
  });
  t.after(() => oscar.server.close());

  const { code, answers, out, err } = await session({ OSCAR_URL: oscar.origin, OSCAR_API_KEY: KEY }, [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(2, 'tools/list'),
    call(3, 'oscar_list_runs', { status: 'FAILED' }),
    call(4, 'oscar_get_run_checks', { run_id: 'r1', result: 'failed' }),
    call(5, 'oscar_get_run', { run_id: 'nope' }),
    call(6, 'oscar_get_run', { run_id: '../../v1/company/api-keys' }),
    call(7, 'oscar_get_queue', {}),
    rpc(8, 'tools/call', { name: 'oscar_start_run', arguments: {} }),
    'not json',
  ]);

  assert.equal(code, 0);
  const byId = Object.fromEntries(answers.map(a => [a.id, a]));
  assert.equal(byId[1].result.serverInfo.name, 'oscar');
  assert.equal(byId[2].result.tools.length, 6);
  assert.deepEqual(JSON.parse(byId[3].result.content[0].text).runs, [{ id: 'r1', status: 'FAILED' }]);
  assert.equal(byId[4].result.isError, false);
  assert.match(byId[5].result.content[0].text, /HTTP 404\. No such run\./);
  assert.equal(byId[6].result.isError, true);
  assert.match(byId[7].result.content[0].text, /redirect/);
  assert.equal(byId[8].error.code, -32602);
  assert.equal(answers.find(a => a.id === null).error.code, -32700);
  assert.equal(answers.length, 9, 'one answer per request, none for the notification');

  assert.deepEqual(oscar.seen.map(s => `${s.method} ${s.url}`), [
    'GET /v1/api/runs?status=FAILED', 'GET /v1/api/runs/r1/assertions?result=failed', 'GET /v1/api/runs/nope', 'GET /v1/api/queue']);
  for (const s of oscar.seen) {
    assert.equal(s.auth, `Bearer ${KEY}`);
    assert.match(s.agent, /^oscar-mcp\//);
  }
  assert.ok(!out.includes(KEY) && !err.includes(KEY), 'the key is never written');
  assert.equal(err, '');
});

test('a refused key is said in words, without the key', async (t) => {
  const oscar = await stubOscar(() => [401, { status: 401, detail: 'Missing, invalid, expired or revoked API key.' }]);
  t.after(() => oscar.server.close());
  const { answers, out, err } = await session({ OSCAR_URL: oscar.origin, OSCAR_API_KEY: KEY }, [call(1, 'oscar_key', {})]);
  assert.equal(answers[0].result.isError, true);
  assert.match(answers[0].result.content[0].text, /refused the API key/);
  assert.ok(!out.includes(KEY) && !err.includes(KEY));
});

test('a wrong configuration stops at start, naming the variable and never its value', async () => {
  const secret = 'not-a-key-but-secret-0001';
  const { code, out, err } = await session({ OSCAR_URL: 'http://oscar.example', OSCAR_API_KEY: secret }, [rpc(1, 'ping')]);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /OSCAR_URL must start with https:\/\//);
  assert.match(err, /OSCAR_API_KEY is not an OSCAR API key/);
  assert.ok(!err.includes(secret));
  const missing = await session({}, []);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /OSCAR_URL is not set[\s\S]*OSCAR_API_KEY is not set/);
});

test('an OSCAR that cannot be reached is a tool error, and the session goes on', async () => {
  const oscar = await stubOscar(() => [200, {}]);
  const origin = oscar.origin;
  await new Promise(r => oscar.server.close(r));
  const { code, answers } = await session({ OSCAR_URL: origin, OSCAR_API_KEY: KEY }, [call(1, 'oscar_key', {}), rpc(2, 'ping')]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(answers.map(a => [a.id, a]));
  assert.equal(byId[1].result.content[0].text, 'OSCAR could not be reached.');
  assert.deepEqual(byId[2].result, {});
});
