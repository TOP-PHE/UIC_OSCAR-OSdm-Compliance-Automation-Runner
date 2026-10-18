// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mcp-end-to-end.test.js — #503 PR 3: the OSCAR MCP server (OSCAR_MCP/)
 * against the real read-only API, with a real key.
 *
 *   - its tools and the GET routes of /v1/api in the OpenAPI description are
 *     the same set: a new API route needs its tool, and a tool cannot reach a
 *     route the API does not describe;
 *   - through it, a key reads its own company's run and nothing more: another
 *     company's run is the API's 404, and the key never shows in its output.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { run } = require('../../src/db/db');
const K = require('../../src/utils/apiKeys');
const openapi = require('../../src/api/openapi');
const { TOOLS, pathFor } = require('../../../OSCAR_MCP/src/tools');

const MCP = path.resolve(__dirname, '../../../OSCAR_MCP/server.js');

const SAMPLE_ARGS = {
  oscar_key: {}, oscar_list_runs: {}, oscar_get_run: { run_id: 'R' }, oscar_get_run_checks: { run_id: 'R' },
  oscar_get_batch: { batch_id: 'B' }, oscar_get_queue: {},
};

test('every tool is one GET route of /v1/api in the OpenAPI description, and every such route has its tool', () => {
  const apiGets = Object.entries(openapi.paths).filter(([p, ops]) => p.startsWith('/v1/api/') && ops.get).map(([p]) => p);
  const asTemplate = (p) => p.split('?')[0].replace(/\/R(?=\/|$)/, '/{id}').replace(/\/B$/, '/{batchId}');
  const toolPaths = TOOLS.map(t => asTemplate(pathFor(t, SAMPLE_ARGS[t.name]).path));
  expect(new Set(toolPaths)).toEqual(new Set(apiGets));
  expect(toolPaths).toHaveLength(apiGets.length);
  for (const p of apiGets) expect(Object.keys(openapi.paths[p])).toEqual(['get']);
});

describe('through the MCP server, against the real API', () => {
  const companyId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const tm = { id: crypto.randomUUID(), email: `mcp-${companyId.slice(0, 8)}@e2e.test` };
  const ownRun = crypto.randomUUID();
  const otherRun = crypto.randomUUID();
  let key;
  let server;
  let origin;

  beforeAll(async () => {
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'MCP Co', ?)`, [companyId, `mcp-${companyId.slice(0, 8)}`]);
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'MCP Other', ?)`, [otherId, `mcp-o-${otherId.slice(0, 8)}`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [tm.id, companyId, tm.email]);
    run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code) VALUES (?, ?, ?, 'COMPLETED', 'OTST_MCP')`, [ownRun, companyId, tm.id]);
    run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code) VALUES (?, ?, ?, 'COMPLETED', 'OTST_OTHER')`, [otherRun, otherId, tm.id]);
    const made = K.newKey();
    run(`INSERT INTO api_key (id, company_id, created_by, name, prefix, secret_hash, scopes, expires_at)
         VALUES (?, ?, ?, 'mcp', ?, ?, 'runs:read', ?)`,
    [crypto.randomUUID(), companyId, tm.id, made.prefix, made.secretHash, K.expiryAfter(1)]);
    key = made.key;

    const app = express();
    app.use('/v1/api', require('../../src/api/routes/api'));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  function session(messages) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [MCP], { env: { PATH: process.env.PATH, OSCAR_URL: origin, OSCAR_API_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out, err, byId: Object.fromEntries(out.split('\n').filter(Boolean).map(l => JSON.parse(l)).map(a => [a.id, a])) }));
      for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
      child.stdin.end();
    });
  }
  const callTool = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  test('the key\'s own run is read, another company\'s is the API\'s 404, and the key is never written', async () => {
    const { code, out, err, byId } = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      callTool(2, 'oscar_key', {}),
      callTool(3, 'oscar_list_runs', {}),
      callTool(4, 'oscar_get_run', { run_id: ownRun }),
      callTool(5, 'oscar_get_run', { run_id: otherRun }),
      callTool(6, 'oscar_get_run_checks', { run_id: ownRun, result: 'failed' }),
      callTool(7, 'oscar_get_queue', {}),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(byId[2].result.content[0].text).company).toEqual({ id: companyId, name: 'MCP Co' });
    expect(JSON.parse(byId[3].result.content[0].text).runs.map(r => r.id)).toEqual([ownRun]);
    expect(JSON.parse(byId[4].result.content[0].text)).toMatchObject({ id: ownRun, scenario_code: 'OTST_MCP' });
    expect(byId[5].result).toMatchObject({ isError: true });
    expect(byId[5].result.content[0].text).toBe('OSCAR answered HTTP 404. No such run.');
    expect(JSON.parse(byId[6].result.content[0].text).suites).toEqual([]);
    expect(byId[7].result.isError).toBe(false);
    expect(out).not.toContain(key);
    expect(err).toBe('');
  });

  test('a revoked key stops the tools at the next call', async () => {
    run("UPDATE api_key SET revoked_at = datetime('now') WHERE prefix = ?", [K.parseKey(key).prefix]);
    const { byId } = await session([callTool(1, 'oscar_list_runs', {})]);
    expect(byId[1].result.isError).toBe(true);
    expect(byId[1].result.content[0].text).toMatch(/refused the API key/);
  });
});
