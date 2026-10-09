// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-stale-save.test.js — a Test Config save made from a data
 * file that is no longer the current one is refused (#540), end to end
 * through GET /datafile and PUT /datafile/json.
 *
 * One company, two testers (Ana, Ben) and a Test Manager. The file is seeded
 * to disk before every test. datafileMutationLimiter allows twenty writes per
 * app instance; this file makes fewer.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-stale-save';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const companyApp = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId = crypto.randomUUID();
const slug      = `stale-save-${companyId.slice(0, 8)}`;
const LIVE_PATH = path.resolve(__dirname, '../../data/datafiles', `${slug}-datafile.json`);

const ANA = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@stale.test`, role: 'company_user' };
const BEN = { id: crypto.randomUUID(), email: `ben-${companyId.slice(0, 6)}@stale.test`, role: 'company_user' };
const TM  = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@stale.test`,  role: 'test_manager' };

const token = u => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' });

function scenario(code, owner, id, shared = false) {
  return { code, shared, created_by: owner.email, tripRequirementId: id, passengersListId: id };
}
function storedFile() {
  return {
    scenariosToRun: ['SHARED_1'],
    scenarios: [scenario('SHARED_1', TM, 1, true), scenario('ANA_1', ANA, 2), scenario('BEN_1', BEN, 3)],
    tripRequirements: [{ id: 1, t: 's' }, { id: 2, t: 'a' }, { id: 3, t: 'b' }],
    passengersList: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
}
function seed(df) {
  encryptToFile(JSON.stringify(df, null, 4), LIVE_PATH);
  run('UPDATE companies SET datafile_path = ? WHERE id = ?', [LIVE_PATH, companyId]);
}
const onDisk = () => JSON.parse(decryptFromFile(LIVE_PATH).toString('utf8'));
const getAs  = u => request(companyApp).get('/v1/company/datafile').set('Authorization', `Bearer ${token(u)}`);
const putAs  = (u, body, headers = {}) => {
  const r = request(companyApp).put('/v1/company/datafile/json').set('Authorization', `Bearer ${token(u)}`);
  for (const [k, val] of Object.entries(headers)) r.set(k, val);
  return r.send(body);
};
// What the editor sends back: the body it loaded, `__` annotations and all.
const edited = (body, fn) => { const copy = structuredClone(body); fn(copy); return copy; };

beforeAll(() => {
  fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Stale Save Co', ?, 'https://stale.example')`, [companyId, slug]);
  for (const u of [ANA, BEN, TM]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, companyId, u.email, u.role]);
  }
});

beforeEach(() => {
  seed(storedFile());
  run('DELETE FROM run_selections WHERE company_id = ?', [companyId]);
});

afterAll(() => {
  for (const f of fs.readdirSync(path.dirname(LIVE_PATH)).filter(n => n.startsWith(slug))) {
    try { fs.unlinkSync(path.join(path.dirname(LIVE_PATH), f)); } catch (_) { /* ignore */ }
  }
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  safe('DELETE FROM companies WHERE id = ?', [companyId]);
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

describe('GET /v1/company/datafile sends a version', () => {
  test('the same until the file changes; a tester\'s is of their view', async () => {
    const [a, b, ana] = [await getAs(TM), await getAs(TM), await getAs(ANA)];
    expect(a.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(b.headers.etag).toBe(a.headers.etag);
    expect(ana.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(ana.headers.etag).not.toBe(a.headers.etag);
  });
});

describe('PUT /v1/company/datafile/json', () => {
  test('a Test Manager\'s save from the current version is written; its answer names the next version', async () => {
    const loaded = await getAs(TM);
    const res = await putAs(TM, edited(loaded.body, df => { df.scenarios[0].note = 'one'; }), { 'If-Match': loaded.headers.etag });
    expect(res.status).toBe(200);
    expect(onDisk().scenarios[0].note).toBe('one');
    const next = await getAs(TM);
    expect(res.headers.etag).toBe(next.headers.etag);
    expect(res.body.version).toBe(next.headers.etag.slice(1, -1));
  });

  test('a save from a version someone has saved over is refused, and nothing is written', async () => {
    const tab1 = await getAs(TM);
    const tab2 = await getAs(TM);
    expect((await putAs(TM, edited(tab1.body, df => { df.scenarios[0].note = 'tab 1'; }), { 'If-Match': tab1.headers.etag })).status).toBe(200);
    const res = await putAs(TM, edited(tab2.body, df => { df.scenarios.pop(); }), { 'If-Match': tab2.headers.etag });
    expect(res.status).toBe(412);
    expect(res.body.detail).toMatch(/changed since this page loaded it/);
    expect(onDisk().scenarios.map(s => s.code)).toEqual(['SHARED_1', 'ANA_1', 'BEN_1']);
    expect(onDisk().scenarios[0].note).toBe('tab 1');
  });

  test('a save with no version is written, as from a page loaded before this release', async () => {
    const loaded = await getAs(TM);
    seed(edited(storedFile(), df => { df.scenarios[1].note = 'meanwhile'; }));
    expect((await putAs(TM, loaded.body)).status).toBe(200);
  });

  test('a weak tag naming the current version is accepted', async () => {
    const loaded = await getAs(TM);
    expect((await putAs(TM, loaded.body, { 'If-Match': `W/${loaded.headers.etag}` })).status).toBe(200);
  });

  test('a colleague saving their own private scenario does not make a tester\'s page stale', async () => {
    const ana = await getAs(ANA);
    const ben = await getAs(BEN);
    expect((await putAs(BEN, edited(ben.body, df => { df.scenarios.find(s => s.code === 'BEN_1').note = 'ben'; }),
      { 'If-Match': ben.headers.etag })).status).toBe(200);
    const res = await putAs(ANA, edited(ana.body, df => { df.scenarios.find(s => s.code === 'ANA_1').note = 'ana'; }),
      { 'If-Match': ana.headers.etag });
    expect(res.status).toBe(200);
    expect(onDisk().scenarios.find(s => s.code === 'BEN_1').note).toBe('ben');
    expect(onDisk().scenarios.find(s => s.code === 'ANA_1').note).toBe('ana');
  });

  test('a change to what the tester can see makes their page stale', async () => {
    const ana = await getAs(ANA);
    const tm = await getAs(TM);
    expect((await putAs(TM, edited(tm.body, df => { df.scenarios[0].note = 'tm'; }), { 'If-Match': tm.headers.etag })).status).toBe(200);
    const res = await putAs(ANA, ana.body, { 'If-Match': ana.headers.etag });
    expect(res.status).toBe(412);
  });

  test('a tester\'s next save names the version their last save answered', async () => {
    const ana = await getAs(ANA);
    const first = await putAs(ANA, edited(ana.body, df => { df.scenariosToRun = ['ANA_1']; }), { 'If-Match': ana.headers.etag });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe((await getAs(ANA)).headers.etag);
  });

  test('a re-projection of known deviations does not make a page stale', async () => {
    const loaded = await getAs(TM);
    seed({ ...storedFile(), knownDeviations: [{ step: 'x', expected_status: 501 }] });
    expect((await putAs(TM, loaded.body, { 'If-Match': loaded.headers.etag })).status).toBe(200);
  });

  test('If-None-Match: * — a first file is written only while there is none', async () => {
    const res = await putAs(TM, { scenarios: [], scenariosToRun: [] }, { 'If-None-Match': '*' });
    expect(res.status).toBe(412);
    expect(res.body.detail).toMatch(/found none/);
    fs.unlinkSync(LIVE_PATH);
    expect((await putAs(TM, { scenarios: [], scenariosToRun: [] }, { 'If-None-Match': '*' })).status).toBe(200);
  });

  test('a save from a file deleted since is refused', async () => {
    const loaded = await getAs(TM);
    fs.unlinkSync(LIVE_PATH);
    const res = await putAs(TM, loaded.body, { 'If-Match': loaded.headers.etag });
    expect(res.status).toBe(412);
    expect(fs.existsSync(LIVE_PATH)).toBe(false);
  });
});
