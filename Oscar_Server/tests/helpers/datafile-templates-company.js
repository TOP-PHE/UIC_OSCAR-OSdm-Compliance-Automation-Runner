// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * One company, two testers (Ana, Ben) and a Test Manager, with a datafile seeded
 * straight to disk: the fixture of the NEW-10 route tests. Two test files use
 * it, because the datafile write limiter allows twenty writes per app instance
 * and each test file gets an instance of its own.
 *
 * Call it at the top of a test file; it registers its own beforeAll,
 * beforeEach and afterAll.
 */

const { credentialsAsMigrated } = require('./credentials');
const fs      = require('node:fs');
const path    = require('node:path');
const crypto  = require('node:crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('./test-app');
const { run, get, colEncrypt } = require('../../src/db/db');
const { encryptToFile, decryptFromFile } = require('../../src/utils/at-rest');

const OPEN  = '{'.repeat(2);
const CLOSE = '}'.repeat(2);
const TOKEN = `${OPEN}process.env.OSCAR_ACCESS_TOKEN${CLOSE}`;

function templatesCompany() {
  const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

  const companyId = crypto.randomUUID();
  const slug      = `templates-${companyId.slice(0, 8)}`;
  const LIVE_PATH = path.resolve(__dirname, '../../data/datafiles', `${slug}-datafile.json`);

  const ANA = { id: crypto.randomUUID(), email: `ana-${companyId.slice(0, 6)}@templates.test`, role: 'company_user' };
  const BEN = { id: crypto.randomUUID(), email: `ben-${companyId.slice(0, 6)}@templates.test`, role: 'company_user' };
  const TM  = { id: crypto.randomUUID(), email: `tm-${companyId.slice(0, 6)}@templates.test`,  role: 'test_manager' };

  const token = u => jwt.sign({ sub: u.id, email: u.email, companyId, role: u.role }, process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' });

  function scenario(code, owner, base, shared = false) {
    // #549: what the datafile schema requires, so that the upload accepts it.
    return {
      collection: 'OTST_TEST', loggingType: 'INFO', scenarioType: 'SALE', scenarioAction: null,
      osdmVersion: '3.8.0', overruleCode: null,
      code, shared, ...(owner ? { created_by: owner.email } : {}),
      tripRequirementId: base, passengersListId: base + 1, purchaserListId: base + 2,
      requestedFulfillmentOptionsListId: base + 3,
    };
  }
  // `legacy` puts templates where they could have been stored before the rule existed.
  function storedFile({ legacy = false } = {}) {
    const parts = [
      [scenario('SHARED_1', TM, 10, true), 'shared'],
      [scenario('ANA_1', ANA, 30),         'ana'],
      [scenario('BEN_1', BEN, 40),         'ben'],
    ];
    const df = { scenarios: [], tripRequirements: [], passengersList: [], purchaserList: [], requestedFulfillmentOptionsList: [],
                 scenariosToRun: parts.map(([s]) => s.code), systemInfoParameters: { owner: 'company' } };
    for (const [s, tag] of parts) {
      df.scenarios.push(s);
      df.tripRequirements.push({ id: s.tripRequirementId, tag, tripType: 'SEARCH' });
      df.passengersList.push({ id: s.passengersListId, tag, passengers: [{ firstName: 'Ada',
        reference: '1', dateOfBirth: '1990-01-01', lastName: 'L', phoneNumber: '+1', email: 'p@example.org', type: 'PERSON' }] });
      df.purchaserList.push({ id: s.purchaserListId, tag, purchaser: [{ purchaserFirstName: 'P', purchaserLastName: 'Q', purchaserEmail: 'p@example.org' }] });
      df.requestedFulfillmentOptionsList.push({ id: s.requestedFulfillmentOptionsListId, tag,
        requestedFulfillmentOptions: [{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] });
    }
    if (legacy) {
      df.scenarios.find(s => s.code === 'SHARED_1').label = `shared ${TOKEN}`;
      df.scenarios.find(s => s.code === 'ANA_1').label = `ana ${TOKEN}`;
      df.scenarios.find(s => s.code === 'BEN_1').label = `ben ${TOKEN}`;
      df.passengersList[2].passengers[0].firstName = TOKEN;          // Ben's passengers
    }
    return df;
  }
  function seed(df) {
    const content = JSON.stringify(df, null, 4);
    encryptToFile(content, LIVE_PATH);
    run(`UPDATE companies SET datafile_path = ?, datafile_hash = ? WHERE id = ?`,
      [LIVE_PATH, crypto.createHash('sha256').update(content).digest('hex'), companyId]);
  }
  // As for a company that has never had a datafile.
  function unseed() {
    run(`UPDATE companies SET datafile_path = NULL, datafile_hash = NULL WHERE id = ?`, [companyId]);
    fs.rmSync(LIVE_PATH, { force: true });
  }
  const onDisk   = () => decryptFromFile(LIVE_PATH).toString('utf8');
  const isStored = () => fs.existsSync(LIVE_PATH);
  const hash     = () => get('SELECT datafile_hash FROM companies WHERE id = ?', [companyId]).datafile_hash;
  const byCode   = (df, c) => df.scenarios.find(s => s.code === c);
  const getAs    = u => request(app).get('/v1/company/datafile').set('Authorization', `Bearer ${token(u)}`);
  const putAs    = (u, body) => request(app).put('/v1/company/datafile/json').set('Authorization', `Bearer ${token(u)}`).send(body);
  const uploadAs = (u, df) => request(app).post('/v1/company/datafile').set('Authorization', `Bearer ${token(u)}`)
    .attach('datafile', Buffer.from(typeof df === 'string' ? df : JSON.stringify(df)), 'datafile.json');

  function expectRefused(res, where) {
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('cannot be saved');
    expect(res.body.detail).toContain(where);
    expect(res.body.detail).not.toContain('OSCAR_ACCESS_TOKEN');       // says where, never repeats the text
  }

  beforeAll(() => {
    fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
    run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Templates Co', ?, 'https://templates.example')`, [companyId, slug]);
    for (const u of [ANA, BEN, TM]) {
      run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, ?, 'x', ?, 'bearer', ?)`,
        [u.id, companyId, u.email, u.role, colEncrypt('tok')]);
      credentialsAsMigrated(u.id);
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
    safe('DELETE FROM runs WHERE company_id = ?', [companyId]);
    safe('DELETE FROM companies WHERE id = ?', [companyId]);
    safe('DELETE FROM users WHERE company_id = ?', [companyId]);
  });

  return { ANA, BEN, TM, scenario, storedFile, seed, unseed, onDisk, isStored, hash, byCode, getAs, putAs, uploadAs, expectRefused };
}

module.exports = { templatesCompany, OPEN, CLOSE, TOKEN };
