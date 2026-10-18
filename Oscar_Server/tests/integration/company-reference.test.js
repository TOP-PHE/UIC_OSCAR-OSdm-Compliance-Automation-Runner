// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-reference.test.js — #838 PR 2: a company or provider follows a
 * reference configuration of the repository, and is updated from it.
 *
 *   - testers read the state, only Test Managers link and update;
 *   - the update replaces the scenarios (the replaced file stays the previous
 *     one), the Test Framework and the Test Data, journeys naming the new
 *     trains; the endpoint is not touched;
 *   - the state says whether the applied version is the reference's.
 *
 * The references are read from the repository's collection.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-reference';
process.env.COLLECTION_PATH = require('node:path').resolve(__dirname, '../../../Bruno_Collection');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { asValidDatafile } = require('../helpers/valid-datafile');
const { run, get, all, colEncrypt, colDecrypt } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');
const R = require('../../src/utils/referenceConfiguration');
const store = require('../../src/utils/referenceStore');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId = crypto.randomUUID();
const slug = `ref-${companyId.slice(0, 8)}`;
const DIR = path.resolve(__dirname, '../../data/datafiles');
const livePath = path.join(DIR, `${slug}-datafile.json`);
const prevPath = path.join(DIR, `${slug}-datafile.previous.json`);

const TM = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@ref.test`, role: 'test_manager' };
const TESTER = { id: crypto.randomUUID(), email: `tst-${companyId.slice(0, 6)}@ref.test`, role: 'company_user' };
const auth = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

const REF = path.resolve(__dirname, '../../../Bruno_Collection/data_base/reference/simulator-beta.json');
const BETA = JSON.parse(fs.readFileSync(REF, 'utf8'));

const OLD_DATAFILE = asValidDatafile({ scenarios: [{ code: 'OLD_ONE', shared: true, created_by: TM.email }] });

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Ref Co', ?, 'https://sim.example/beta')`, [companyId, slug]);
  for (const u of [TM, TESTER]) run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, companyId, u.email, u.role]);
  fs.mkdirSync(DIR, { recursive: true });
  encryptToFile(JSON.stringify(OLD_DATAFILE), livePath);
  run('UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?', [livePath, 'old', companyId]);
  run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [crypto.randomUUID(), companyId, colEncrypt(JSON.stringify({ osdmVersion: '3.4', salesFlows: ['SALE'] }))]);
  run('INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), companyId, 'TRAIN', 'Old train', colEncrypt(JSON.stringify({ originURN: 'urn:uic:stn:9', destinationURN: 'urn:uic:stn:8', services: [] }))]);
});

afterAll(() => {
  fs.rmSync(livePath, { force: true });
  fs.rmSync(prevPath, { force: true });
  // The audit events name the users: the test database is removed by the global teardown.
});

const state = u => request(app).get('/v1/company/reference').set('Authorization', auth(u));
const link = (name, u = TM) => request(app).put('/v1/company/reference').set('Authorization', auth(u)).send({ name });
const apply = (u = TM) => request(app).post('/v1/company/reference/apply').set('Authorization', auth(u));

test('the state lists the three references and says none is followed', async () => {
  const res = await state(TESTER);
  expect(res.status).toBe(200);
  expect(res.body.available.map(r => r.name)).toEqual(['simulator-alpha', 'simulator-beta', 'simulator-gamma']);
  expect(res.body.available[1]).toEqual({ name: 'simulator-beta', provider: 'beta', osdmVersion: '3.7.0' });
  expect(res.body).toMatchObject({ linked: null, up_to_date: false, applied_version: null });
});

test('a tester can neither link nor update; nothing followed is a 409; an unknown name a 400', async () => {
  expect((await link('simulator-beta', TESTER)).status).toBe(403);
  expect((await apply(TESTER)).status).toBe(403);
  expect((await apply()).status).toBe(409);
  expect((await link('../../etc/passwd')).status).toBe(400);
  expect((await link('simulator-delta')).status).toBe(400);
});

test('linking says the configuration is not up to date yet', async () => {
  const res = await link('simulator-beta');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ linked: 'simulator-beta', up_to_date: false, applied_version: null });
  expect(res.body.current_version).toMatch(/^[0-9a-f]{64}$/);
});

test('the update replaces scenarios, framework and Test Data, and keeps the endpoint', async () => {
  const res = await apply();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ applied: true, reference: 'simulator-beta', scenarios: { replaced: true, previous: { scenarios_count: 1 } }, framework: { replaced: true } });
  expect(res.body.state.up_to_date).toBe(true);

  const datafile = JSON.parse(decryptFromFile(livePath).toString('utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/data_base', R.DATAFILE_NAME), 'utf8'));
  expect(datafile.scenarios.map(s => s.code)).toEqual(simulator.scenarios.map(s => s.code));
  expect(datafile.scenariosToRun).toEqual(BETA.scenariosToRun);
  expect(JSON.parse(decryptFromFile(prevPath).toString('utf8')).scenarios[0].code).toBe('OLD_ONE');

  const fw = JSON.parse(colDecrypt(get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]).config));
  expect(fw).toEqual(BETA.framework);

  const rows = all('SELECT id, resource_type, label, data FROM test_resources WHERE company_id = ?', [companyId]).map(r => ({ ...r, data: JSON.parse(colDecrypt(r.data)) }));
  expect(rows.some(r => r.label === 'Old train')).toBe(false);
  expect(rows).toHaveLength(BETA.testResources.length);
  const trainIds = new Set(rows.filter(r => r.resource_type === 'TRAIN').map(r => r.id));
  const journeys = rows.filter(r => r.resource_type === 'JOURNEY');
  expect(journeys.length).toBeGreaterThan(0);
  for (const j of journeys) for (const leg of j.data.legs) expect(trainIds.has(leg.trainResourceId)).toBe(true);

  expect(get('SELECT api_base FROM companies WHERE id = ?', [companyId]).api_base).toBe('https://sim.example/beta');
});

test('a reference that moved on reads as not up to date; another reference forgets the applied version', async () => {
  run(`UPDATE companies SET reference_version = 'an-older-one' WHERE id = ?`, [companyId]);
  expect((await state(TESTER)).body.up_to_date).toBe(false);
  const other = await link('simulator-gamma');
  expect(other.body).toMatchObject({ linked: 'simulator-gamma', applied_version: null, up_to_date: false });
  const none = await link(null);
  expect(none.body).toMatchObject({ linked: null, applied_version: null });
});

describe('the store', () => {
  test('reads no name but the three, and falls back to the repository copy', () => {
    expect(store.loadReference('simulator-delta')).toBeNull();
    expect(store.loadReference('../reference/simulator-beta')).toBeNull();
    const saved = process.env.COLLECTION_PATH;
    process.env.COLLECTION_PATH = path.join(DIR, 'no-such-collection');
    try {
      const loaded = store.loadReference('simulator-alpha');
      expect(loaded.reference[R.REFERENCE_KEY].provider).toBe('alpha');
      expect(loaded.version).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.env.COLLECTION_PATH = saved;
    }
  });
});
