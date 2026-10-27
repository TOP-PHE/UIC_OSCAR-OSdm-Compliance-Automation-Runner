// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverage-positions-routes.test.js — POST /v1/company/coverage/positions
 * (#994): the provider takes a position on a point of the coverage, who may,
 * on which point, and what it changes.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-coverage-positions';

const fs      = require('fs');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, all, colEncrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { forPublication } = require('../../src/utils/coverageReports');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-coverage'));
app.use('/v1/company', require('../../src/api/routes/company-coverage-positions'));
app.use('/v1/company', require('../../src/api/routes/company-coverage-reports'));

const tag = uuidv4().slice(0, 8);
const ids = { D: uuidv4(), O: uuidv4(), TM: uuidv4(), ANA: uuidv4(), ADM: uuidv4(), CERT: uuidv4(), OTM: uuidv4() };
const users = {
  TM:   { company: 'D', role: 'test_manager', email: `tm-${tag}@pos.example` },
  ANA:  { company: 'D', role: 'company_user', email: `ana-${tag}@pos.example` },
  ADM:  { company: 'D', role: 'administrator', email: `adm-${tag}@pos.example` },
  CERT: { company: 'D', role: 'certification_user', email: `cert-${tag}@pos.example` },
  OTM:  { company: 'O', role: 'test_manager', email: `otm-${tag}@pos.example` },
};
const as = (who) => {
  const u = users[who];
  return { Authorization: `Bearer ${jwt.sign({ sub: ids[who], email: u.email, companyId: ids[u.company], role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` };
};

const SCENARIOS = [
  { code: 'SHARED_SALE', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, shared: true, created_by: users.TM.email },
  { code: 'TM_SALE', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, created_by: users.TM.email },
];
const DATAFILE = () => ({
  scenariosToRun: ['SHARED_SALE', 'TM_SALE'],
  scenarios: SCENARIOS,
  tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:a', destination: 'urn:b' } }],
  passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }],
});

const STEPS = [['01. POST Get Offer', 200], ['02. POST Create Booking', 200], ['06. POST Obtaining Fulfillments from Booking', 200],
  ['06b. GET Fulfillment', 200], ['07. GET Booking after Fulfillments', 200]];

// A run of a sale that went through, with failed checks [step, check text, failure text].
function addRun(code, at, failures) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
    [id, ids.D, ids.TM, code, at, at]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, ids.D, code, 's']).lastInsertRowid;
  const requests = {};
  for (const [name, status] of STEPS) {
    requests[name] = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, ?)',
      [suite, id, ids.D, name, status]).lastInsertRowid;
  }
  for (const [step, text, error] of failures) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, severity, passed, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, 'test', 'business_logic', 'major', 0, ?)`, [requests[step], suite, id, ids.D, `k-${text}`, text, error]);
  }
  return id;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [ids.D, `pos-d-${tag}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'O', ?)`, [ids.O, `pos-o-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids[who], ids[u.company], u.email, u.role]);
  }
  await writeDatafile({ id: ids.D, slug: `pos-d-${tag}` }, DATAFILE());
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`, [uuidv4(), ids.D, colEncrypt(JSON.stringify({ salesFlows: ['SALE'] }))]);
  addRun('SHARED_SALE', '2026-10-25 10:00:00', [
    ['06b. GET Fulfillment', 'Fulfillment document is a PDF', 'expected \'PKPASS\' to equal \'PDF_A4\''],
    ['02. POST Create Booking', 'Booking keeps the flexibility asked', 'expected \'NON_FLEXIBLE\' to equal \'SEMI_FLEXIBLE\''],
  ]);
  addRun('TM_SALE', '2026-10-25 11:00:00', [['07. GET Booking after Fulfillments', 'Booking names the purchaser', 'no purchaser']]);
});

afterAll(() => {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [ids.D]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  // The route's audit events name the companies and users: they go first.
  run('DELETE FROM auth_events WHERE company_id IN (?, ?)', [ids.D, ids.O]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [ids.D, ids.O]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@pos.example`]);
});

const coverage = async (who = 'TM') => (await request(app).get('/v1/company/coverage').set(as(who))).body.byCapability;
const pointOf = (c, check) => c.points.find((p) => p.check === check);
const take = (who, body) => request(app).post('/v1/company/coverage/positions').set(as(who)).send({ days: 365, comment: 'Our answer.', ...body });

describe('POST /v1/company/coverage/positions', () => {
  test('the coverage offers the positions and gives every point an id', async () => {
    const c = await coverage();
    expect(c.positions.choices.map((x) => x.key)).toEqual(['fix', 'notSupported', 'onPurpose', 'oscar', 'specification', 'declaration', 'fixed']);
    expect(c.positions.alwaysRequired).toEqual(['sale', 'offers.search']);
    for (const p of c.points) expect(p.id).toMatch(/^[0-9a-f]{32}$/);
    // The same problem keeps its id from one report to the next.
    expect((await coverage()).points.map((p) => p.id)).toEqual(c.points.map((p) => p.id));
  });

  test('a tester answers "not supported" on an optional capability: a finding is opened, and the point no longer counts', async () => {
    const before = await coverage();
    const point = pointOf(before, 'Fulfillment document is a PDF');
    expect(point).toMatchObject({ kind: 'provider', capability: 'fulfilment.documents', finding: null });
    expect(before.capabilities.find((x) => x.id === 'fulfilment.documents').result).toBe('points');

    const res = await take('ANA', { point: point.id, position: 'notSupported', comment: 'We sell mobile tickets only.' });
    expect(res.status).toBe(200);
    expect(res.body.finding).toMatchObject({
      category: 'not_supported', severity: 'not_supported', status: 'discussing', step: '06b. GET Fulfillment', scenarioCode: 'SHARED_SALE',
      position: 'notSupported', positionBy: users.ANA.email, positionRole: 'company_user', positionComment: 'We sell mobile tickets only.',
      createdBy: users.ANA.email,
    });
    expect(res.body.finding.observed).toBe('Expected: Fulfillment document is a PDF\nSeen: expected \'PKPASS\' to equal \'PDF_A4\'');
    expect(res.body.position).toMatchObject({ value: 'notSupported', role: 'tester', comment: 'We sell mobile tickets only.' });
    // The comment is in the finding's thread, and the point's keys are linked to the finding.
    const thread = all('SELECT author, role, body FROM finding_comment WHERE finding_id = ?', [res.body.finding.id]);
    expect(thread).toEqual([{ author: users.ANA.email, role: 'company_user', body: 'Position: Not supported: optional, not a blocker.\n\nWe sell mobile tickets only.' }]);
    for (const key of point.keys) {
      expect(get('SELECT state, finding_id FROM finding_suggestion WHERE company_id = ? AND group_key = ?', [ids.D, key]))
        .toEqual({ state: 'accepted', finding_id: res.body.finding.id });
    }

    const after = await coverage();
    expect(pointOf(after, 'Fulfillment document is a PDF')).toMatchObject({
      id: point.id, kind: 'unsupported', finding: { id: res.body.finding.id, position: { value: 'notSupported', by: users.ANA.email, role: 'tester' } },
    });
    // TM_SALE's run read its fulfilment as it should: the capability passed, SHARED_SALE's run says "not supported".
    expect(after.capabilities.find((x) => x.id === 'fulfilment.documents')).toMatchObject({
      result: 'passed', sideProblems: [{ code: 'SHARED_SALE', result: 'not-supported' }],
    });
    expect(after.summary.pointsToLookAt).toMatchObject({ unsupported: 1 });
  });

  test('"not supported" is refused on a capability every provider must have', async () => {
    const point = pointOf(await coverage(), 'Booking keeps the flexibility asked');
    expect(point.capability).toBe('sale');
    const res = await take('ANA', { point: point.id, position: 'notSupported' });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/required of every provider/);
    expect(get('SELECT COUNT(*) AS n FROM finding WHERE company_id = ? AND step = ?', [ids.D, '02. POST Create Booking']).n).toBe(0);
  });

  test('"on purpose" makes the point an accepted deviation at once; a later position changes the same finding', async () => {
    const point = pointOf(await coverage(), 'Booking keeps the flexibility asked');
    const first = await take('ANA', { point: point.id, position: 'onPurpose', comment: 'We only sell non-flexible tariffs.' });
    expect(first.status).toBe(200);
    expect(first.body.finding).toMatchObject({ category: 'provider_deviation', status: 'resolved', position: 'onPurpose' });
    let c = await coverage();
    expect(pointOf(c, 'Booking keeps the flexibility asked').kind).toBe('accepted');
    const saleTest = (cov) => cov.capabilities.find((x) => x.id === 'sale').tests.find((x) => x.key === 'SHARED_SALE');
    expect(saleTest(c).result).toBe('deviation');

    const second = await take('TM', { point: point.id, position: 'fix', comment: 'Agreed with the provider: to fix.' });
    expect(second.status).toBe(200);
    expect(second.body.finding).toMatchObject({ id: first.body.finding.id, category: 'provider_deviation', status: 'discussing', position: 'fix', positionRole: 'test_manager' });
    c = await coverage();
    expect(pointOf(c, 'Booking keeps the flexibility asked')).toMatchObject({ kind: 'provider', finding: { position: { value: 'fix', role: 'Test Manager' } } });
    expect(saleTest(c).result).toBe('points');
    expect(all('SELECT body FROM finding_comment WHERE finding_id = ? ORDER BY created_at, rowid', [first.body.finding.id]).map((x) => x.body.split('\n')[0]))
      .toEqual(['Position: Done this way on purpose.', 'Position: Agreed, we will fix it.']);
    expect(get('SELECT COUNT(*) AS n FROM finding WHERE company_id = ? AND step = ?', [ids.D, '02. POST Create Booking']).n).toBe(1);
  });

  test('a tester cannot answer a point of a scenario they do not see; a Test Manager can', async () => {
    const tm = pointOf(await coverage('TM'), 'Booking names the purchaser');
    expect(tm).toBeTruthy();
    expect(pointOf(await coverage('ANA'), 'Booking names the purchaser')).toBeUndefined();
    const res = await take('ANA', { point: tm.id, position: 'fix' });
    expect(res.status).toBe(404);
    expect((await take('TM', { point: tm.id, position: 'specification', comment: 'Is the purchaser required here?' })).body.finding)
      .toMatchObject({ category: 'spec_question', position: 'specification' });
    expect(pointOf(await coverage('TM'), 'Booking names the purchaser').kind).toBe('question');
  });

  test('another company\'s Test Manager does not find the point', async () => {
    const point = pointOf(await coverage(), 'Fulfillment document is a PDF');
    expect((await take('OTM', { point: point.id, position: 'fix' })).status).toBe(404);
  });

  test.each(['ADM', 'CERT'])('%s gets 403', async (who) => {
    const point = pointOf(await coverage(), 'Fulfillment document is a PDF');
    expect((await take(who, { point: point.id, position: 'fix' })).status).toBe(403);
  });

  test('the body is checked before anything is read', async () => {
    const point = pointOf(await coverage(), 'Fulfillment document is a PDF');
    expect((await take('TM', { point: 'not-an-id', position: 'fix' })).status).toBe(400);
    expect((await take('TM', { point: point.id, position: 'maybe' })).status).toBe(400);
    expect((await take('TM', { point: point.id, position: 'fix', comment: '   ' })).status).toBe(400);
    expect((await take('TM', { point: point.id, position: 'fix', comment: 'x'.repeat(4001) })).status).toBe(400);
    expect((await take('TM', { point: point.id, position: 'fix', days: 0 })).status).toBe(400);
    expect((await take('TM', { point: 'f'.repeat(32), position: 'fix' })).status).toBe(404);
  });

  test('a published report keeps the position, its role and date, never the e-mail or the comment', async () => {
    const report = { byCapability: { positions: { choices: [] }, points: [] } };
    const c = await coverage();
    report.byCapability.points = c.points;
    const frozen = forPublication(report);
    expect(frozen.byCapability.positions).toBeUndefined();
    const p = pointOf(frozen.byCapability, 'Fulfillment document is a PDF');
    expect(p.finding.position).toEqual({ value: 'notSupported', label: 'Not supported: optional, not a blocker', role: 'tester', at: expect.any(String) });
    expect(JSON.stringify(frozen)).not.toContain(users.ANA.email);
    expect(JSON.stringify(frozen)).not.toContain('We sell mobile tickets only.');
  });

  test('a report published through the route is frozen that way', async () => {
    const published = await request(app).post('/v1/company/coverage/reports').set(as('TM')).send({ days: 365 });
    expect(published.status).toBe(201);
    const read = await request(app).get(`/v1/company/coverage/reports/${published.body.id}`).set(as('TM'));
    expect(read.status).toBe(200);
    expect(pointOf(read.body.report.byCapability, 'Fulfillment document is a PDF').finding.position).toMatchObject({ value: 'notSupported', role: 'tester' });
    expect(read.body.report.byCapability.positions).toBeUndefined();
    const text = JSON.stringify(read.body);
    expect(text).not.toContain(users.ANA.email);
    expect(text).not.toContain('We sell mobile tickets only.');
  });
});
