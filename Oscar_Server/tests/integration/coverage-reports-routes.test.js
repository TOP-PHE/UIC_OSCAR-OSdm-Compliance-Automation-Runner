// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverage-reports-routes.test.js — published coverage reports (#972 part 4):
 * a Test Manager publishes, shares and withdraws; the certifier reads what is
 * shared; each report is frozen and compared with the previous shared one.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-coverage-reports';

const fs      = require('fs');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { readZipEntry } = require('../../src/utils/zip');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-coverage-reports'));
app.use('/v1/company', require('../../src/api/routes/company-coverage'));
app.use('/v1/certifier', require('../../src/api/routes/certifier-coverage-reports'));

const tag = uuidv4().slice(0, 8);
const ids = { D: uuidv4(), P1: uuidv4(), O: uuidv4(), TM: uuidv4(), ANA: uuidv4(), ADM: uuidv4(), CERT: uuidv4(), OTM: uuidv4() };
const users = {
  TM:   { company: 'D', role: 'test_manager', email: `tm-${tag}@rep.example` },
  ANA:  { company: 'D', role: 'company_user', email: `ana-${tag}@rep.example` },
  ADM:  { company: 'D', role: 'administrator', email: `adm-${tag}@rep.example` },
  CERT: { company: 'D', role: 'certification_user', email: `cert-${tag}@rep.example` },
  OTM:  { company: 'O', role: 'test_manager', email: `otm-${tag}@rep.example` },
};
const as = (who, provider) => {
  const u = users[who];
  const h = { Authorization: `Bearer ${jwt.sign({ sub: ids[who], email: u.email, companyId: ids[u.company], role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` };
  if (provider) h['X-Provider-Id'] = ids[provider];
  return h;
};
const binary = (r) => r.buffer(true).parse((res, done) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => done(null, Buffer.concat(parts))); });

const SCENARIOS = [{ code: 'SALE_A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 }];
const DATAFILE = () => ({
  scenariosToRun: ['SALE_A'], scenarios: SCENARIOS,
  tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:a', destination: 'urn:b' } }],
  passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }],
});
const STEPS = ['01. POST Get Offer', '02. POST Create Booking', '06. POST Obtaining Fulfillments from Booking', '07. GET Booking after Fulfillments'];

// A finished run of SALE_A whose step 07 fails `check`.
function addRun(companyId, at, check, status = 'FAILED') {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, ?, 'SALE_A', ?, ?)`,
    [id, companyId, ids.TM, status, at, at]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, companyId, 'SALE_A', 's']).lastInsertRowid;
  for (const name of STEPS) {
    const req = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, 200)', [suite, id, companyId, name]).lastInsertRowid;
    if (name.startsWith('07.') && check) {
      run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, passed)
           VALUES (?, ?, ?, ?, 'k', ?, 'test', 'business_logic', 0)`, [req, suite, id, companyId, check]);
    }
  }
  return id;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Dist <D>', ?)`, [ids.D, `rep-d-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Prov P1', ?, ?)`, [ids.P1, `rep-d-${tag}--p1`, ids.D]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other', ?)`, [ids.O, `rep-o-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids[who], ids[u.company], u.email, u.role]);
  }
  await writeDatafile({ id: ids.D, slug: `rep-d-${tag}` }, DATAFILE());
  await writeDatafile({ id: ids.P1, slug: `rep-d-${tag}--p1` }, DATAFILE());
});

afterAll(() => {
  for (const id of [ids.D, ids.P1]) {
    const row = get('SELECT datafile_path FROM companies WHERE id = ?', [id]);
    if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  }
  // The routes' audit events name the companies and users: they go first.
  run('DELETE FROM auth_events WHERE company_id IN (?, ?, ?)', [ids.P1, ids.D, ids.O]);
  run('DELETE FROM companies WHERE id IN (?, ?, ?)', [ids.P1, ids.D, ids.O]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@rep.example`]);
});

describe('published coverage reports (#972 part 4)', () => {
  let first;
  let firstRun;

  test('a Test Manager publishes a numbered, frozen report; nobody else does', async () => {
    firstRun = addRun(ids.D, '2026-10-20 10:00:00', 'Booking summary names the product');
    const running = addRun(ids.D, '2026-10-19 10:00:00', null, 'RUNNING');
    for (const who of ['ANA', 'CERT', 'ADM']) {
      expect((await request(app).post('/v1/company/coverage/reports').set(as(who)).send({ days: 365 })).status).toBe(403);
    }
    expect((await request(app).post('/v1/company/coverage/reports').set(as('TM')).send({ days: 'x' })).status).toBe(400);
    const res = await request(app).post('/v1/company/coverage/reports').set(as('TM')).send({ days: 365 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 1, days: 365, createdBy: users.TM.email, sharedAt: null, comparedWith: null,
      summary: { tested: expect.any(Number), pointsToLookAt: { total: 1 } } });
    first = res.body.id;
    const one = await request(app).get(`/v1/company/coverage/reports/${first}`).set(as('TM'));
    expect(one.body.comparison).toBeNull();
    expect(one.body.report.byCapability.points).toEqual([expect.objectContaining({ number: 1, check: 'Booking summary names the product' })]);
    expect(one.body.report.byCapability.capabilities.find((c) => c.id === 'sale').tests[0].forms[0].runId).toBe(firstRun);
    // Stored encrypted: the check's text is not in the row.
    expect(get('SELECT content FROM coverage_report WHERE id = ?', [first]).content).not.toContain('Booking summary');
    expect(JSON.parse(get('SELECT run_ids FROM coverage_report WHERE id = ?', [first]).run_ids)).toEqual([firstRun]);
    expect((await request(app).get('/v1/company/coverage/reports').set(as('ANA'))).status).toBe(403);
    run('DELETE FROM runs WHERE id = ?', [running]);
  });

  test('sharing shares the report\'s runs, once; the certifier reads it, without e-mails', async () => {
    const other = addRun(ids.O, '2026-10-20 10:00:00', null, 'COMPLETED');
    const unfinished = addRun(ids.D, '2026-10-18 10:00:00', null, 'RUNNING');
    // Only the report's own company's finished runs are shared, whatever its stored list says.
    run('UPDATE coverage_report SET run_ids = ? WHERE id = ?', [JSON.stringify([firstRun, other, unfinished, 'x']), first]);
    expect((await request(app).get(`/v1/certifier/coverage-reports/${first}`).set(as('CERT'))).status).toBe(404);
    const res = await request(app).post(`/v1/company/coverage/reports/${first}/share`).set(as('TM'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sharedBy: users.TM.email, runsShared: 1 });
    expect(get('SELECT shared_with_certifier_by AS by FROM runs WHERE id = ?', [firstRun]).by).toBe(users.TM.email);
    expect(get('SELECT shared_with_certifier_at AS at FROM runs WHERE id = ?', [other]).at).toBeNull();
    expect(get('SELECT shared_with_certifier_at AS at FROM runs WHERE id = ?', [unfinished]).at).toBeNull();
    expect(get("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = ?", [`coverage_report_shared:${first}:1_runs`]).n).toBe(1);
    expect((await request(app).post(`/v1/company/coverage/reports/${first}/share`).set(as('TM'))).status).toBe(409);

    const list = await request(app).get('/v1/certifier/coverage-reports').set(as('CERT'));
    const item = list.body.reports.find((r) => r.id === first);
    expect(item).toMatchObject({ number: 1, company: 'Dist <D>', distributor: null, summary: { pointsToLookAt: { total: 1 } } });
    const read = await request(app).get(`/v1/certifier/coverage-reports/${first}`).set(as('CERT'));
    expect(read.status).toBe(200);
    expect(read.body.report.byCapability.points).toHaveLength(1);
    expect(JSON.stringify(read.body)).not.toContain('@rep.example');
    for (const who of ['TM', 'ANA', 'ADM']) expect((await request(app).get('/v1/certifier/coverage-reports').set(as(who))).status).toBe(403);
    expect((await request(app).get('/v1/certifier/coverage-reports/not-an-id').set(as('CERT'))).status).toBe(404);
    // Another company's Test Manager does not reach it.
    expect((await request(app).get(`/v1/company/coverage/reports/${first}`).set(as('OTM'))).status).toBe(404);
    run('DELETE FROM runs WHERE id IN (?, ?)', [other, unfinished]);
  });

  test('the next report is compared with the last shared one; the first stays as it was', async () => {
    addRun(ids.D, '2026-10-25 10:00:00', 'Booking price is the offer price');
    const res = await request(app).post('/v1/company/coverage/reports').set(as('TM')).send({ days: 365 });
    expect(res.body).toMatchObject({ number: 2, comparedWith: first });
    const second = await request(app).get(`/v1/company/coverage/reports/${res.body.id}`).set(as('TM'));
    expect(second.body.comparison).toMatchObject({
      previous: { id: first, number: 1 }, counts: { still: 0, new: 1, fixed: 1, notRetested: 0 },
      points: { new: [expect.objectContaining({ number: 1, check: 'Booking price is the offer price' })],
        fixed: [expect.objectContaining({ previousNumber: 1, check: 'Booking summary names the product' })] },
    });
    const again = await request(app).get(`/v1/company/coverage/reports/${first}`).set(as('TM'));
    expect(again.body.report.byCapability.points.map((p) => p.check)).toEqual(['Booking summary names the product']);

    const xlsx = await binary(request(app).get(`/v1/company/coverage/reports/${res.body.id}/download`).set(as('TM')));
    expect(xlsx.status).toBe(200);
    // #1002: the file name starts with the company's name.
    expect(xlsx.headers['content-disposition']).toBe('attachment; filename="Dist-D-oscar-coverage-report-2.xlsx"');
    const book = readZipEntry(xlsx.body, 'xl/workbook.xml').toString();
    expect([...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]).slice(0, 3)).toEqual(['Summary', 'Since report 1', 'Capabilities']);
    expect(readZipEntry(xlsx.body, 'xl/worksheets/sheet2.xml').toString()).toContain('Fixed');
  });

  test('a withdrawn report leaves the certifier\'s view; its runs stay shared', async () => {
    expect((await request(app).post(`/v1/company/coverage/reports/${uuidv4()}/withdraw`).set(as('TM'))).status).toBe(404);
    const unshared = all('SELECT id FROM coverage_report WHERE company_id = ? AND shared_at IS NULL', [ids.D])[0].id;
    expect((await request(app).post(`/v1/company/coverage/reports/${unshared}/withdraw`).set(as('TM'))).status).toBe(409);
    const res = await request(app).post(`/v1/company/coverage/reports/${first}/withdraw`).set(as('TM'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ withdrawnBy: users.TM.email });
    expect((await request(app).post(`/v1/company/coverage/reports/${first}/withdraw`).set(as('TM'))).status).toBe(409);
    const reshare = await request(app).post(`/v1/company/coverage/reports/${first}/share`).set(as('TM'));
    expect([reshare.status, reshare.body.detail]).toEqual([409, 'This report was withdrawn: publish a new one.']);
    expect((await request(app).get(`/v1/certifier/coverage-reports/${first}`).set(as('CERT'))).status).toBe(404);
    const list = await request(app).get('/v1/certifier/coverage-reports').set(as('CERT'));
    expect(list.body.reports.some((r) => r.id === first)).toBe(false);
    expect(get('SELECT shared_with_certifier_at AS at FROM runs WHERE id = ?', [firstRun]).at).not.toBeNull();
    // The Test Manager still lists it, marked withdrawn.
    const own = await request(app).get('/v1/company/coverage/reports').set(as('TM'));
    expect(own.body.reports.map((r) => [r.number, Boolean(r.withdrawnAt)])).toEqual([[2, false], [1, true]]);
    // A withdrawn report is not the one the next is compared with (#2 was never shared).
    const next = await request(app).post('/v1/company/coverage/reports').set(as('TM')).send({ days: 365 });
    expect(next.body).toMatchObject({ number: 3, comparedWith: null });
  });

  test('a provider numbers its own reports, and the certifier sees whose they are', async () => {
    addRun(ids.P1, '2026-10-21 10:00:00', null, 'COMPLETED');
    const res = await request(app).post('/v1/company/coverage/reports').set(as('TM', 'P1')).send({ days: 30 });
    expect(res.body).toMatchObject({ number: 1, comparedWith: null });
    expect((await request(app).post(`/v1/company/coverage/reports/${res.body.id}/share`).set(as('TM', 'P1'))).status).toBe(200);
    // The distributor's own list does not hold it.
    const own = await request(app).get('/v1/company/coverage/reports').set(as('TM'));
    expect(own.body.reports.some((r) => r.id === res.body.id)).toBe(false);
    const list = await request(app).get('/v1/certifier/coverage-reports').set(as('CERT'));
    expect(list.body.reports.find((r) => r.id === res.body.id)).toMatchObject({ company: 'Prov P1', distributor: 'Dist <D>', number: 1 });
    const xlsx = await binary(request(app).get(`/v1/certifier/coverage-reports/${res.body.id}/download`).set(as('CERT')));
    expect(xlsx.status).toBe(200);
    expect(readZipEntry(xlsx.body, 'xl/worksheets/sheet1.xml').toString()).toContain('Dist &lt;D&gt; — Prov P1 — published report 1');
    // #1002: the certifier's file is named after the provider the report is about.
    expect(xlsx.headers['content-disposition']).toBe('attachment; filename="Prov-P1-oscar-coverage-report-1.xlsx"');
    const tm = await binary(request(app).get(`/v1/company/coverage/reports/${res.body.id}/download`).set(as('TM', 'P1')));
    expect(tm.headers['content-disposition']).toBe('attachment; filename="Prov-P1-oscar-coverage-report-1.xlsx"');
  });
});

describe('a certifier\'s live coverage of a company that shared a report (#1043)', () => {
  test('lists the companies or providers whose shared report is not withdrawn', async () => {
    const res = await request(app).get('/v1/certifier/coverage').set(as('CERT'));
    expect(res.status).toBe(200);
    const mine = res.body.companies.filter((c) => [ids.D, ids.P1].includes(c.id));
    // The distributor's only shared report was withdrawn.
    expect(mine).toEqual([{ id: ids.P1, company: 'Prov P1', distributor: 'Dist <D>' }]);
    for (const who of ['TM', 'ANA', 'ADM']) expect((await request(app).get('/v1/certifier/coverage').set(as(who))).status).toBe(403);
    // The list of reports names the company each is about.
    const reports = await request(app).get('/v1/certifier/coverage-reports').set(as('CERT'));
    expect(reports.body.reports.find((r) => r.company === 'Prov P1').companyId).toBe(ids.P1);
  });

  test('is built from the runs shared with certifiers and their scenarios only', async () => {
    await writeDatafile({ id: ids.P1, slug: `rep-d-${tag}--p1` },
      { ...DATAFILE(), scenarios: [...SCENARIOS, { ...SCENARIOS[0], code: 'SALE_HIDDEN' }] });
    const hidden = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at)
         VALUES (?, ?, ?, 'COMPLETED', 'SALE_HIDDEN', '2026-10-22 10:00:00', '2026-10-22 10:00:00')`, [hidden, ids.P1, ids.TM]);
    const tm = await request(app).get('/v1/company/coverage?days=3650').set(as('TM', 'P1'));
    expect(JSON.stringify(tm.body)).toContain('SALE_HIDDEN');

    const res = await request(app).get(`/v1/certifier/coverage/${ids.P1}?days=3650`).set(as('CERT'));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('SALE_A');
    expect(text).not.toContain('SALE_HIDDEN');
    expect(text).not.toContain(hidden);
    expect(text).not.toContain('@rep.example');
    // Frozen as a published report is: no position to take, no simulated errors.
    expect(res.body.byCapability.positions).toBeUndefined();
    expect(res.body.byCapability.simulatedErrors).toBeUndefined();
    expect(res.body.byCapability.capabilities.find((c) => c.id === 'sale').tests[0].forms[0].runId)
      .toBe(get("SELECT id FROM runs WHERE company_id = ? AND scenario_code = 'SALE_A'", [ids.P1]).id);

    // Shared afterwards, the run counts.
    run("UPDATE runs SET shared_with_certifier_at = datetime('now') WHERE id = ?", [hidden]);
    expect(JSON.stringify((await request(app).get(`/v1/certifier/coverage/${ids.P1}?days=3650`).set(as('CERT'))).body)).toContain('SALE_HIDDEN');
  });

  test('answers 404 for a company that shared nothing, 400 for a bad window, 403 to anyone else', async () => {
    expect((await request(app).get(`/v1/certifier/coverage/${ids.D}`).set(as('CERT'))).status).toBe(404);
    expect((await request(app).get(`/v1/certifier/coverage/${ids.O}`).set(as('CERT'))).status).toBe(404);
    expect((await request(app).get('/v1/certifier/coverage/not-an-id').set(as('CERT'))).status).toBe(404);
    expect((await request(app).get(`/v1/certifier/coverage/${ids.P1}?days=0`).set(as('CERT'))).status).toBe(400);
    for (const who of ['TM', 'ANA', 'ADM']) {
      expect((await request(app).get(`/v1/certifier/coverage/${ids.P1}`).set(as(who))).status).toBe(403);
      expect((await request(app).get(`/v1/certifier/coverage/${ids.P1}/download`).set(as(who))).status).toBe(403);
    }
    expect((await request(app).get(`/v1/certifier/coverage/${ids.D}/download`).set(as('CERT'))).status).toBe(404);
  });

  test('downloads as a workbook named after the provider', async () => {
    const xlsx = await binary(request(app).get(`/v1/certifier/coverage/${ids.P1}/download?days=3650`).set(as('CERT')));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-disposition']).toMatch(/^attachment; filename="Prov-P1-oscar-coverage-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(readZipEntry(xlsx.body, 'xl/worksheets/sheet1.xml').toString()).toContain('Dist &lt;D&gt; — Prov P1');
  });
});
