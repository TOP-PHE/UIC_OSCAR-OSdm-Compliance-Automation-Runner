// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverage-routes.test.js — GET /v1/company/coverage (#956): who may read it,
 * which company's runs and findings it reads, what a tester sees.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-coverage';

const fs      = require('fs');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, colEncrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { scenarioHash, daysOf } = (() => ({
  ...require('../../src/utils/frameworkCoverage'), daysOf: require('../../src/api/routes/company-coverage').daysOf,
}))();

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-coverage'));

const tag = uuidv4().slice(0, 8);
const ids = { D: uuidv4(), P1: uuidv4(), O: uuidv4(), TM: uuidv4(), ANA: uuidv4(), ADM: uuidv4(), CERT: uuidv4() };
const users = {
  TM:   { company: 'D', role: 'test_manager', email: `tm-${tag}@cov.example` },
  ANA:  { company: 'D', role: 'company_user', email: `ana-${tag}@cov.example` },
  ADM:  { company: 'D', role: 'administrator', email: `adm-${tag}@cov.example` },
  CERT: { company: 'D', role: 'certification_user', email: `cert-${tag}@cov.example` },
};
const as = (who, provider) => {
  const u = users[who];
  const h = { Authorization: `Bearer ${jwt.sign({ sub: ids[who], email: u.email, companyId: ids[u.company], role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` };
  if (provider) h['X-Provider-Id'] = ids[provider];
  return h;
};

const SCENARIOS = [
  { code: 'SHARED_SALE', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, shared: true, created_by: users.TM.email },
  { code: 'TM_REFUND', scenarioType: 'REFUND', tripRequirementId: 1, passengersListId: 1, created_by: users.TM.email },
];
const DATAFILE = () => ({
  scenariosToRun: ['SHARED_SALE'],
  scenarios: SCENARIOS,
  tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:a', destination: 'urn:b' } }],
  passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }],
});

function addRun(companyId, code, status, failed, extra = {}) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at, collection_version, scenario_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, companyId, ids.TM, status, code, extra.at || "2026-10-24 10:00:00", extra.at || '2026-10-24 10:05:00', extra.collection || null, extra.hash || null]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, companyId, code, 's']).lastInsertRowid;
  const request = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, ?)', [suite, id, companyId, 'r']).lastInsertRowid;
  for (let i = 0; i < 4; i += 1) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, passed)
         VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`, [request, suite, id, companyId, `k${i}`, `check ${i}`, i < failed ? 0 : 1]);
  }
  return id;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [ids.D, `cov-d-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P1', ?, ?)`, [ids.P1, `cov-d-${tag}--p1`, ids.D]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'O', ?)`, [ids.O, `cov-o-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids[who], ids[u.company], u.email, u.role]);
  }
  await writeDatafile({ id: ids.D, slug: `cov-d-${tag}` }, DATAFILE());
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`,
    [uuidv4(), ids.D, colEncrypt(JSON.stringify({ salesFlows: ['SALE', 'REFUND_FULL', 'EXCHANGE_FULL'] }))]);
  addRun(ids.D, 'SHARED_SALE', 'FAILED', 2, { at: '2026-10-20 09:00:00' });
  addRun(ids.D, 'SHARED_SALE', 'COMPLETED', 0, { collection: 'OLD', hash: scenarioHash(SCENARIOS[0]) });
  const refund = addRun(ids.D, 'TM_REFUND', 'FAILED', 0, { at: '2026-10-19 09:00:00' });
  run('INSERT INTO run_events (run_id, level, message) VALUES (?, ?, ?)',
    [refund, 'warn', colEncrypt('[INFO] step\n🧪 [WARNING] the provider answers 501 (Not Implemented), so the probe could not be run.')]);
  addRun(ids.D, 'TM_REFUND', 'RUNNING', 0);
  addRun(ids.O, 'TM_REFUND', 'COMPLETED', 0);
  run(`INSERT INTO finding (id, company_id, title, scenario_code, category, status) VALUES (?, ?, 'Refund refused', 'TM_REFUND', 'provider_deviation', 'open')`, [uuidv4(), ids.D]);
});

afterAll(() => {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [ids.D]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  run('DELETE FROM companies WHERE id IN (?, ?, ?)', [ids.P1, ids.D, ids.O]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@cov.example`]);
});

describe('GET /v1/company/coverage', () => {
  test('a Test Manager gets the coverage of the company, from its own latest finished runs', async () => {
    const res = await request(app).get('/v1/company/coverage').set(as('TM'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 365, framework: true, datafile: true });
    const row = (id) => res.body.functions.find((f) => f.id === id);
    expect(row('salesFlow:SALE')).toMatchObject({ state: 'passed' });
    const sale = row('salesFlow:SALE').scenarios.find((s) => s.code === 'SHARED_SALE');
    expect(sale).toMatchObject({ result: 'passed', run: { passed: 4, failed: 0, collectionVersion: 'OLD' } });
    // The refund's latest finished run is the company's own (company O's is not read).
    expect(row('salesFlow:REFUND_FULL')).toMatchObject({ state: 'passed', findings: [{ title: 'Refund refused', category: 'provider_deviation' }] });
    expect(row('salesFlow:EXCHANGE_FULL').state).toBe('not-covered');
    expect(res.body.summary).toMatchObject({ declared: 4, notCovered: 1 });
  });

  test('by flow and element: the refund counts its run\'s "not supported" warning', async () => {
    const res = await request(app).get('/v1/company/coverage').set(as('TM'));
    const cell = (flow, label) => res.body.matrix.find((r) => r.flow === flow && r.label === label);
    expect(cell('REFUND_FULL', 'Full refund (every scenario)')).toMatchObject({ result: 'passed', providerNotSupported: 1, scenarios: ['TM_REFUND'] });
    expect(cell('SALE', 'Sale (every scenario)')).toMatchObject({ result: 'passed', counts: { scenarios: 1, passed: 1 } });
    expect(res.body.scenarios.find((x) => x.code === 'TM_REFUND').providerNotSupported)
      .toEqual(['the provider answers 501 (Not Implemented), so the probe could not be run.']);
  });

  test('the workbook is the same report, for members only', async () => {
    const res = await request(app).get('/v1/company/coverage/download?days=30').set(as('TM'))
      .buffer(true).parse((r, done) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => done(null, Buffer.concat(parts))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="oscar-coverage-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const { readZipEntry } = require('../../src/utils/zip');
    expect(readZipEntry(res.body, 'xl/worksheets/sheet3.xml').toString()).toContain('TM_REFUND');
    expect((await request(app).get('/v1/company/coverage/download').set(as('CERT'))).status).toBe(403);
    expect((await request(app).get('/v1/company/coverage/download?days=x').set(as('TM'))).status).toBe(400);
  });

  test('a tester sees the scenarios of their view only', async () => {
    const res = await request(app).get('/v1/company/coverage').set(as('ANA'));
    expect(res.status).toBe(200);
    const codes = res.body.functions.flatMap((f) => f.scenarios.map((s) => s.code));
    expect(codes).toContain('SHARED_SALE');
    expect(codes).not.toContain('TM_REFUND');
  });

  test('a provider without a data file or framework answers an empty coverage', async () => {
    const res = await request(app).get('/v1/company/coverage').set(as('TM', 'P1'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ framework: false, datafile: false, summary: { declared: 1, notCovered: 1 } });
  });

  test.each(['ADM', 'CERT'])('%s gets 403', async (who) => {
    const res = await request(app).get('/v1/company/coverage').set(as(who));
    expect(res.status).toBe(403);
  });

  test('the window is a whole number of days', async () => {
    expect((await request(app).get('/v1/company/coverage?days=0').set(as('TM'))).status).toBe(400);
    expect((await request(app).get('/v1/company/coverage?days=1&days=2').set(as('TM'))).status).toBe(400);
    const old = await request(app).get('/v1/company/coverage?days=1').set(as('TM'));
    expect(old.status).toBe(200);
    expect(daysOf(undefined)).toBe(365);
    expect(daysOf('3650')).toBe(3650);
    expect(daysOf('3651')).toBeNull();
    expect(daysOf(['1'])).toBeNull();
  });
});
