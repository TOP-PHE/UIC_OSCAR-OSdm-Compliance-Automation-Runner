// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The internal port (#1130): a run's calls only, each with the run's secret.
 * Its data file, the schema, the token refresh and the new result upload;
 * no session, no page, no other route.
 */

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('../../src/worker/access-token');
const { resolveAccessToken } = require('../../src/worker/access-token');
process.env.PORT = '0';
process.env.INTERNAL_PORT = '0';
const app = require('../../src/server');
const { internalApp } = app;
const { run } = require('../../src/db/db');
const runSecrets = require('../../src/utils/runSecrets');
const { encryptToFile } = require('../../src/utils/at-rest');
const runResults = require('../../src/utils/runResults');

const DATAFILES_DIR = path.resolve(__dirname, '../../data/datafiles');
const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const cleanup = [];
afterAll(() => {
  for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true });
  delete process.env.INTERNAL_PORT;
});

// A company with a data file, a tester and a run in flight with its secret.
function seedRun() {
  const C = uuidv4(), U = uuidv4(), runId = uuidv4();
  const slug = `internal-${C.slice(0, 8)}`;
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, 'https://c.example/osdm')`, [C, `Internal ${C.slice(0, 8)}`, slug]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, C, `u-${U.slice(0, 8)}@x.example`]);
  run(`INSERT INTO tester_credentials (user_id, company_id, auth_mode, access_token_enc) VALUES (?, ?, 'bearer', 'enc')`, [U, C]);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, C, U]);
  const file = path.join(DATAFILES_DIR, `${slug}-datafile.json`);
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  encryptToFile(Buffer.from(JSON.stringify({ scenariosToRun: 'ALL', scenarios: [{ code: 'A' }] })), file);
  cleanup.push(file, path.join(ARTIFACTS_DIR, runId));
  return { C, U, runId, slug, secret: runSecrets.issue(runId, C) };
}

describe('the internal port', () => {
  test('serves a run its data file with its secret, and nothing without one (no session there)', async () => {
    const { runId, slug, secret } = seedRun();
    const url = `/data/${slug}-datafile.json`;
    const ok = await request(internalApp).get(url).set('X-OSCAR-Run-Id', runId).set('X-OSCAR-Run-Secret', secret);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).scenarios[0].code).toBe('A');
    expect((await request(internalApp).get(url)).status).toBe(403);
    expect((await request(app).get(url)).status).toBe(401);                 // the public port asks for a session
    const proxied = await request(internalApp).get(url).set('X-OSCAR-Run-Id', runId).set('X-OSCAR-Run-Secret', secret)
      .set('X-Forwarded-For', '203.0.113.9');
    expect(proxied.status).toBe(403);
  });

  test('refreshes a run\'s token with its secret only', async () => {
    const { runId, secret } = seedRun();
    resolveAccessToken.mockResolvedValue('fresh-token');
    const ok = await request(internalApp).post(`/v1/runs/${runId}/refresh-access-token`).set('X-OSCAR-Run-Secret', secret);
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBe('fresh-token');
    expect((await request(internalApp).post(`/v1/runs/${runId}/refresh-access-token`)).status).toBe(403);
  });

  test('serves the schema, and nothing else: no page, no API route', async () => {
    // The route answers (the tests' collection may hold no schema file): not the port's own 404.
    const schema = await request(internalApp).get('/json_validator/datafile.schema.json');
    expect(schema.status === 200 || schema.text === 'schema file not found').toBe(true);
    expect((await request(internalApp).get('/nothing')).body.detail).toBe('Not a run call.');
    for (const url of ['/', '/index.html', '/health', '/v1/auth/login', '/v1/runs', '/metrics']) {
      expect([url, (await request(internalApp).get(url)).status]).toEqual([url, 404]);
    }
  });
});

describe('a run sends its result files', () => {
  const NAME = '.bru_results_1a2b3c4d.json';

  test('kept with the run\'s secret, as sent, once', async () => {
    const { runId, secret } = seedRun();
    const url = `/v1/runs/${runId}/results/${NAME}`;
    const body = Buffer.from('{"results":[1]}');
    const sent = await request(internalApp).put(url).set('X-OSCAR-Run-Secret', secret)
      .set('Content-Type', 'application/octet-stream').send(body);
    expect(sent.status).toBe(201);
    expect(await runResults.listRunResults(runId)).toEqual([NAME]);
    expect((await runResults.readRunResult(runId, NAME)).equals(body)).toBe(true);
    const again = await request(internalApp).put(url).set('X-OSCAR-Run-Secret', secret)
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('{}'));
    expect(again.status).toBe(409);
  });

  test('refused without the run\'s own secret, with another run\'s, or through the proxy', async () => {
    const a = seedRun();
    const b = seedRun();
    const put = (runId, secret) => request(internalApp).put(`/v1/runs/${runId}/results/${NAME}`)
      .set('Content-Type', 'application/octet-stream').set('X-OSCAR-Run-Secret', secret || '').send(Buffer.from('{}'));
    expect((await put(a.runId)).status).toBe(403);
    expect((await put(a.runId, b.secret)).status).toBe(403);
    expect((await put(a.runId, a.secret).set('X-Forwarded-For', '203.0.113.9')).status).toBe(403);
    runSecrets.revoke(a.runId);                                               // the run has ended
    expect((await put(a.runId, a.secret)).status).toBe(403);
    expect(await runResults.listRunResults(a.runId)).toEqual([]);
  });

  test('a name that is not a result file\'s, or an empty file, is refused', async () => {
    const { runId, secret } = seedRun();
    for (const name of ['oscar.db', '..%2Foscar.db', 'report']) {
      const res = await request(internalApp).put(`/v1/runs/${runId}/results/${name}`).set('X-OSCAR-Run-Secret', secret)
        .set('Content-Type', 'application/octet-stream').send(Buffer.from('x'));
      expect([name, res.status]).toEqual([name, 400]);
    }
    const empty = await request(internalApp).put(`/v1/runs/${runId}/results/${NAME}`).set('X-OSCAR-Run-Secret', secret);
    expect(empty.status).toBe(400);
  });

  test('the public port has no result route', async () => {
    const { runId, secret } = seedRun();
    const res = await request(app).put(`/v1/runs/${runId}/results/${NAME}`).set('X-OSCAR-Run-Secret', secret)
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('{}'));
    expect(res.status).not.toBe(201);
    expect(await runResults.listRunResults(runId)).toEqual([]);
  });
});
