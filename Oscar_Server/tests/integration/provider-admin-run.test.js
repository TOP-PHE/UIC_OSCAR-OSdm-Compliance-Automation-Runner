// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: credentials are per (user, company); an administrator keeps one set,
 * stored for the platform company, as before.
 */

process.env.JWT_SECRET = 'review-admin-run';
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, encrypt } = require('../../src/db/db');
const { credentialsAsMigrated } = require('../helpers/credentials');
jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));

const app = express();
app.use(express.json());
app.use('/v1/runs', require('../../src/api/routes/runs'));

test('an administrator\'s one set of credentials still applies to a run on a named company', async () => {
  const DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rv-adm-'));
  const DF = path.join(DIR, 'df.json'); fs.writeFileSync(DF, '{"scenarios":[{"code":"S1"}],"scenariosToRun":"ALL"}');
  const PLAT = uuidv4(), X = uuidv4(), A = uuidv4();
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Plat', ?)`, [PLAT, `plat-${PLAT.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, api_base, datafile_path) VALUES (?, 'X', ?, 'https://x.example/osdm', ?)`, [X, `x-${X.slice(0, 8)}`, DF]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, ?, 'x', 'administrator', 'bearer', ?)`,
    [A, PLAT, `adm-${A.slice(0, 8)}@x.example`, encrypt('admin-token')]);
  credentialsAsMigrated(A);   // what migration 29 does
  expect(get('SELECT company_id FROM tester_credentials WHERE user_id = ?', [A]).company_id).toBe(PLAT);

  const tok = jwt.sign({ sub: A, email: 'adm@x.example', companyId: PLAT, role: 'administrator' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const res = await request(app).post('/v1/runs').set('Authorization', `Bearer ${tok}`).send({ company_id: X });
  fs.rmSync(DIR, { recursive: true, force: true });
  expect(res.status).toBe(202);
});
