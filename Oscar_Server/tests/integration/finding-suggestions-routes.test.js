// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #735: findings suggested from a batch's failures. A batch is seeded as the
 * runner stores it (runs, run_suites, run_requests with an encrypted
 * response body, run_assertions), then analysed, listed and decided.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-finding-suggestions';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, colEncrypt } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company-finding-suggestions');

const companyId = uuidv4();
const otherCompanyId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const otherTmId = uuidv4();
const batchId = uuidv4();
const BASE = '/v1/company/findings/suggestions';

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@suggest-test.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = () => token('test_manager', tmId);

// One run of one scenario, with its failed checks: [step, status, body, [checks]].
function seedRun(scenario, requests, status = 'COMPLETED', batch = batchId, company = companyId) {
  const runId = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-10-14 17:00:00')`, [runId, company, tmId, status, batch, scenario]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, '02-Common Requests')`,
    [runId, company, scenario]).lastInsertRowid;
  for (const [step, httpStatus, body, checks] of requests) {
    const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status, response_body)
                       VALUES (?, ?, ?, ?, ?, ?)`, [suite, runId, company, step, httpStatus, colEncrypt(JSON.stringify(body))]).lastInsertRowid;
    for (const [name, passed] of checks) {
      run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed, error_msg)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [reqId, suite, runId, company, `${step}|${name}`, name, passed ? 1 : 0, passed ? null : 'expected x']);
    }
  }
  return runId;
}

const missing = { code: 'urn:uic:problem:MISSING_INFORMATION', title: 'Purchaser is missing' };
const notImpl = { code: 'urn:uic:problem:VALUE_NOT_SUPPORTED', title: 'Only one fulfillment' };

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Suggest Test', 'suggest-test')`, [companyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Suggest Other', 'suggest-other')`, [otherCompanyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@suggest-test.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tester@suggest-test.com', 'x', 'company_user')`, [testerId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@suggest-other.com', 'x', 'test_manager')`, [otherTmId, otherCompanyId]);

  // Booking refused for a missing purchaser in two scenarios; refund 501 in one;
  // a passing check that must not count; a run still running that must not count.
  seedRun('OTST_SALE_A', [['02. POST Create Booking', 400, missing,
    [['HTTP response status — expected 200, actual: 400', false], ['Content-Type is JSON', true]]]]);
  seedRun('OTST_SALE_B', [['02. POST Create Booking', 400, missing, [['HTTP response status — expected 200, actual: 400', false]]]]);
  seedRun('OTST_REFUND_A', [['10. POST Refund Offers', 501, notImpl, [['HTTP response status — expected 200, actual: 501', false]]]]);
  seedRun('OTST_RUNNING', [['01. POST Get Offer', 500, {}, [['HTTP response status — expected 200, actual: 500', false]]]], 'RUNNING');
  seedRun('OTST_LATE_SCENARIO', [['01. POST Get Offer', 200, {}, [['Offer: priced as CHILD', true]]]]);

  // An existing finding for the refund refusal, and one whose scenario ran and passed.
  run(`INSERT INTO finding (id, company_id, title, step, observed, category, status) VALUES (?, ?, ?, ?, ?, 'not_supported', 'open')`,
    ['F-refund', companyId, 'Refund of several fulfillments refused', '03-Refund/10. POST Refund Offers', 'Answer 501 VALUE_NOT_SUPPORTED']);
  run(`INSERT INTO finding (id, company_id, title, step, scenario_code, category, status) VALUES (?, ?, ?, ?, ?, 'open', 'open')`,
    ['F-age', companyId, 'Children priced as adults', '01. POST Get Offer', 'OTST_LATE_SCENARIO']);
});

describe('#735 who may use suggestions', () => {
  test('a tester and a certifier are refused, nothing is said about drafts', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await request(app).get(BASE).set('Authorization', t)).status).toBe(403);
      expect((await request(app).post(`${BASE}/analyse`).set('Authorization', t).send({ batchId })).status).toBe(403);
    }
  });

  test('another company\'s Test Manager does not reach the batch', async () => {
    const res = await request(app).post(`${BASE}/analyse`).set('Authorization', token('test_manager', otherTmId, otherCompanyId)).send({ batchId });
    expect(res.status).toBe(404);
  });

  test('an unknown or missing batch is a 404', async () => {
    expect((await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId: uuidv4() })).status).toBe(404);
    expect((await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({})).status).toBe(404);
  });
});

describe('#735 analysing a batch', () => {
  let drafts;

  test('the batches are listed for the Test Manager', async () => {
    const res = await request(app).get(`${BASE}/batches`).set('Authorization', tm());
    expect(res.status).toBe(200);
    expect(res.body.batches).toEqual([expect.objectContaining({ batchId, runs: 5, finishedRuns: 4 })]);
  });

  test('failures are grouped, a known one is still seen, a quiet one is not seen', async () => {
    const res = await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId });
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatchObject({ batchId, runs: 5, finishedRuns: 4, failures: 3, truncated: false });
    expect(res.body).toMatchObject({ groups: 2, created: 1, updated: 0, suppressed: 0 });
    expect(res.body.stillSeen).toEqual([expect.objectContaining({ findingId: 'F-refund', why: 'same step and problem code', scenarios: ['OTST_REFUND_A'] })]);
    expect(res.body.notSeen).toEqual([{ findingId: 'F-age', title: 'Children priced as adults', scenarioCode: 'OTST_LATE_SCENARIO' }]);
  });

  test('the draft carries the grouped failure, and is stored encrypted', async () => {
    const res = await request(app).get(BASE).set('Authorization', tm());
    expect(res.status).toBe(200);
    drafts = res.body.drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ state: 'draft', occurrences: 2, scenarios: ['OTST_SALE_A', 'OTST_SALE_B'], lastBatchId: batchId });
    expect(drafts[0].draft).toMatchObject({
      title: '02. POST Create Booking answers 400 MISSING_INFORMATION', step: '02. POST Create Booking',
      expectedStatus: 400, category: 'open',
    });
    // #735 part 3: the same check passes on the simulator (committed table).
    expect(drafts[0].draft.simulatorHint).toMatchObject({ verdict: 'provider' });
    const stored = get('SELECT draft FROM finding_suggestion WHERE id = ?', [drafts[0].id]).draft;
    expect(stored).not.toContain('MISSING_INFORMATION');
  });

  test('analysing again updates the waiting draft, never doubles it', async () => {
    const res = await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId });
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    expect((await request(app).get(BASE).set('Authorization', tm())).body.drafts).toHaveLength(1);
  });

  test('accepting, with an edit, makes an ordinary finding; the draft is decided', async () => {
    const res = await request(app).post(`${BASE}/${drafts[0].id}/accept`).set('Authorization', tm())
      .send({ title: 'Purchaser required at booking', category: 'provider_deviation', id: 'ignored', companyId: otherCompanyId });
    expect(res.status).toBe(201);
    expect(res.body.finding).toMatchObject({ title: 'Purchaser required at booking', category: 'provider_deviation',
      step: '02. POST Create Booking', expectedStatus: 400, status: 'open', baselineInRun: false });
    expect(get('SELECT company_id FROM finding WHERE id = ?', [res.body.finding.id]).company_id).toBe(companyId);
    expect(res.body.suggestion).toMatchObject({ state: 'accepted', findingId: res.body.finding.id });
    expect((await request(app).post(`${BASE}/${drafts[0].id}/accept`).set('Authorization', tm()).send({})).status).toBe(409);
  });

  test('the accepted failure is then "still seen", by its key', async () => {
    const res = await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId });
    expect(res.body).toMatchObject({ created: 0, updated: 0 });
    expect(res.body.stillSeen.map((s) => s.why)).toContain('accepted from the same failure before');
  });
});

describe('#735 rejecting and marking as OSCAR\'s', () => {
  const batch2 = uuidv4();
  let ids;

  beforeAll(async () => {
    seedRun('OTST_X', [['06. POST Obtaining Fulfillments', 409, { code: 'CONFLICT' }, [['HTTP response status — expected 200, actual: 409', false]]],
      ['03. PATCH Multi Passenger', 200, {}, [['[OSCAR request] PATCH /bookings/{bookingId}/passengers/{passengerId} conforms to OSDM 3.8.0 Passenger', false]]]], 'FAILED', batch2);
    await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId: batch2 });
    const drafts = (await request(app).get(BASE).set('Authorization', tm())).body.drafts;
    ids = Object.fromEntries(drafts.map((d) => [d.draft.step, d]));
  });

  test('OSCAR\'s own request starts as oscar_issue', () => {
    expect(ids['03. PATCH Multi Passenger'].draft.category).toBe('oscar_issue');
  });

  test('a rejected draft and one marked OSCAR\'s are not suggested again', async () => {
    const rej = await request(app).post(`${BASE}/${ids['06. POST Obtaining Fulfillments'].id}/reject`).set('Authorization', tm());
    expect(rej.body.suggestion.state).toBe('rejected');
    const osc = await request(app).post(`${BASE}/${ids['03. PATCH Multi Passenger'].id}/oscar-issue`).set('Authorization', tm());
    expect(osc.body.suggestion.state).toBe('oscar_issue');

    const again = await request(app).post(`${BASE}/analyse`).set('Authorization', tm()).send({ batchId: batch2 });
    expect(again.body).toMatchObject({ created: 0, updated: 0, suppressed: 2 });
    const list = (await request(app).get(BASE).set('Authorization', tm())).body;
    expect(list.drafts).toEqual([]);
    expect(list.oscarIssues.map((s) => s.draft.step)).toEqual(['03. PATCH Multi Passenger']);
    expect(list.rejected).toBe(1);
  });

  test('an OSCAR issue never becomes a finding', () => {
    expect(get("SELECT COUNT(*) AS n FROM finding WHERE company_id = ? AND category = 'oscar_issue'", [companyId]).n).toBe(0);
  });

  test('a draft of another company is not found', async () => {
    const res = await request(app).post(`${BASE}/${ids['06. POST Obtaining Fulfillments'].id}/reject`)
      .set('Authorization', token('test_manager', otherTmId, otherCompanyId));
    expect(res.status).toBe(404);
  });
});
