// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * batch-reports-zip.test.js — integration test for the one-click bulk download
 * GET /v1/runs/batch/:batchId/reports.zip (#405). Seeds a batch of two runs with
 * real encrypted-at-rest artifacts and asserts the endpoint returns a valid ZIP
 * of all of them, strictly scoped to the owning company.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-batch-zip';

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = uuidv4();
const tmId      = uuidv4();
const batchId   = uuidv4();
const runA      = uuidv4();
const runB      = uuidv4();
const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const dirsToClean = [];

function token(role, uid, cid = companyId) {
  return jwt.sign({ sub: uid, email: `${role}@bz.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function makeArtifact(runId, type, filename, content) {
  const dir = path.join(ARTIFACTS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  dirsToClean.push(dir);
  const p = path.join(dir, filename);
  encryptToFile(content, p);   // at-rest envelope; endpoint decrypts on the way out
  run(`INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?,?,?,?,?)`,
    [uuidv4(), runId, type, filename, p]);
}

// supertest binary-body collector (the response is a raw zip, not JSON/text).
function asBuffer(req) {
  return req.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'BZ Co', 'bz-co')`, [companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, 'tm@bz.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, env_name_used, batch_id, scenario_code, started_at)
       VALUES (?, ?, ?, 'COMPLETED', 'OTST_bz-sandbox_Env', ?, 'SALE_SEARCH_A', '2026-05-24 09:00:00')`,
    [runA, companyId, tmId, batchId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, env_name_used, batch_id, scenario_code, started_at)
       VALUES (?, ?, ?, 'FAILED', 'OTST_bz-sandbox_Env', ?, 'SALE_SEARCH_B', '2026-05-24 09:01:00')`,
    [runB, companyId, tmId, batchId]);
  makeArtifact(runA, 'json_results', '.bru_results.json', JSON.stringify({ scenario: 'A', pass: 10 }));
  makeArtifact(runA, 'html_report', 'report_SALE_SEARCH_A.html', '<html>A</html>');
  makeArtifact(runB, 'json_results', '.bru_results.json', JSON.stringify({ scenario: 'B', fail: 3 }));
});

describe('GET /v1/runs/batch/:batchId/reports.zip', () => {
  test('401 without a token', async () => {
    const res = await request(app).get(`/v1/runs/batch/${batchId}/reports.zip`);
    expect(res.status).toBe(401);
  });

  test('404 for an unknown batch', async () => {
    const res = await request(app).get(`/v1/runs/batch/${uuidv4()}/reports.zip`)
      .set('Authorization', `Bearer ${token('test_manager', tmId)}`);
    expect(res.status).toBe(404);
  });

  test('404 when the batch belongs to a different company (scoping)', async () => {
    const res = await request(app).get(`/v1/runs/batch/${batchId}/reports.zip`)
      .set('Authorization', `Bearer ${token('test_manager', uuidv4(), uuidv4())}`);
    expect(res.status).toBe(404);
  });

  test('200 streams a valid ZIP of every report in the batch', async () => {
    const res = await asBuffer(
      request(app).get(`/v1/runs/batch/${batchId}/reports.zip`)
        .set('Authorization', `Bearer ${token('test_manager', tmId)}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/zip/);
    expect(res.headers['content-disposition']).toMatch(/bz-sandbox_2026-05-24_batch-[0-9a-f]{8}\.zip/);

    const body = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.readUInt32LE(0)).toBe(0x04034b50);          // local file header
    const eocd = body.length - 22;
    expect(body.readUInt32LE(eocd)).toBe(0x06054b50);       // end-of-central-directory
    expect(body.readUInt16LE(eocd + 10)).toBe(3);           // 3 artifacts bundled

    // Entries are named by scenario.
    expect(body.includes(Buffer.from('SALE_SEARCH_A.json'))).toBe(true);
    expect(body.includes(Buffer.from('SALE_SEARCH_A.html'))).toBe(true);
    expect(body.includes(Buffer.from('SALE_SEARCH_B.json'))).toBe(true);
  });
});

afterAll(() => {
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  safe('DELETE FROM run_artifacts WHERE run_id IN (?, ?)', [runA, runB]);
  safe('DELETE FROM runs WHERE batch_id = ?', [batchId]);
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
  safe('DELETE FROM companies WHERE id = ?', [companyId]);
  dirsToClean.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
});
