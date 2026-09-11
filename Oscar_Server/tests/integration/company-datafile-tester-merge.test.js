// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-tester-merge.test.js — S3, second half (v1.11.197), end to
 * end through the real routes.
 *
 * Maintainer decision, 2026-09-11: a tester saves their own tests without
 * affecting any other stored test; they see their own tests and the shared
 * ones, the shared ones read-only; and each tester has a personal run list.
 * One company, two testers (Ana, Ben) and a Test Manager, one stored datafile
 * seeded straight to disk before every test.
 *
 * The run queue is stubbed: POST /v1/runs is exercised up to the point where
 * it records which scenarios a batch contains, and no Bruno process starts.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-tester-merge';

jest.mock('../../src/worker/queue', () => ({
  enqueue: jest.fn(), purge: jest.fn(), queueStatus: jest.fn(() => ({})),
}));

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, colEncrypt } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const companyApp = buildAppWithRoute('/v1/company', '../../src/api/routes/company');
const runsApp    = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = crypto.randomUUID();
const slug      = `tester-merge-${companyId.slice(0, 8)}`;
const LIVE_PATH = path.resolve(__dirname, '../../data/datafiles', `${slug}-datafile.json`);

const ANA = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@merge.test`, role: 'company_user' };
const BEN = { id: crypto.randomUUID(), email: `ben-${companyId.slice(0, 6)}@merge.test`, role: 'company_user' };
const TM  = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@merge.test`,  role: 'test_manager' };

const token = u => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' });

function scenario(code, owner, base, shared = false) {
  return {
    code, shared, ...(owner ? { created_by: owner.email } : {}),
    tripRequirementId: base, passengersListId: base + 1, purchaserListId: base + 2,
    requestedFulfillmentOptionsListId: base + 3,
  };
}
function storedFile() {
  const parts = [
    [scenario('SHARED_1', TM, 10, true), 'shared'],
    [scenario('LEGACY_1', null, 20),     'legacy'],
    [scenario('ANA_1', ANA, 30),         'ana'],
    [scenario('BEN_1', BEN, 40),         'ben'],
    [scenario('TM_PRIV', TM, 50),        'tm'],
  ];
  const df = { scenarios: [], tripRequirements: [], passengersList: [], purchaserList: [], requestedFulfillmentOptionsList: [],
               scenariosToRun: parts.map(([s]) => s.code), systemInfoParameters: { owner: 'company' } };
  for (const [s, tag] of parts) {
    df.scenarios.push(s);
    df.tripRequirements.push({ id: s.tripRequirementId, tag });
    df.passengersList.push({ id: s.passengersListId, tag });
    df.purchaserList.push({ id: s.purchaserListId, tag });
    df.requestedFulfillmentOptionsList.push({ id: s.requestedFulfillmentOptionsListId, tag });
  }
  return df;
}
const onDisk = () => JSON.parse(decryptFromFile(LIVE_PATH).toString('utf8'));
const codes  = df => df.scenarios.map(s => s.code);
const byCode = (df, c) => df.scenarios.find(s => s.code === c);
const getAs  = u => request(companyApp).get('/v1/company/datafile').set('Authorization', `Bearer ${token(u)}`);
const putAs  = (u, body) => request(companyApp).put('/v1/company/datafile/json').set('Authorization', `Bearer ${token(u)}`).send(body);

beforeAll(() => {
  fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Tester Merge Co', ?, 'https://merge.example')`, [companyId, slug]);
  for (const u of [ANA, BEN, TM]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, ?, 'x', ?, 'bearer', ?)`,
      [u.id, companyId, u.email, u.role, colEncrypt('tok')]);
  }
});

beforeEach(() => {
  const content = JSON.stringify(storedFile(), null, 4);
  encryptToFile(content, LIVE_PATH);
  run(`UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?`,
    [LIVE_PATH, crypto.createHash('sha256').update(content).digest('hex'), companyId]);
  run('DELETE FROM run_selections WHERE company_id = ?', [companyId]);
});

afterAll(() => {
  for (const f of fs.readdirSync(path.dirname(LIVE_PATH)).filter(n => n.startsWith(slug))) {
    try { fs.unlinkSync(path.join(path.dirname(LIVE_PATH), f)); } catch (_) { /* ignore */ }
  }
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  safe('DELETE FROM runs WHERE company_id = ?', [companyId]);
  safe('DELETE FROM companies WHERE id = ?', [companyId]);   // cascades run_selections
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

// ── What each role sees ───────────────────────────────────────────────────────
describe('GET /v1/company/datafile', () => {
  test('a tester sees their own, the shared and the company scenarios — not other people\'s private ones', async () => {
    const res = await getAs(ANA);
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1']);
    expect(JSON.stringify(res.body)).not.toMatch(/"(ben|tm)"/);    // nor the resource entries only those use
  });

  test('the Test Manager still sees everything', async () => {
    const res = await getAs(TM);
    expect(codes(res.body)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV']);
  });
});

// ── What a tester's save can change ───────────────────────────────────────────
describe('PUT /v1/company/datafile/json by a tester', () => {
  test('changes only their own scenarios; shared, company and other people\'s are kept exactly', async () => {
    const before = onDisk();
    const sent = (await getAs(ANA)).body;
    byCode(sent, 'ANA_1').note = 'edited by Ana';
    byCode(sent, 'SHARED_1').note = 'Ana tries to edit the shared one';
    sent.scenarios.push(scenario('ANA_NEW', ANA, 60));
    for (const [list, off] of [['tripRequirements', 0], ['passengersList', 1], ['purchaserList', 2], ['requestedFulfillmentOptionsList', 3]]) {
      sent[list].push({ id: 60 + off, tag: 'ana-new' });
    }
    sent.systemInfoParameters = { owner: 'Ana' };

    const res = await putAs(ANA, sent);
    expect(res.status).toBe(200);
    expect(res.body.read_only_ignored).toEqual(['SHARED_1']);

    const after = onDisk();
    expect(codes(after)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV', 'ANA_NEW']);
    expect(byCode(after, 'ANA_1').note).toBe('edited by Ana');
    expect(byCode(after, 'ANA_NEW').created_by).toBe(ANA.email);
    for (const c of ['SHARED_1', 'LEGACY_1', 'BEN_1', 'TM_PRIV']) expect(byCode(after, c)).toEqual(byCode(before, c));
    expect(after.systemInfoParameters).toEqual({ owner: 'company' });
    // datafile_hash still describes the file on disk
    const hash = crypto.createHash('sha256').update(decryptFromFile(LIVE_PATH)).digest('hex');
    expect(get('SELECT datafile_hash FROM companies WHERE id = ?', [companyId]).datafile_hash).toBe(hash);
  });

  // scenarios.js saveDatafile re-reads the file after saving and compares its
  // run list with what the server said it stored (res.body.to_run). Comparing
  // with what the editor SENT gave false "Mismatch after save!" alarms whenever
  // the server normalised the list (duplicates removed, a code renamed).
  const sort = a => [...a].sort();
  test('the editor\'s save-then-verify round trip agrees (no "Mismatch after save!")', async () => {
    const sent = (await getAs(ANA)).body;
    sent.scenariosToRun = ['ANA_1', 'SHARED_1'];
    const res = await putAs(ANA, sent);
    expect(res.status).toBe(200);
    const verified = (await getAs(ANA)).body;                         // what scenarios.js re-reads after saving
    expect(sort(verified.scenariosToRun)).toEqual(sort(res.body.to_run));
    expect(sort(res.body.to_run)).toEqual(sort(sent.scenariosToRun));
  });

  test('Select All with two scenarios sharing a code: the server de-duplicates, and the check still agrees', async () => {
    const sent = (await getAs(ANA)).body;
    sent.scenariosToRun = ['SHARED_1', 'SHARED_1', 'ANA_1'];          // what selectAll() builds from duplicate codes
    const res = await putAs(ANA, sent);
    expect(res.status).toBe(200);
    expect(sort((await getAs(ANA)).body.scenariosToRun)).toEqual(sort(res.body.to_run));
  });

  test('a new scenario whose code is already taken is stored under a free code — not refused, not dropped', async () => {
    const sent = (await getAs(ANA)).body;
    sent.scenarios.push(scenario('BEN_1', ANA, 70));                  // Ben's code, which Ana cannot see
    sent.scenarios.push(scenario('SHARED_1', ANA, 74));               // a shared code: the wizard's "Add a duplicate anyway?"
    sent.scenariosToRun.push('SHARED_1');
    const res = await putAs(ANA, sent);
    expect(res.status).toBe(200);
    expect(res.body.renamed).toEqual([{ from: 'BEN_1', to: 'BEN_1_2' }, { from: 'SHARED_1', to: 'SHARED_1_2' }]);
    expect(res.body.to_run).toContain('SHARED_1_2');
    const after = onDisk();
    expect(byCode(after, 'BEN_1').created_by).toBe(BEN.email);
    expect(byCode(after, 'SHARED_1').created_by).toBe(TM.email);
    expect(byCode(after, 'BEN_1_2').created_by).toBe(ANA.email);
    expect(byCode(after, 'SHARED_1_2').created_by).toBe(ANA.email);
  });

  test('a tester whose account was deleted mid-session is refused before anything is written', async () => {
    const ghost = { id: crypto.randomUUID(), email: `ghost-${companyId.slice(0, 6)}@merge.test`, role: 'company_user' };
    const bytes = fs.readFileSync(LIVE_PATH);
    const res = await putAs(ghost, (await getAs(ANA)).body);
    expect(res.status).toBe(403);
    expect(fs.readFileSync(LIVE_PATH).equals(bytes)).toBe(true);
  });

  test('a company-level key a tester sends is never stored (Bruno turns systemInfoParameters into env vars)', async () => {
    const sent = (await getAs(ANA)).body;
    sent.systemInfoParameters = { api_base: 'https://attacker.example' };
    expect((await putAs(ANA, sent)).status).toBe(200);
    expect(onDisk().systemInfoParameters).toEqual({ owner: 'company' });
  });

  test('DELETE waits for a write already holding the lock, so it cannot be undone by it', async () => {
    const { withDatafileLock } = require('../../src/utils/datafileLock');
    const order = [];
    const inFlight = withDatafileLock(companyId, async () => {       // stands in for a tester merge mid-await
      await new Promise(r => setTimeout(r, 150));
      order.push('write');
    });
    const del = request(companyApp).delete('/v1/company/datafile').set('Authorization', `Bearer ${token(TM)}`)
      .then(r => { order.push('delete'); return r; });
    const [, res] = await Promise.all([inFlight, del]);
    expect(res.status).toBe(200);
    expect(order).toEqual(['write', 'delete']);
    expect(get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]).datafile_path).toBeNull();
  });

  test('two testers saving at the same moment both keep their work', async () => {
    const [anaView, benView] = [(await getAs(ANA)).body, (await getAs(BEN)).body];
    anaView.scenarios.push(scenario('ANA_X', ANA, 80));
    benView.scenarios.push(scenario('BEN_X', BEN, 90));
    const [a, b] = await Promise.all([putAs(ANA, anaView), putAs(BEN, benView)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(codes(onDisk())).toEqual(expect.arrayContaining(['ANA_X', 'BEN_X', 'SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV']));
  });
});

// ── Personal run lists ────────────────────────────────────────────────────────
describe('personal run lists', () => {
  test('each tester keeps their own; the Test Manager\'s company list is untouched', async () => {
    const anaView = (await getAs(ANA)).body;
    anaView.scenariosToRun = ['ANA_1'];
    const benView = (await getAs(BEN)).body;
    benView.scenariosToRun = ['SHARED_1', 'BEN_1'];
    expect((await putAs(ANA, anaView)).status).toBe(200);
    expect((await putAs(BEN, benView)).status).toBe(200);

    expect((await getAs(ANA)).body.scenariosToRun).toEqual(['ANA_1']);
    expect((await getAs(BEN)).body.scenariosToRun).toEqual(['SHARED_1', 'BEN_1']);
    expect((await getAs(TM)).body.scenariosToRun).toEqual(storedFile().scenariosToRun);
  });

  test('POST /v1/runs runs the tester\'s own list, and never another tester\'s private scenario', async () => {
    const anaView = (await getAs(ANA)).body;
    anaView.scenariosToRun = ['ANA_1', 'SHARED_1'];
    expect((await putAs(ANA, anaView)).status).toBe(200);

    const res = await request(runsApp).post('/v1/runs').set('Authorization', `Bearer ${token(ANA)}`).send({});
    expect(res.status).toBe(202);
    const queued = get('SELECT group_concat(scenario_code) AS c FROM (SELECT scenario_code FROM runs WHERE batch_id = ? ORDER BY scenario_code)', [res.body.batch_id]).c;
    expect(queued.split(',')).toEqual(['ANA_1', 'SHARED_1']);
  });

  test('without a personal list, a tester runs the company default — minus the scenarios they cannot see', async () => {
    const res = await request(runsApp).post('/v1/runs').set('Authorization', `Bearer ${token(BEN)}`).send({});
    expect(res.status).toBe(202);
    const queued = get('SELECT group_concat(scenario_code) AS c FROM (SELECT scenario_code FROM runs WHERE batch_id = ? ORDER BY scenario_code)', [res.body.batch_id]).c;
    expect(queued.split(',')).toEqual(['BEN_1', 'LEGACY_1', 'SHARED_1']);   // not ANA_1, not TM_PRIV
  });

  test('the Test Manager still runs the company list', async () => {
    const res = await request(runsApp).post('/v1/runs').set('Authorization', `Bearer ${token(TM)}`).send({});
    expect(res.status).toBe(202);
    expect(res.body.runs.length).toBe(5);
  });
});
