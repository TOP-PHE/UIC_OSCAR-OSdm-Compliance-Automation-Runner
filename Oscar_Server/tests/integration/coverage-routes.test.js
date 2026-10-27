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
const { groupKeyOf } = require('../../src/utils/findingSuggestions');
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

  test('a failed run says its first failed step and whether it blocked the flow', async () => {
    const failed = addRun(ids.D, 'SHARED_SALE', 'FAILED', 0, { at: '2026-10-25 09:00:00' });
    const suite = get('SELECT id FROM run_suites WHERE run_id = ?', [failed]).id;
    const req = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, ?)', [suite, failed, ids.D, '02. POST Booking']).lastInsertRowid;
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, passed)
         VALUES (?, ?, ?, ?, 'kx', 'Status code is 200', 'test', 'http_status', 0)`, [req, suite, failed, ids.D]);
    const res = await request(app).get('/v1/company/coverage').set(as('TM'));
    const sale = res.body.matrix.find((r) => r.flow === 'SALE' && r.element === null);
    expect(sale).toMatchObject({ result: 'failed', failedScenarios: [{ code: 'SHARED_SALE', result: 'failed', runId: failed, step: '02. POST Booking', check: 'Status code is 200' }] });
    run('DELETE FROM runs WHERE id = ?', [failed]);
  });

  test('by capability (#972): the run\'s steps prove the sale, a refund stopped early is blocked', async () => {
    const id = addRun(ids.D, 'SHARED_SALE', 'COMPLETED', 0, { at: '2026-10-25 10:00:00' });
    const suite = get('SELECT id FROM run_suites WHERE run_id = ?', [id]).id;
    for (const [name, status] of [['01. POST Get Offer', 200], ['02. POST Create Booking', 200], ['06. POST Obtaining Fulfillments from Booking', 200],
      ['06b. GET Fulfillment', 501], ['07. GET Booking after Fulfillments', 200]]) {
      run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, ?)', [suite, id, ids.D, name, status]);
    }
    try {
      const res = await request(app).get('/v1/company/coverage').set(as('TM'));
      const cap = (c) => res.body.byCapability.capabilities.find((x) => x.id === c);
      expect(cap('sale')).toMatchObject({ result: 'passed', tests: [{ key: 'SHARED_SALE', result: 'passed', forms: [{ code: 'SHARED_SALE', form: 'SEARCH', runId: id }] }] });
      expect(cap('offers.search')).toMatchObject({ result: 'passed', provenBy: { count: 1 } });
      expect(cap('fulfilment.documents').result).toBe('not-supported');
      // TM_REFUND asks a refund offer; its latest run has no known step, so the refund was never reached.
      expect(cap('refund.offer')).toMatchObject({ result: 'blocked', tests: [{ key: 'TM_REFUND' }] });
      // Declared, with no test of their own: the full refund (TM_REFUND only asks the offer) and the exchange.
      expect(cap('refund.full')).toMatchObject({ result: 'not-tested', tests: [] });
      expect(cap('exchange.full')).toMatchObject({ result: 'not-tested' });
      expect(res.body.byCapability.summary).toMatchObject({ passed: 2, blocked: 1, notSupported: 1, notTested: 2, expectedRefusals: { total: 0 } });
      const ana = await request(app).get('/v1/company/coverage').set(as('ANA'));
      expect(ana.body.byCapability.capabilities.some((x) => x.tests.some((t) => t.key === 'TM_REFUND'))).toBe(false);
    } finally {
      run('DELETE FROM runs WHERE id = ?', [id]);
    }
  });

  test('by capability (#972 part 2): the points to look at, an accepted deviation and a known deviation', async () => {
    const id = addRun(ids.D, 'SHARED_SALE', 'FAILED', 0, { at: '2026-10-25 11:00:00' });
    const suite = get('SELECT id FROM run_suites WHERE run_id = ?', [id]).id;
    const problem = colEncrypt(JSON.stringify({ code: 'urn:osdm:problem:FULFILLMENT_NOT_READY', title: 'Not ready', status: 422 }));
    const requests = {};
    for (const [name, status, body] of [['01. POST Get Offer', 200], ['02. POST Create Booking', 202], ['06. POST Obtaining Fulfillments from Booking', 200],
      ['06b. GET Fulfillment', 422, problem], ['07. GET Booking after Fulfillments', 200]]) {
      requests[name] = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status, response_body) VALUES (?, ?, ?, ?, ?, ?)',
        [suite, id, ids.D, name, status, body || null]).lastInsertRowid;
    }
    const failCheck = (name, text, error = null) => run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, passed, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, 'test', 'business_logic', 0, ?)`, [requests[name], suite, id, ids.D, `k-${text}`, text, error]);
    failCheck('07. GET Booking after Fulfillments', 'Booking summary names the product');
    failCheck('06b. GET Fulfillment', 'Fulfillment status is FULFILLED', 'expected \'AVAILABLE\' to equal \'FULFILLED\'');
    failCheck('07. GET Booking after Fulfillments', 'Booking holds the ticket');
    // A #735 draft of that failure the Test Manager marked as OSCAR's issue.
    const oscarKey = groupKeyOf({ step: '07. GET Booking after Fulfillments', check: 'Booking holds the ticket', status: 200, problemCode: null });
    run("INSERT INTO finding_suggestion (id, company_id, group_key, state, draft) VALUES (?, ?, ?, 'oscar_issue', ?)", [uuidv4(), ids.D, oscarKey, colEncrypt('{}')]);
    run('INSERT INTO run_events (run_id, level, message) VALUES (?, ?, ?)', [id, 'warn',
      colEncrypt('[WARNING] Known deviation (documented): 02. POST Create Booking returned HTTP 202 — Booking confirmed later. Not counted as a failure; surfaced for visibility.')]);
    const accepted = uuidv4();
    const baseline = uuidv4();
    run(`INSERT INTO finding (id, company_id, title, step, observed, category, status, created_by) VALUES (?, ?, 'No product in the summary', '07. GET Booking after Fulfillments',
         'Booking summary names the product', 'provider_deviation', 'resolved', ?)`, [accepted, ids.D, users.TM.email]);
    run(`INSERT INTO finding (id, company_id, title, step, expected_status, baseline_in_run, category, status) VALUES (?, ?, 'Booking confirmed later', 'POST Create Booking',
         202, 1, 'provider_deviation', 'open')`, [baseline, ids.D]);
    try {
      const res = await request(app).get('/v1/company/coverage').set(as('TM'));
      const r = res.body.byCapability;
      const cap = (c) => r.capabilities.find((x) => x.id === c);
      // OSCAR's point is listed apart and does not count: the accepted deviation is all that is left.
      expect(cap('sale')).toMatchObject({ result: 'deviation' });
      expect(cap('fulfilment.documents')).toMatchObject({ result: 'points' });
      const pointAt = (step) => r.points.find((p) => p.step === step);
      expect(pointAt('06b. GET Fulfillment')).toMatchObject({ kind: 'provider', status: 422, problemCode: 'FULFILLMENT_NOT_READY', capability: 'fulfilment.documents' });
      // #990: what the run saw, from the check's stored failure text; none stored, none said.
      expect(pointAt('06b. GET Fulfillment').observed).toMatchObject({ text: 'expected \'AVAILABLE\' to equal \'FULFILLED\'', code: 'SHARED_SALE' });
      expect(pointAt('07. GET Booking after Fulfillments').observed).toBeNull();
      expect(pointAt('07. GET Booking after Fulfillments')).toMatchObject({
        kind: 'accepted', source: 'check', capability: 'sale', finding: { id: accepted, title: 'No product in the summary', category: 'provider_deviation', status: 'resolved' },
      });
      expect(pointAt('02. POST Create Booking')).toMatchObject({ kind: 'accepted', source: 'known-deviation', status: 202, note: 'Booking confirmed later', finding: { id: baseline } });
      // A point names its finding by id, title, category, status and the position taken on it (#994) only.
      expect(Object.keys(pointAt('07. GET Booking after Fulfillments').finding).sort()).toEqual(['category', 'id', 'position', 'status', 'title']);
      expect(r.points.find((p) => p.check === 'Booking holds the ticket')).toMatchObject({ kind: 'oscar', capability: 'sale' });
      expect(r.summary).toMatchObject({ pointsToLookAt: { total: 4, provider: 1, accepted: 2, oscar: 1 } });
      // The function view still lists open findings only, by these fields.
      expect(res.body.functions.some((f) => f.findings.some((x) => x.id === accepted))).toBe(false);
      const listed = res.body.functions.flatMap((f) => f.findings);
      expect(listed.length).toBeGreaterThan(0);
      for (const f of listed) expect(Object.keys(f).sort()).toEqual(['category', 'id', 'scenarioCode', 'status', 'title']);
    } finally {
      run('DELETE FROM runs WHERE id = ?', [id]);
      run('DELETE FROM finding WHERE id IN (?, ?)', [accepted, baseline]);
      run('DELETE FROM finding_suggestion WHERE company_id = ?', [ids.D]);
    }
  });

  test('#995: the offer request options\' results, from the runs\' logs, in the reader\'s view only', async () => {
    const { reportLines } = require('../../../Bruno_Collection/library-bruno/offerOptions.js');
    const options = (code) => ({ code, scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offerOptionDiscovery: 'on' });
    const shared = { ...options('SHARED_OPTIONS'), shared: true, created_by: users.TM.email };
    const own = { ...options('TM_OPTIONS'), created_by: users.TM.email };
    await writeDatafile({ id: ids.D, slug: `cov-d-${tag}` }, { ...DATAFILE(), scenarios: [...SCENARIOS, shared, own] });
    const report = (ok) => ({
      version: '3.8.0', budget: 30, used: 4, seed: 1, mandatory: { ok, message: '2 offer(s)' },
      options: [{ option: 'offerSearchCriteria.currency', value: 'EUR', source: 'declared', declared: true, status: 200, result: 'honoured', message: 'kept' },
        { option: 'embed', status: 501, result: 'not-implemented', message: 'HTTP 501' }],
      combinations: [{ options: ['offerSearchCriteria.currency', 'embed'], status: 400, result: 'refused', message: 'COMBINATION' }],
      all: null,
    });
    const runs = [];
    // SHARED_SALE does not run the options: lines in its log are not read.
    for (const [code, at, ok] of [['SHARED_OPTIONS', '2026-10-25 08:00:00', true], ['TM_OPTIONS', '2026-10-26 08:00:00', false], ['SHARED_SALE', '2026-10-27 08:00:00', true]]) {
      const id = addRun(ids.D, code, 'COMPLETED', 0, { at });
      runs.push(id);
      for (const line of reportLines(report(ok))) {
        run("INSERT INTO run_events (run_id, level, category, message) VALUES (?, 'info', 'offer_options', ?)", [id, colEncrypt(line)]);
      }
    }
    try {
      const tm = (await request(app).get('/v1/company/coverage').set(as('TM'))).body.byCapability;
      expect(tm.offerOptions.map((e) => [e.code, e.mandatory.ok])).toEqual([['TM_OPTIONS', false], ['SHARED_OPTIONS', true]]);
      expect(tm.offerOptions[1]).toMatchObject({ runId: runs[0], at: '2026-10-25 08:00:00', version: '3.8.0',
        text: 'mandatory parameters only: answered · 2 parameter(s): 1 supported, 1 refused or not implemented · 1 combination(s): 0 answered, 0 without offer, 1 refused' });
      expect(tm.offerOptions[1].parameters.map((p) => [p.option, p.resultText, p.declared])).toEqual([
        ['offerSearchCriteria.currency', 'Supported, kept to', true], ['embed', 'Not implemented', undefined]]);
      // The latest run's summary is on the capability's row.
      expect(tm.capabilities.find((c) => c.id === 'offers.requestOptions').parameters).toBe(tm.offerOptions[0].text);
      // A tester sees the shared scenario's run only.
      const ana = (await request(app).get('/v1/company/coverage').set(as('ANA'))).body.byCapability;
      expect(ana.offerOptions.map((e) => e.code)).toEqual(['SHARED_OPTIONS']);
      expect(ana.capabilities.find((c) => c.id === 'offers.requestOptions').parameters).toBe(ana.offerOptions[0].text);
      expect(require('../../src/api/helpers/offerOptionReports').offerOptionReportsOf([])).toEqual([]);
    } finally {
      for (const id of runs) run('DELETE FROM runs WHERE id = ?', [id]);
      await writeDatafile({ id: ids.D, slug: `cov-d-${tag}` }, DATAFILE());
    }
  });

  test('the workbook is the same report, for members only', async () => {
    const res = await request(app).get('/v1/company/coverage/download?days=30').set(as('TM'))
      .buffer(true).parse((r, done) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => done(null, Buffer.concat(parts))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    // #1002: the file name starts with the company's name.
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="D-oscar-coverage-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const { readZipEntry } = require('../../src/utils/zip');
    // Summary, then the coverage by capability, then the detail (#972): By scenario is the sixth sheet.
    expect(readZipEntry(res.body, 'xl/worksheets/sheet6.xml').toString()).toContain('TM_REFUND');
    expect(readZipEntry(res.body, 'xl/worksheets/sheet2.xml').toString()).toContain('Sale: pre-booking and confirmation');
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
