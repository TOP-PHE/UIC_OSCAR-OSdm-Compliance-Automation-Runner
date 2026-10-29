// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runs-selection.test.js — choosing at launch what a batch runs (#1029),
 * through the real routes: POST /v1/runs with a selection, and
 * POST /v1/runs/preview. The run queue is stubbed: no Bruno process starts.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-run-selection';
// The collection's version is read at load: the repository's, so that "to run again" compares.
process.env.COLLECTION_PATH = require('path').resolve(__dirname, '../../../Bruno_Collection');

jest.mock('../../src/worker/queue', () => ({
  enqueue: jest.fn(), purge: jest.fn(), queueStatus: jest.fn(() => ({})),
}));

const { credentialsAsMigrated } = require('../helpers/credentials');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, colEncrypt } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');

const runsApp = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = crypto.randomUUID();
const slug      = `run-selection-${companyId.slice(0, 8)}`;
const LIVE_PATH = path.resolve(__dirname, '../../data/datafiles', `${slug}-datafile.json`);

const TM   = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@select.test`, role: 'test_manager' };
const ANA  = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@select.test`, role: 'company_user' };
const CERT = { id: crypto.randomUUID(), email: `cert-${companyId.slice(0, 6)}@select.test`, role: 'certification_user' };

const token = (u) => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' });

const SCENARIOS = [
  { code: 'OTST_SALE_A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 },
  { code: 'OTST_SALE_A_TRIPID', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offersByTripIds: 'on' },
  { code: 'OTST_REFUND_B', scenarioType: 'REFUND', scenarioAction: 'PATCH', tripRequirementId: 1, passengersListId: 1 },
  { code: 'NHF_SALE_NO_PASSENGER', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, emptyPassengersExpectRejection: 'on' },
  { code: 'SIM_WRONG_BOOKING_PRICE_38', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 },
  { code: 'SIM_FAULT_OFFER_500_38', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, simulatorFaults: 'OFFER_500' },
  { code: 'TM_PRIVATE', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, created_by: TM.email, shared: false },
];
const ALL = SCENARIOS.map((s) => s.code);
const datafile = () => ({
  scenarios: SCENARIOS, scenariosToRun: ['OTST_SALE_A', 'SIM_WRONG_BOOKING_PRICE_38'],
  tripRequirements: [{ id: 1, tripType: 'SEARCH' }], passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }],
  purchaserList: [], requestedFulfillmentOptionsList: [],
});

const launch = (u, body) => request(runsApp).post('/v1/runs').set('Authorization', `Bearer ${token(u)}`).send(body);
const preview = (u, body) => request(runsApp).post('/v1/runs/preview').set('Authorization', `Bearer ${token(u)}`).send(body);
const queuedOf = (batchId) => get('SELECT group_concat(scenario_code) AS c FROM (SELECT scenario_code FROM runs WHERE batch_id = ? ORDER BY scenario_code)', [batchId]).c.split(',');
const sorted = (list) => [...list].sort();

// A finished run of `code`, `failed` of its checks failed.
function finishedRun(code, { status = 'COMPLETED', failed = 0 } = {}) {
  const id = crypto.randomUUID();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at)
       VALUES (?, ?, ?, ?, 'old-batch', ?, datetime('now', '-1 hour'))`, [id, companyId, TM.id, status, code]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, suite_name) VALUES (?, ?, 's')`, [id, companyId]).lastInsertRowid;
  const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, 'r')`, [suite, id, companyId]).lastInsertRowid;
  for (let i = 0; i <= failed; i += 1) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed)
         VALUES (?, ?, ?, ?, ?, 'check', ?)`, [reqId, suite, id, companyId, `k${i}`, i < failed ? 0 : 1]);
  }
}

beforeAll(() => {
  fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Run Selection Co', ?, 'https://select.example')`, [companyId, slug]);
  for (const u of [TM, ANA, CERT]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, ?, 'x', ?, 'bearer', ?)`,
      [u.id, companyId, u.email, u.role, colEncrypt('tok')]);
    credentialsAsMigrated(u.id);
  }
  const content = JSON.stringify(datafile(), null, 4);
  encryptToFile(content, LIVE_PATH);
  run('UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?',
    [LIVE_PATH, crypto.createHash('sha256').update(content).digest('hex'), companyId]);
});

afterAll(() => {
  for (const f of fs.readdirSync(path.dirname(LIVE_PATH)).filter((n) => n.startsWith(slug))) {
    try { fs.unlinkSync(path.join(path.dirname(LIVE_PATH), f)); } catch { /* ignore */ }
  }
  const safe = (sql, p) => { try { run(sql, p); } catch { /* ignore */ } };
  safe('DELETE FROM run_batch WHERE company_id = ?', [companyId]);
  safe('DELETE FROM runs WHERE company_id = ?', [companyId]);
  safe('DELETE FROM companies WHERE id = ?', [companyId]);
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

describe('POST /v1/runs with a selection', () => {
  test('without a selection the run list runs, as before', async () => {
    const res = await launch(TM, {});
    expect(res.status).toBe(202);
    expect(queuedOf(res.body.batch_id)).toEqual(['OTST_SALE_A', 'SIM_WRONG_BOOKING_PRICE_38']);
  });

  test('the default selection takes the whole file: happy flows and expected refusals, no simulated error', async () => {
    const res = await launch(TM, { selection: {} });
    expect(res.status).toBe(202);
    expect(queuedOf(res.body.batch_id)).toEqual(sorted(['OTST_SALE_A', 'OTST_SALE_A_TRIPID', 'OTST_REFUND_B', 'NHF_SALE_NO_PASSENGER', 'TM_PRIVATE']));
  });

  test('the simulated errors alone, the expected refusals alone', async () => {
    const simulated = await launch(TM, { selection: { categories: ['simulated'] } });
    expect(queuedOf(simulated.body.batch_id)).toEqual(['SIM_FAULT_OFFER_500_38', 'SIM_WRONG_BOOKING_PRICE_38']);
    const refusals = await launch(TM, { selection: { categories: ['refusal'] } });
    expect(queuedOf(refusals.body.batch_id)).toEqual(['NHF_SALE_NO_PASSENGER']);
  });

  test('by group and by form, on the run list as the base', async () => {
    const refund = await launch(TM, { selection: { groups: ['Refund'] } });
    expect(queuedOf(refund.body.batch_id)).toEqual(['OTST_REFUND_B']);
    const tripIds = await launch(TM, { selection: { forms: ['TRIP_IDS'] } });
    expect(queuedOf(tripIds.body.batch_id)).toEqual(['OTST_SALE_A_TRIPID']);
    const list = await launch(TM, { selection: { base: 'list', categories: ['happy', 'refusal', 'simulated'] } });
    expect(queuedOf(list.body.batch_id)).toEqual(['OTST_SALE_A', 'SIM_WRONG_BOOKING_PRICE_38']);
  });

  test('a tester chooses among what they see: never a colleague\'s private scenario', async () => {
    const res = await launch(ANA, { selection: { categories: ['happy', 'refusal', 'simulated'] } });
    expect(res.status).toBe(202);
    expect(queuedOf(res.body.batch_id)).toEqual(sorted(ALL.filter((c) => c !== 'TM_PRIVATE')));
  });

  test('a selection that keeps nothing, or that is not one, is refused before anything is queued', async () => {
    const before = get('SELECT COUNT(*) AS n FROM runs WHERE company_id = ?', [companyId]).n;
    const empty = await launch(TM, { selection: { categories: [] } });
    expect(empty.status).toBe(400);
    expect(empty.body.detail).toBe('No scenario of the data file fits this selection.');
    // #1039: no fare scenario in this file, so fare based alone keeps nothing; an unknown mode is refused.
    const fares = await launch(TM, { selection: { modes: ['FARE'] } });
    expect(fares.status).toBe(400);
    expect(fares.body.detail).toBe('No scenario of the data file fits this selection.');
    const both = await launch(TM, { selection: { modes: ['BOTH'] } });
    expect(both.status).toBe(400);
    expect(both.body.detail).toMatch(/selection.modes: unknown value "BOTH"/);
    const wrong = await launch(TM, { selection: { categories: ['sad'] } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.detail).toMatch(/selection\.categories: unknown value "sad"/);
    expect((await launch(TM, { selection: 'all' })).status).toBe(400);
    expect(get('SELECT COUNT(*) AS n FROM runs WHERE company_id = ?', [companyId]).n).toBe(before);
  });
});

describe('the last run', () => {
  test('failed at the last run: a FAILED run or a failed check; a later passing run clears it', async () => {
    finishedRun('OTST_SALE_A', { status: 'FAILED' });
    finishedRun('OTST_REFUND_B', { failed: 2 });
    finishedRun('NHF_SALE_NO_PASSENGER');
    const res = await launch(TM, { selection: { lastRun: 'failed' } });
    expect(queuedOf(res.body.batch_id)).toEqual(['OTST_REFUND_B', 'OTST_SALE_A']);
    // A newer run that passed is the last one.
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at)
         VALUES (?, ?, ?, 'COMPLETED', 'newer', 'OTST_SALE_A', datetime('now'))`, [crypto.randomUUID(), companyId, TM.id]);
    const again = await launch(TM, { selection: { lastRun: 'failed' } });
    expect(queuedOf(again.body.batch_id)).toEqual(['OTST_REFUND_B']);
  });

  test('to run again: never run, or run without the versions recorded, or older than the collection or the scenario', async () => {
    const { currentCollectionVersion } = require('../../src/utils/versionInfo');
    const { scenarioHash } = require('../../src/utils/frameworkCoverage');
    const current = (code, version) => run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, collection_version, scenario_hash)
      VALUES (?, ?, ?, 'COMPLETED', 'versioned', ?, datetime('now'), ?, ?)`, [crypto.randomUUID(), companyId, TM.id, code, version, scenarioHash(SCENARIOS.find((s) => s.code === code))]);
    current('OTST_SALE_A_TRIPID', currentCollectionVersion());
    current('TM_PRIVATE', 'OTST_V0.0.1');
    const res = await launch(TM, { selection: { lastRun: 'toRunAgain' } });
    expect(queuedOf(res.body.batch_id)).toEqual(sorted(['OTST_SALE_A', 'OTST_REFUND_B', 'NHF_SALE_NO_PASSENGER', 'TM_PRIVATE']));
  });
});

describe('POST /v1/runs/preview', () => {
  test('counts what each value holds and what the selection keeps, and queues nothing', async () => {
    const before = get('SELECT COUNT(*) AS n FROM runs WHERE company_id = ?', [companyId]).n;
    const res = await preview(TM, { selection: { categories: ['simulated'] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 7, selected: 2, seen: 7, runList: 2 });
    expect(res.body.counts.categories).toEqual({ happy: 4, refusal: 1, simulated: 2 });
    expect(res.body.counts.forms).toEqual({ SEARCH: 6, SPECIFICATION: 0, TRIP_IDS: 1 });
    expect(res.body.counts.modes).toEqual({ PRODUCT: 7, FARE: 0 });
    expect(res.body.labels.modes).toEqual({ PRODUCT: 'Product based', FARE: 'Fare based' });
    expect(res.body.selection).toMatchObject({ base: 'all', categories: ['simulated'], lastRun: 'all' });
    expect(res.body.labels.categories.simulated).toBe('Simulated errors');
    expect(get('SELECT COUNT(*) AS n FROM runs WHERE company_id = ?', [companyId]).n).toBe(before);
  });

  test('a tester\'s preview counts what they see; a certifier gets none', async () => {
    const res = await preview(ANA, {});
    expect(res.body.total).toBe(6);
    expect(res.body.seen).toBe(6);
    expect((await preview(CERT, {})).status).toBe(403);
    expect((await preview(TM, { selection: { base: 'some' } })).status).toBe(400);
  });
});

describe('the batch says what it ran (#1029 PR 3)', () => {
  const list = (u) => request(runsApp).get('/v1/runs?limit=100&whole_batches=1').set('Authorization', `Bearer ${token(u)}`);
  const labelsOf = (body, batchId) => [...new Set(body.runs.filter((r) => r.batch_id === batchId).map((r) => r.batch_label))];

  test('a batch chosen at launch carries its selection in words; one from the run list carries none', async () => {
    const chosen = await launch(TM, { selection: { groups: ['Refund'] } });
    const plain = await launch(TM, {});
    const res = await list(TM);
    expect(res.status).toBe(200);
    expect(labelsOf(res.body, chosen.body.batch_id)).toEqual(['Happy flows + Expected refusals · Refund']);
    expect(labelsOf(res.body, plain.body.batch_id)).toEqual([null]);
    // What is stored is the selection used, every default filled in, for the company of the runs.
    const stored = get('SELECT company_id, selection FROM run_batch WHERE batch_id = ?', [chosen.body.batch_id]);
    expect(stored.company_id).toBe(companyId);
    expect(JSON.parse(stored.selection)).toEqual({
      base: 'all', categories: ['happy', 'refusal'], modes: ['PRODUCT', 'FARE'], groups: ['Refund'], forms: ['SEARCH', 'SPECIFICATION', 'TRIP_IDS'], lastRun: 'all',
    });
    expect(get('SELECT COUNT(*) AS n FROM run_batch WHERE batch_id = ?', [plain.body.batch_id]).n).toBe(0);
  });

  test('a tester reads the label of their own batch too', async () => {
    const mine = await launch(ANA, { selection: { categories: ['simulated'], base: 'list' } });
    const res = await list(ANA);
    expect(labelsOf(res.body, mine.body.batch_id)).toEqual(['Run list · Simulated errors']);
  });

  test('a refused launch stores no selection; a stored one that cannot be read is said as none', async () => {
    const before = get('SELECT COUNT(*) AS n FROM run_batch WHERE company_id = ?', [companyId]).n;
    expect((await launch(TM, { selection: { categories: [] } })).status).toBe(400);
    expect((await launch(TM, { selection: { lastRun: 'yesterday' } })).status).toBe(400);
    expect(get('SELECT COUNT(*) AS n FROM run_batch WHERE company_id = ?', [companyId]).n).toBe(before);

    const batchId = crypto.randomUUID();
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at)
         VALUES (?, ?, ?, 'COMPLETED', ?, 'OTST_SALE_A', datetime('now'))`, [crypto.randomUUID(), companyId, TM.id, batchId]);
    run('INSERT INTO run_batch (batch_id, company_id, selection) VALUES (?, ?, ?)', [batchId, companyId, '{not json']);
    const res = await list(TM);
    expect(res.status).toBe(200);
    expect(labelsOf(res.body, batchId)).toEqual([null]);
  });
});
