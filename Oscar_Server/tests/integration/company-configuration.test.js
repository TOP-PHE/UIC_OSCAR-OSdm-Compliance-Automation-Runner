// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-configuration.test.js — #810: a full configuration (data file,
 * Test Framework, Test Data) downloaded from one company and imported into a
 * provider of it, with the parts the Test Manager chose.
 *
 *   - the download holds the three parts and nothing else: no endpoint, no
 *     dedicated header value, no MULTIMODAL entry;
 *   - testers can neither download nor import one;
 *   - the data-file upload refuses it;
 *   - "add" adds what is missing and remaps the journeys' legs to the trains'
 *     new ids; "replace" removes the target's trains and journeys first;
 *   - a refused import changes nothing, in any of the three stores, and an
 *     import whose database step fails puts the data file back.
 *
 * datafileMutationLimiter allows twenty writes per app instance: this file
 * makes fewer. The schema is read from the repository's collection.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-configuration';
process.env.COLLECTION_PATH = require('node:path').resolve(__dirname, '../../../Bruno_Collection');

const fs      = require('node:fs');
const path    = require('node:path');
const crypto  = require('node:crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { asValidDatafile } = require('../helpers/valid-datafile');
const db = require('../../src/db/db');
const { run, get, all, colEncrypt, colDecrypt } = db;
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId  = crypto.randomUUID();
const slug       = `conf-${companyId.slice(0, 8)}`;
const providerId = crypto.randomUUID();
const provSlug   = `conf-prov-${providerId.slice(0, 8)}`;
const DIR        = path.resolve(__dirname, '../../data/datafiles');
const livePath   = s => path.join(DIR, `${s}-datafile.json`);
const prevPath   = s => path.join(DIR, `${s}-datafile.previous.json`);

const TM  = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@conf.test`,  role: 'test_manager' };
const ANA = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@conf.test`, role: 'company_user' };

const token = u => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' });
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

const HEADER_SECRET = 'header-secret-value-0451';
const SOURCE_DATAFILE = asValidDatafile({
  scenarios: [
    { code: 'A_SHARED', shared: true, created_by: TM.email },
    { code: 'A_ANA', shared: false, created_by: ANA.email },
  ],
  scenariosToRun: ['A_SHARED'],
});
const SOURCE_FRAMEWORK = { osdmVersion: '3.8.0', salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT'] };
const train = (n, from, to) => ({ originURN: `urn:uic:stn:${from}`, destinationURN: `urn:uic:stn:${to}`, operatorCode: 'X1',
  daysOfWeek: [], services: [{ vehicleNumber: String(n), departureTime: '08:00:00+01:00', arrivalTime: '09:00:00+01:00' }] });

const PROVIDER_DATAFILE = asValidDatafile({ scenarios: [{ code: 'P_OWN', shared: true, created_by: TM.email }] });
const PROVIDER_DATAFILE_TEXT = JSON.stringify(PROVIDER_DATAFILE, null, 2);
const PROVIDER_FRAMEWORK = { osdmVersion: '3.6.0', salesFlows: ['SALE'] };
const PROVIDER_TRAIN = train(900, '0000901', '0000902');

function insertResource(company, type, label, data, id = crypto.randomUUID()) {
  run('INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)',
    [id, company, type, label, colEncrypt(JSON.stringify(data))]);
  return id;
}
function setFramework(company, config) {
  run('DELETE FROM test_frameworks WHERE company_id = ?', [company]);
  run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [crypto.randomUUID(), company, colEncrypt(JSON.stringify(config))]);
}
const frameworkOf = company => {
  const row = get('SELECT config FROM test_frameworks WHERE company_id = ?', [company]);
  return row ? JSON.parse(colDecrypt(row.config)) : null;
};
const resourcesOf = company => all('SELECT id, resource_type, label, data FROM test_resources WHERE company_id = ? ORDER BY created_at, label', [company])
  .map(r => ({ ...r, data: JSON.parse(colDecrypt(r.data)) }));

function seedProvider() {
  fs.mkdirSync(DIR, { recursive: true });
  encryptToFile(PROVIDER_DATAFILE_TEXT, livePath(provSlug));
  fs.rmSync(prevPath(provSlug), { force: true });
  run('UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?', [livePath(provSlug), sha256(PROVIDER_DATAFILE_TEXT), providerId]);
  setFramework(providerId, PROVIDER_FRAMEWORK);
  run('DELETE FROM test_resources WHERE company_id = ?', [providerId]);
  insertResource(providerId, 'TRAIN', 'Provider own train', PROVIDER_TRAIN);
}
function expectProviderUnchanged() {
  expect(decryptFromFile(livePath(provSlug)).toString('utf8')).toBe(PROVIDER_DATAFILE_TEXT);
  expect(get('SELECT datafile_hash FROM companies WHERE id = ?', [providerId]).datafile_hash).toBe(sha256(PROVIDER_DATAFILE_TEXT));
  expect(fs.existsSync(prevPath(provSlug))).toBe(false);
  expect(frameworkOf(providerId)).toEqual(PROVIDER_FRAMEWORK);
  const res = resourcesOf(providerId);
  expect(res).toHaveLength(1);
  expect(res[0].data).toEqual(PROVIDER_TRAIN);
}

const asBuffer = r => r.buffer(true).parse((res, cb) => { const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });
const download = (u, headers = {}) => {
  const r = asBuffer(request(app).get('/v1/company/configuration/download').set('Authorization', `Bearer ${token(u)}`));
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
};
const importInto = (u, file, choices, headers = { 'X-Provider-Id': providerId }) => {
  const r = request(app).post('/v1/company/configuration/import').set('Authorization', `Bearer ${token(u)}`);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  for (const [k, v] of Object.entries(choices)) r.field(k, v);
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(typeof file === 'string' ? file : JSON.stringify(file));
  return r.attach('configuration', bytes, 'configuration.json');
};
const ALL_IN = { scenarios: 'replace', framework: 'replace', testData: 'add' };

let trainIds;
let journeyId;
let bundleBytes;
let bundle;

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug, api_base, extra_headers) VALUES (?, 'Conf Co', ?, 'https://conf-source.example', ?)`,
    [companyId, slug, colEncrypt(JSON.stringify([{ name: 'X-Secret', value: HEADER_SECRET }]))]);
  run(`INSERT INTO companies (id, name, slug, api_base, parent_id) VALUES (?, 'Conf Provider', ?, 'https://conf-prov.example', ?)`,
    [providerId, provSlug, companyId]);
  for (const u of [TM, ANA]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, companyId, u.email, u.role]);
  }
  const text = JSON.stringify(SOURCE_DATAFILE, null, 2);
  fs.mkdirSync(DIR, { recursive: true });
  encryptToFile(text, livePath(slug));
  run('UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?', [livePath(slug), sha256(text), companyId]);
  setFramework(companyId, SOURCE_FRAMEWORK);
  trainIds = [
    insertResource(companyId, 'TRAIN', 'T1', train(101, '0000001', '0000002')),
    insertResource(companyId, 'TRAIN', 'T2', train(102, '0000002', '0000003')),
  ];
  journeyId = insertResource(companyId, 'JOURNEY', 'J1', { legs: [
    { trainResourceId: trainIds[0], serviceIndex: 0 }, { trainResourceId: trainIds[1], serviceIndex: 0 }] });
  insertResource(companyId, 'MULTIMODAL', 'M1', { note: 'not exported' });

  const res = await download(TM);
  expect(res.status).toBe(200);
  bundleBytes = res.body;
  bundle = JSON.parse(bundleBytes.toString('utf8'));
});

beforeEach(seedProvider);

afterAll(() => {
  jest.restoreAllMocks();
  for (const f of fs.readdirSync(DIR).filter(n => n.startsWith(slug) || n.startsWith(provSlug))) {
    fs.rmSync(path.join(DIR, f), { force: true });
  }
  const safe = (sql, p) => { try { run(sql, p); } catch { /* ignore */ } };
  safe('DELETE FROM auth_events WHERE company_id IN (?, ?)', [companyId, providerId]);
  safe('DELETE FROM test_resources WHERE company_id IN (?, ?)', [companyId, providerId]);
  safe('DELETE FROM test_frameworks WHERE company_id IN (?, ?)', [companyId, providerId]);
  safe('DELETE FROM companies WHERE id IN (?, ?)', [providerId, companyId]);
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

describe('the download', () => {
  test('holds the data file, the framework and the trains and journeys, under its marker', () => {
    expect(bundle.__oscarConfiguration).toMatchObject({ format: 1, company: slug, exported_by: TM.email });
    expect(bundle.datafile).toEqual(SOURCE_DATAFILE);
    expect(bundle.framework).toEqual(SOURCE_FRAMEWORK);
    expect(bundle.testResources.map(r => `${r.resource_type}:${r.label}`).sort((a, b) => a.localeCompare(b))).toEqual(['JOURNEY:J1', 'TRAIN:T1', 'TRAIN:T2']);
  });

  test('holds no endpoint, no dedicated header value and no tester data beyond the data file', () => {
    const text = bundleBytes.toString('utf8');
    expect(text).not.toContain('conf-source.example');
    expect(text).not.toContain(HEADER_SECRET);
    expect(text).not.toContain('not exported');
    expect(Object.keys(bundle).sort((a, b) => a.localeCompare(b))).toEqual(['__oscarConfiguration', 'datafile', 'framework', 'testResources']);
  });

  test('is named after the company and the day', async () => {
    const res = await download(TM);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${slug}-configuration-\\d{4}-\\d{2}-\\d{2}\\.json"$`));
  });

  test('is refused to a tester', async () => {
    const res = await download(ANA);
    expect(res.status).toBe(403);
  });
});

describe('refusals change nothing', () => {
  test('a tester cannot import', async () => {
    const res = await importInto(ANA, bundleBytes, ALL_IN, {});
    expect(res.status).toBe(403);
  });

  test('the data-file upload refuses a configuration and names the import', async () => {
    const res = await request(app).post('/v1/company/datafile').set('Authorization', `Bearer ${token(TM)}`)
      .set('X-Provider-Id', providerId).attach('datafile', bundleBytes, 'configuration.json');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/full OSCAR configuration/);
    expectProviderUnchanged();
  });

  test('a missing or unknown choice, or keeping everything', async () => {
    let res = await importInto(TM, bundleBytes, { scenarios: 'replace', framework: 'replace' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/"testData" must be/);
    res = await importInto(TM, bundleBytes, { scenarios: 'keep', framework: 'keep', testData: 'keep' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Nothing to import/);
    expectProviderUnchanged();
  });

  test('a data file that is not valid stops the framework and the trains too', async () => {
    const broken = { ...bundle, datafile: { scenarios: 'no' } };
    const res = await importInto(TM, broken, ALL_IN);
    expect(res.status).toBe(400);
    expect(res.body.problems.length).toBeGreaterThan(0);
    expectProviderUnchanged();
  });

  test('a template added in the data file stops everything', async () => {
    const templated = structuredClone(bundle);
    templated.datafile.scenarios[0].description = 'see {{access_token}}';
    const res = await importInto(TM, templated, ALL_IN);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/\{\{/);
    expectProviderUnchanged();
  });

  test('a framework whose OSDM version is not one', async () => {
    const bad = { ...bundle, framework: { ...SOURCE_FRAMEWORK, osdmVersion: '3..8' } };
    const res = await importInto(TM, bad, ALL_IN);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/not a version/);
    expectProviderUnchanged();
  });

  test('a database failure puts the data file back', async () => {
    const spy = jest.spyOn(db, 'transaction').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const res = await importInto(TM, bundleBytes, ALL_IN);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expectProviderUnchanged();
  });
});

describe('an import into a provider', () => {
  test('replace + replace + add: the scenarios and framework of the source, its trains added and the journey remapped', async () => {
    const res = await importInto(TM, bundleBytes, ALL_IN);
    expect(res.status).toBe(200);
    expect(res.body.scenarios).toMatchObject({ replaced: true, scenarios_count: 2, previous: { scenarios_count: 1 } });
    expect(res.body.testData).toMatchObject({ mode: 'add', trains_added: 2, journeys_added: 1, already_there: 0, removed: 0, unresolved_legs: 0 });

    expect(JSON.parse(decryptFromFile(livePath(provSlug)).toString('utf8'))).toEqual(SOURCE_DATAFILE);
    expect(decryptFromFile(prevPath(provSlug)).toString('utf8')).toBe(PROVIDER_DATAFILE_TEXT);
    expect(frameworkOf(providerId)).toEqual(SOURCE_FRAMEWORK);

    const res2 = resourcesOf(providerId);
    const trains = res2.filter(r => r.resource_type === 'TRAIN');
    expect(trains.map(t => t.label).sort((a, b) => a.localeCompare(b))).toEqual(['Provider own train', 'T1', 'T2']);
    const journey = res2.find(r => r.resource_type === 'JOURNEY');
    const byLabel = Object.fromEntries(trains.map(t => [t.label, t.id]));
    expect(journey.data.legs.map(l => l.trainResourceId)).toEqual([byLabel.T1, byLabel.T2]);
    // New ids: the source's rows are not shared.
    expect(trainIds).not.toContain(byLabel.T1);
    expect(journey.id).not.toBe(journeyId);
    // The source company is untouched.
    expect(resourcesOf(companyId)).toHaveLength(4);
  });

  test('a second "add" adds nothing', async () => {
    let res = await importInto(TM, bundleBytes, { scenarios: 'keep', framework: 'keep', testData: 'add' });
    expect(res.status).toBe(200);
    res = await importInto(TM, bundleBytes, { scenarios: 'keep', framework: 'keep', testData: 'add' });
    expect(res.body.testData).toMatchObject({ trains_added: 0, journeys_added: 0, already_there: 3 });
    expect(resourcesOf(providerId)).toHaveLength(4);
    // Kept parts are kept.
    expect(decryptFromFile(livePath(provSlug)).toString('utf8')).toBe(PROVIDER_DATAFILE_TEXT);
    expect(frameworkOf(providerId)).toEqual(PROVIDER_FRAMEWORK);
  });

  test('"replace" removes the provider\'s own trains first', async () => {
    const res = await importInto(TM, bundleBytes, { scenarios: 'keep', framework: 'keep', testData: 'replace' });
    expect(res.status).toBe(200);
    expect(res.body.testData).toMatchObject({ mode: 'replace', removed: 1, trains_added: 2, journeys_added: 1 });
    const labels = resourcesOf(providerId).map(r => r.label).sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(['J1', 'T1', 'T2']);
  });
});
