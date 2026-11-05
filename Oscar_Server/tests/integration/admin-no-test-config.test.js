// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * An administrator manages companies, not their tests. It creates, renames and
 * deletes companies and their users, but never reads or changes a company's
 * test set-up: no run, no endpoint, no credentials of its own used on a
 * company. Deleting a company removes everything it held, unread.
 */

process.env.JWT_SECRET = 'admin-no-test-config';
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, encrypt } = require('../../src/db/db');
const { credentialsAsMigrated } = require('../helpers/credentials');
const { credentialsFor } = require('../../src/utils/testerCredentials');
const { liveDatafilePath, previousDatafilePath } = require('../../src/utils/datafileWrite');
jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));
const { refusedRunScope } = require('../../src/worker/runner');
const { all } = require('../../src/db/db');
const { OWNED, KEPT } = require('../../src/utils/companyPurge');

const app = express();
app.use(express.json());
app.use('/v1/runs', require('../../src/api/routes/runs'));
app.use('/v1/admin', require('../../src/api/routes/admin'));

const PLAT = uuidv4();
const X = uuidv4();
const A = uuidv4();
const DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adm-cfg-'));
const DF = path.join(DIR, 'df.json');

const asAdmin = () => `Bearer ${jwt.sign({ sub: A, email: `adm-${A.slice(0, 8)}@x.example`, companyId: PLAT, role: 'administrator' },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

beforeAll(() => {
  fs.writeFileSync(DF, '{"scenarios":[{"code":"S1"}],"scenariosToRun":"ALL"}');
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Plat', ?)`, [PLAT, `plat-${PLAT.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, api_base, datafile_path) VALUES (?, 'X', ?, 'https://x.example/osdm', ?)`, [X, `x-${X.slice(0, 8)}`, DF]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, ?, 'x', 'administrator', 'bearer', ?)`,
    [A, PLAT, `adm-${A.slice(0, 8)}@x.example`, encrypt('admin-token')]);
  credentialsAsMigrated(A);
});

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('an administrator runs nothing on a company', () => {
  test('a run or its preview is refused, whatever company it names', async () => {
    for (const url of ['/v1/runs', '/v1/runs/preview']) {
      const res = await request(app).post(url).set('Authorization', asAdmin()).send({ company_id: X });
      expect(res.status).toBe(403);
    }
  });

  test('its own credentials are not used for another company', () => {
    expect(credentialsFor(A, PLAT).access_token_enc).toBeTruthy();
    expect(credentialsFor(A, X).access_token_enc ?? null).toBeNull();
  });

  test('a run queued by an administrator is refused by the runner', () => {
    expect(refusedRunScope({ company_id: X }, X, A)).toMatch(/administrator does not run tests/);
  });
});

describe('the company list shows no test set-up', () => {
  test('no endpoint in the administrator\'s list', async () => {
    const res = await request(app).get('/v1/admin/companies').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    const x = res.body.companies.find(c => c.id === X);
    expect(x).toBeDefined();
    expect(x).not.toHaveProperty('api_base');
  });
});

describe('deleting a company removes what it held', () => {
  test('every table naming a company is deleted or kept on purpose', () => {
    const named = all("SELECT name FROM sqlite_master WHERE type = 'table'").map(t => t.name)
      .filter(t => all('SELECT name FROM pragma_table_info(?)', [t]).some(c => c.name === 'company_id'));
    expect(named.filter(t => !OWNED.includes(t) && !KEPT.includes(t))).toEqual([]);
  });

  test('rows of every table naming it, and its data files', async () => {
    const Y = uuidv4();
    const slug = `gone-${Y.slice(0, 8)}`;
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Gone', ?)`, [Y, slug]);
    run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, '{}')`, [uuidv4(), Y]);
    const findingId = uuidv4();
    run(`INSERT INTO finding (id, company_id, title, created_by) VALUES (?, ?, 'f', 'tm@x.example')`, [findingId, Y]);
    run(`INSERT INTO finding_comment (id, finding_id, author, body) VALUES (?, ?, 'tm@x.example', 'c')`, [uuidv4(), findingId]);
    run(`INSERT INTO places_cache (company_id, places_json) VALUES (?, '[]')`, [Y]);
    run(`INSERT INTO tester_credentials (user_id, company_id, auth_mode) VALUES (?, ?, 'bearer')`, [A, Y]);
    fs.mkdirSync(path.dirname(liveDatafilePath(slug)), { recursive: true });
    fs.writeFileSync(liveDatafilePath(slug), 'x');
    fs.writeFileSync(previousDatafilePath(slug), 'x');

    const res = await request(app).delete(`/v1/admin/companies/${Y}`).set('Authorization', asAdmin());
    expect(res.status).toBe(200);

    expect(get('SELECT id FROM companies WHERE id = ?', [Y])).toBeUndefined();
    for (const table of ['test_frameworks', 'finding', 'places_cache', 'tester_credentials']) {
      expect(get(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`, [Y]).n).toBe(0);
    }
    expect(get('SELECT COUNT(*) AS n FROM finding_comment WHERE finding_id = ?', [findingId]).n).toBe(0);
    expect(fs.existsSync(liveDatafilePath(slug))).toBe(false);
    expect(fs.existsSync(previousDatafilePath(slug))).toBe(false);
    // The administrator's own credentials, for the platform company, stay.
    expect(get('SELECT COUNT(*) AS n FROM tester_credentials WHERE user_id = ? AND company_id = ?', [A, PLAT]).n).toBe(1);
    // The deletion is in the audit trail.
    expect(get('SELECT COUNT(*) AS n FROM auth_events WHERE event_type LIKE ?', [`company_deleted:${Y}:%`]).n).toBe(1);
  });
});
