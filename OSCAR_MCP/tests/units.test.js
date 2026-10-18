// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/** units.test.js — configuration, tools and protocol of the OSCAR MCP server (#503 PR 3). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { configFrom, originOf, keyOf } = require('../src/config');
const { TOOLS, pathFor, listed, toolNamed } = require('../src/tools');
const { handle, handleLine, toolAnswer, PROTOCOL_VERSIONS, MAX_TEXT_ANSWER } = require('../src/protocol');
const { getFromOscar } = require('../src/client');

const KEY = `oscar_abcdef12_${'A'.repeat(43)}`;

test('OSCAR_URL: https anywhere, http on this machine only, the address alone', () => {
  assert.deepEqual(originOf('https://oscar.example'), { origin: 'https://oscar.example' });
  assert.deepEqual(originOf(' https://oscar.example/ '), { origin: 'https://oscar.example' });
  assert.deepEqual(originOf('http://127.0.0.1:3000'), { origin: 'http://127.0.0.1:3000' });
  assert.deepEqual(originOf('http://localhost:3000'), { origin: 'http://localhost:3000' });
  assert.deepEqual(originOf('http://[::1]:3000'), { origin: 'http://[::1]:3000' });
  for (const bad of [undefined, '', 'oscar.example', 'http://oscar.example', 'ftp://oscar.example', 'https://u:p@oscar.example',
    'https://oscar.example/v1/api', 'https://oscar.example/?x=1', 'https://oscar.example/#a', 'http://127.0.0.2', 'file:///etc/passwd']) {
    assert.ok(originOf(bad).error, `${bad} should be refused`);
  }
});

test('OSCAR_API_KEY: an OSCAR key or nothing, and the refusal never quotes it', () => {
  assert.deepEqual(keyOf(` ${KEY}\n`), { key: KEY });
  for (const bad of [undefined, '', 'eyJhbGciOi.x.y', `${KEY}x`, KEY.replace('abcdef12', 'ABCDEF12'), `Bearer ${KEY}`]) {
    const r = keyOf(bad);
    assert.ok(r.error);
    if (typeof bad === 'string' && bad) assert.ok(!r.error.includes(bad.trim()));
  }
  const both = configFrom({ OSCAR_URL: 'http://oscar.example', OSCAR_API_KEY: 'secret-value-123' });
  assert.equal(both.errors.length, 2);
  assert.ok(!JSON.stringify(both).includes('secret-value-123'));
  assert.deepEqual(configFrom({ OSCAR_URL: 'https://oscar.example', OSCAR_API_KEY: KEY }), { origin: 'https://oscar.example', key: KEY });
});

test('one tool per read route, all read-only, every path under /v1/api', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['oscar_key', 'oscar_list_runs', 'oscar_get_run', 'oscar_get_run_checks', 'oscar_get_batch', 'oscar_get_queue']);
  for (const t of listed()) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(!('path' in t));
  }
});

test('arguments become one path, checked first', () => {
  const p = (name, args) => pathFor(toolNamed(name), args);
  assert.deepEqual(p('oscar_key'), { path: '/v1/api/key' });
  assert.deepEqual(p('oscar_list_runs', {}), { path: '/v1/api/runs' });
  assert.deepEqual(p('oscar_list_runs', { limit: 5, offset: 10, status: 'FAILED', scenario_code: 'OTST A&B' }),
    { path: '/v1/api/runs?limit=5&offset=10&status=FAILED&scenario_code=OTST+A%26B' });
  assert.deepEqual(p('oscar_get_run', { run_id: '3f2a-b1' }), { path: '/v1/api/runs/3f2a-b1' });
  assert.deepEqual(p('oscar_get_run_checks', { run_id: 'r1', result: 'failed' }), { path: '/v1/api/runs/r1/assertions?result=failed' });
  assert.deepEqual(p('oscar_get_batch', { batch_id: 'b.1' }), { path: '/v1/api/batches/b.1' });
  assert.deepEqual(p('oscar_get_queue', null), { path: '/v1/api/queue' });

  for (const [name, args] of [
    ['oscar_list_runs', { limit: 0 }], ['oscar_list_runs', { limit: 201 }], ['oscar_list_runs', { limit: '5' }], ['oscar_list_runs', { limit: 2.5 }],
    ['oscar_list_runs', { offset: -1 }], ['oscar_list_runs', { status: 'DELETED' }], ['oscar_list_runs', { batch_id: '' }],
    ['oscar_list_runs', { scenario_code: 'x'.repeat(201) }], ['oscar_list_runs', { company_id: 'other' }], ['oscar_list_runs', []],
    ['oscar_get_run', {}], ['oscar_get_run', { run_id: '..' }], ['oscar_get_run', { run_id: '../admin' }], ['oscar_get_run', { run_id: 'a/b' }],
    ['oscar_get_run', { run_id: 'a b' }], ['oscar_get_run', { run_id: '%2e%2e' }], ['oscar_get_run', { run_id: 42 }], ['oscar_get_run', { run_id: 'x'.repeat(201) }],
    ['oscar_get_run_checks', { run_id: 'r1', result: 'all' }], ['oscar_get_batch', { batch_id: '.hidden' }], ['oscar_key', { x: 1 }], ['oscar_get_queue', 'x'],
  ]) {
    assert.ok(pathFor(toolNamed(name), args).error, `${name} ${JSON.stringify(args)} should be refused`);
  }
});

test('initialize agrees on a version, lists the tools, and answers nothing to a notification', async () => {
  const none = () => { throw new Error('no call expected'); };
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, none);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'oscar');
  const later = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, none);
  assert.equal(later.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, none), null);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' }, none)).result, {});
  assert.equal((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, none)).result.tools.length, 6);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, none)).error.code, -32601);
  assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'oscar_delete_run' } }, none)).error.code, -32602);
  assert.equal((await handle({ id: 7, method: 'ping' }, none)).error.code, -32600);
  assert.equal((await handleLine('{not json', none)).error.code, -32700);
  assert.equal((await handleLine('[]', none)).error.code, -32600);
});

test('a call reaches OSCAR only with arguments that passed, and a refusal is a tool error', async () => {
  const asked = [];
  const call = async (path) => { asked.push(path); return { status: 200, body: { ok: true } }; };
  const ok = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oscar_get_run', arguments: { run_id: 'r1' } } }, call);
  assert.equal(ok.result.isError, false);
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { ok: true });
  const bad = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oscar_get_run', arguments: { run_id: '../x' } } }, call);
  assert.equal(bad.result.isError, true);
  assert.deepEqual(asked, ['/v1/api/runs/r1']);
  const batch = await handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]), call);
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 9, result: {} }]);
});

test('OSCAR\'s refusals read as sentences, and a large answer is cut with advice', () => {
  assert.match(toolAnswer({ status: 401, body: {} }).content[0].text, /refused the API key/);
  assert.match(toolAnswer({ status: 404, body: { detail: 'No such run.' } }).content[0].text, /HTTP 404\. No such run\./);
  assert.match(toolAnswer({ status: 429, body: { detail: 'wait' } }).content[0].text, /slow down/);
  assert.equal(toolAnswer({ failure: 'OSCAR could not be reached.' }).isError, true);
  const big = toolAnswer({ status: 200, body: { x: 'y'.repeat(MAX_TEXT_ANSWER + 10) } });
  assert.equal(big.isError, false);
  assert.match(big.content[0].text, /cut at 100000 characters/);
});

test('the client: GET only, the key in the header, no redirect, nothing outside /v1/api', async () => {
  const config = { origin: 'https://oscar.example', key: KEY };
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return new Response('{"a":1}', { status: 200 }); };
  assert.deepEqual(await getFromOscar(config, '/v1/api/key', { fetchImpl }), { status: 200, body: { a: 1 } });
  assert.equal(seen.url, 'https://oscar.example/v1/api/key');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);

  for (const path of ['/v1/company/api-keys', '//evil.example/v1/api/key', '/v1/api/../company', 'https://evil.example/v1/api/key']) {
    seen = null;
    assert.ok((await getFromOscar(config, path, { fetchImpl })).failure, path);
    assert.equal(seen, null, `${path} must not be fetched`);
  }
  const redirect = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } });
  assert.match((await getFromOscar(config, '/v1/api/key', { fetchImpl: redirect })).failure, /redirect/);
  const html = async () => new Response('<html>', { status: 200 });
  assert.match((await getFromOscar(config, '/v1/api/key', { fetchImpl: html })).failure, /not JSON/);
  const huge = async () => new Response('x'.repeat(2000), { status: 200 });
  assert.match((await getFromOscar(config, '/v1/api/key', { fetchImpl: huge, maxBytes: 1000 })).failure, /was not read/);
  const down = async () => { throw new TypeError(`fetch failed ${KEY}`); };
  const failed = await getFromOscar(config, '/v1/api/key', { fetchImpl: down });
  assert.equal(failed.failure, 'OSCAR could not be reached.');
  const slow = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  // AbortSignal.timeout() does not keep the process alive on its own.
  const alive = setTimeout(() => {}, 5000);
  assert.match((await getFromOscar(config, '/v1/api/key', { fetchImpl: slow, timeoutMs: 20 })).failure, /did not answer/);
  clearTimeout(alive);
});
