// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-round-trip.test.js — #549: "Upload datafile" and
 * "Download JSON" are a safe round trip.
 *
 *   - a wrong file type answers 400 "Only JSON files are accepted.";
 *   - a JSON file that is not a data file is refused with the schema problems;
 *   - a Test Manager's download is the stored file byte for byte, and
 *     uploading it again leaves the hash unchanged;
 *   - a tester's download is marked as a personal view, and the upload
 *     refuses it;
 *   - an upload changes the data file and nothing else (framework, test data);
 *   - the file an upload replaced can be restored, and a restore undone;
 *   - all of it follows the provider the request names (#540).
 *
 * Every refusal is checked against the stored file, not only the status.
 * datafileMutationLimiter allows twenty writes per app instance: this file
 * makes fewer. The schema is read from the repository's collection.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-datafile-round-trip';
// The schema the runs use. tests/setup.js points COLLECTION_PATH at an empty
// folder, which another test file briefly fills with a stub schema.
process.env.COLLECTION_PATH = require('node:path').resolve(__dirname, '../../../Bruno_Collection');

const fs      = require('node:fs');
const path    = require('node:path');
const crypto  = require('node:crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { asValidDatafile } = require('../helpers/valid-datafile');
const { run, get } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId  = crypto.randomUUID();
const slug       = `round-trip-${companyId.slice(0, 8)}`;
const providerId = crypto.randomUUID();
const provSlug   = `round-trip-prov-${providerId.slice(0, 8)}`;
const DIR        = path.resolve(__dirname, '../../data/datafiles');
const livePath   = s => path.join(DIR, `${s}-datafile.json`);
const prevPath   = s => path.join(DIR, `${s}-datafile.previous.json`);

const TM    = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@round-trip.test`,  role: 'test_manager' };
const ANA   = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@round-trip.test`, role: 'company_user' };
const BEN   = { id: crypto.randomUUID(), email: `ben-${companyId.slice(0, 6)}@round-trip.test`, role: 'company_user' };

const token = u => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' });
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// The stored file, written the way no browser would re-write it: two-space
// indent, a key order of its own, a non-ASCII character. A download that is
// not byte for byte the stored file shows here.
const STORED = asValidDatafile({
  scenarios: [
    { code: 'SHARED_1', shared: true, created_by: TM.email, description: 'Zürich — shared' },
    { code: 'BEN_PRIVATE', shared: false, created_by: BEN.email },
    { code: 'ANA_OWN', shared: false, created_by: ANA.email },
  ],
  scenariosToRun: ['SHARED_1', 'BEN_PRIVATE', 'ANA_OWN'],
});
const STORED_TEXT = JSON.stringify(STORED, null, 2) + '\n';

function seed(s, text, id) {
  fs.mkdirSync(DIR, { recursive: true });
  encryptToFile(text, livePath(s));
  fs.rmSync(prevPath(s), { force: true });
  run('UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?', [livePath(s), sha256(text), id]);
}
const plain  = s => decryptFromFile(livePath(s)).toString('utf8');
const hashOf = id => get('SELECT datafile_hash FROM companies WHERE id = ?', [id]).datafile_hash;

const upload = (u, buf, name = 'datafile.json', headers = {}) => {
  const r = request(app).post('/v1/company/datafile').set('Authorization', `Bearer ${token(u)}`);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.attach('datafile', Buffer.isBuffer(buf) ? buf : Buffer.from(buf), name);
};
const download = (u, headers = {}) => {
  const r = request(app).get('/v1/company/datafile/download').set('Authorization', `Bearer ${token(u)}`)
    .buffer(true).parse((res, cb) => { const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
};

function expectStoredUnchanged() {
  expect(plain(slug)).toBe(STORED_TEXT);
  expect(hashOf(companyId)).toBe(sha256(STORED_TEXT));
  expect(fs.existsSync(prevPath(slug))).toBe(false);
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Round Trip Co', ?, 'https://round-trip.example')`, [companyId, slug]);
  run(`INSERT INTO companies (id, name, slug, api_base, parent_id) VALUES (?, 'Round Trip Provider', ?, 'https://round-trip-prov.example', ?)`,
    [providerId, provSlug, companyId]);
  for (const u of [TM, ANA, BEN]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, companyId, u.email, u.role]);
  }
});

beforeEach(() => seed(slug, STORED_TEXT, companyId));

afterAll(() => {
  for (const f of fs.readdirSync(DIR).filter(n => n.startsWith(slug) || n.startsWith(provSlug))) {
    fs.rmSync(path.join(DIR, f), { force: true });
  }
  const safe = (sql, p) => { try { run(sql, p); } catch { /* ignore */ } };
  safe('DELETE FROM auth_events WHERE company_id IN (?, ?)', [companyId, providerId]);
  safe('DELETE FROM test_resources WHERE company_id = ?', [companyId]);
  safe('DELETE FROM test_frameworks WHERE company_id = ?', [companyId]);
  safe('DELETE FROM companies WHERE id IN (?, ?)', [providerId, companyId]);
  safe('DELETE FROM users WHERE company_id = ?', [companyId]);
});

describe('refused uploads say why and change nothing', () => {
  test('a file that is not JSON by type answers 400 "Only JSON files are accepted."', async () => {
    const res = await upload(TM, STORED_TEXT, 'datafile.txt');
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('Only JSON files are accepted.');
    expectStoredUnchanged();
  });

  test('JSON that is not a data file is refused with the schema problems', async () => {
    const res = await upload(TM, '{}');
    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual([
      "'scenarios' is missing.",
      "'requestedFulfillmentOptionsList' is missing.",
      "'tripRequirements' is missing.",
      "'passengersList' is missing.",
    ]);
    expect(res.body.detail).toContain('not a valid data file');
    expectStoredUnchanged();
  });

  test('a problem deep in the file is named by its place', async () => {
    const df = asValidDatafile({ scenarios: [{ code: 'A' }, { code: 'B', loggingType: 'LOUD' }] });
    const res = await upload(TM, JSON.stringify(df));
    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual(["'scenarios[1].loggingType' is 'LOUD', which is not one of: FULL, INFO, DEBUG, ERROR."]);
    expectStoredUnchanged();
  });
});

describe('the round trip', () => {
  test('a Test Manager downloads the stored file byte for byte, and uploading it changes nothing', async () => {
    // An upload changes the data file and nothing else.
    run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [crypto.randomUUID(), companyId, '{"osdmVersion":"3.9.0"}']);
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'hand-edited', '{}')`, [crypto.randomUUID(), companyId]);
    const fwBefore  = get('SELECT config, updated_at FROM test_frameworks WHERE company_id = ?', [companyId]);
    const resBefore = get('SELECT COUNT(*) AS n FROM test_resources WHERE company_id = ?', [companyId]).n;

    const dl = await download(TM);
    expect(dl.status).toBe(200);
    expect(dl.body.toString('utf8')).toBe(STORED_TEXT);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="${slug}-datafile-${new Date().toISOString().slice(0, 10)}.json"`);

    const res = await upload(TM, dl.body, `${slug}-datafile.json`);
    expect(res.status).toBe(200);
    expect(res.body.hash).toBe(sha256(STORED_TEXT));
    expect(hashOf(companyId)).toBe(sha256(STORED_TEXT));
    expect(plain(slug)).toBe(STORED_TEXT);
    expect(res.body.scenarios_count).toBe(3);

    expect(get('SELECT config, updated_at FROM test_frameworks WHERE company_id = ?', [companyId])).toEqual(fwBefore);
    expect(get('SELECT COUNT(*) AS n FROM test_resources WHERE company_id = ?', [companyId]).n).toBe(resBefore);
  });

  test('a tester\'s download is a marked personal view, and the upload refuses it', async () => {
    const dl = await download(ANA);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain(`${slug}-datafile-personal-view-`);
    const view = JSON.parse(dl.body.toString('utf8'));
    expect(view.__oscarPersonalView.company).toBe(slug);
    expect(view.scenarios.map(s => s.code)).toEqual(['SHARED_1', 'ANA_OWN']);     // not Ben's private one

    const res = await upload(TM, dl.body);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('personal view');
    expectStoredUnchanged();
  });

  test('the page\'s "unsaved edits" copy is refused the same way', async () => {
    const res = await upload(TM, JSON.stringify({ __oscarUnsavedEdits: { note: 'x' }, ...STORED }));
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('edits that were not saved');
    expectStoredUnchanged();
  });
});

describe('the previous file', () => {
  test('an upload keeps what it replaced; a restore puts it back and can itself be undone', async () => {
    const next = JSON.stringify(asValidDatafile({ scenarios: [{ code: 'NEW_ONLY' }] }));
    const up = await upload(TM, next);
    expect(up.status).toBe(200);
    expect(up.body.previous).toEqual({ hash: sha256(STORED_TEXT), scenarios_count: 3 });

    const info = await request(app).get('/v1/company/datafile/previous').set('Authorization', `Bearer ${token(TM)}`);
    expect(info.body).toMatchObject({ exists: true, hash: sha256(STORED_TEXT), scenarios_count: 3 });

    const back = await request(app).post('/v1/company/datafile/previous/restore').set('Authorization', `Bearer ${token(TM)}`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ restored: true, hash: sha256(STORED_TEXT), scenarios_count: 3, previous_kept: true });
    expect(plain(slug)).toBe(STORED_TEXT);
    expect(hashOf(companyId)).toBe(sha256(STORED_TEXT));
    expect(decryptFromFile(prevPath(slug)).toString('utf8')).toBe(next);
    expect(fs.readFileSync(prevPath(slug)).toString('utf8')).not.toContain('NEW_ONLY');   // encrypted at rest

    const again = await request(app).post('/v1/company/datafile/previous/restore').set('Authorization', `Bearer ${token(TM)}`);
    expect(again.status).toBe(200);
    expect(plain(slug)).toBe(next);
  });

  test('nothing to restore is a 404; testers may neither see nor restore it', async () => {
    const none = await request(app).post('/v1/company/datafile/previous/restore').set('Authorization', `Bearer ${token(TM)}`);
    expect(none.status).toBe(404);
    expect((await request(app).get('/v1/company/datafile/previous').set('Authorization', `Bearer ${token(TM)}`)).body).toEqual({ exists: false });

    encryptToFile('{"scenarios":[]}', prevPath(slug));
    const asTester = await request(app).post('/v1/company/datafile/previous/restore').set('Authorization', `Bearer ${token(ANA)}`);
    expect(asTester.status).toBe(403);
    expect((await request(app).get('/v1/company/datafile/previous').set('Authorization', `Bearer ${token(ANA)}`)).status).toBe(403);
    expect(plain(slug)).toBe(STORED_TEXT);
  });

  test('a delete removes the previous file too', async () => {
    encryptToFile('{"scenarios":[]}', prevPath(slug));
    const res = await request(app).delete('/v1/company/datafile').set('Authorization', `Bearer ${token(TM)}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(prevPath(slug))).toBe(false);
  });
});

describe('a provider (#540)', () => {
  test('the upload, the download and the previous file follow X-Provider-Id', async () => {
    const provText = JSON.stringify(asValidDatafile({ scenarios: [{ code: 'PROV_1' }] }));
    seed(provSlug, provText, providerId);
    const next = JSON.stringify(asValidDatafile({ scenarios: [{ code: 'PROV_2' }] }));

    const res = await upload(TM, next, 'datafile.json', { 'X-Provider-Id': providerId });
    expect(res.status).toBe(200);
    expect(plain(provSlug)).toBe(next);
    expect(decryptFromFile(prevPath(provSlug)).toString('utf8')).toBe(provText);
    expectStoredUnchanged();                      // the distributor's own file

    const dl = await download(TM, { 'X-Provider-Id': providerId });
    expect(dl.body.toString('utf8')).toBe(next);
    expect(dl.headers['content-disposition']).toContain(`${provSlug}-datafile-`);
  });
});
