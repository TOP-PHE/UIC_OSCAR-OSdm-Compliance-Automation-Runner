// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-catalogue-routes.test.js — the scenario catalogue (#612):
 * GET /v1/company/scenario-catalogue, and the copy with source_id
 * "catalogue": roles, a provider's own framework, the golden rule, and what
 * is written.
 *
 * Company C (Test Manager TM, tester TS, certifier CE, administrator AD) and
 * its provider P, which TS is granted. C declares sales only; P declares sales, full refunds and
 * both return models on OSDM 3.8.
 */

const path = require('node:path');

process.env.JWT_SECRET = 'test-jwt-secret-for-scenario-catalogue';
process.env.COLLECTION_PATH = path.resolve(__dirname, '../../../Bruno_Collection');

const fs      = require('fs');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, colEncrypt } = require('../../src/db/db');
const { decryptFromFileAsync } = require('../../src/utils/at-rest');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-scenario-copy'));

const tag = uuidv4().slice(0, 8);
const ids = { C: uuidv4(), P: uuidv4(), Q: uuidv4(), TM: uuidv4(), TS: uuidv4(), CE: uuidv4(), AD: uuidv4() };
const users = {
  TM: { role: 'test_manager', email: `tm-${tag}@cat.example` },
  TS: { role: 'company_user', email: `ts-${tag}@cat.example` },
  CE: { role: 'certification_user', email: `ce-${tag}@cat.example` },
  AD: { role: 'administrator', email: `ad-${tag}@cat.example` },
};
const as = (who, provider) => {
  const u = users[who];
  const h = { Authorization: `Bearer ${jwt.sign({ sub: ids[who], email: u.email, companyId: ids.C, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` };
  if (provider) h['X-Provider-Id'] = ids[provider];
  return h;
};
const framework = (config) => colEncrypt(JSON.stringify({ fulfillment: { types: ['ETICKET'], media: ['PDF_A4'] }, passengerTypes: ['ADULT'], ...config }));
const train = (companyId) => [`tr-${tag}-${companyId.slice(0, 4)}`, companyId, colEncrypt(JSON.stringify({
  originURN: 'urn:c:a', destinationURN: 'urn:c:b', services: [{ vehicleNumber: 'C-7', departureTime: '09:00:00Z', arrivalTime: '10:00:00Z' }],
}))];

async function readFile(companyId) {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  return row?.datafile_path ? JSON.parse((await decryptFromFileAsync(row.datafile_path)).toString('utf8')) : null;
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'C', ?)`, [ids.C, `cat-c-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P', ?, ?)`, [ids.P, `cat-c-${tag}--p`, ids.C]);
  // #748: Q takes offer requests by trip search and by trip specification.
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Q', ?, ?)`, [ids.Q, `cat-c-${tag}--q`, ids.C]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids[who], ids.C, u.email, u.role]);
  }
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [ids.P, ids.TS]);
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`, [uuidv4(), ids.C, framework({ osdmVersion: '3.6.0', salesFlows: ['SALE'], returnModels: [] })]);
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`,
    [uuidv4(), ids.P, framework({ osdmVersion: '3.8.0', salesFlows: ['SALE', 'REFUND_FULL'], returnModels: ['SEPARATE', 'COMBINED'] })]);
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`,
    [uuidv4(), ids.Q, framework({ osdmVersion: '3.8.0', salesFlows: ['SALE'], returnModels: [], offerRequestForms: ['SEARCH', 'SPECIFICATION'] })]);
  for (const c of [ids.C, ids.P, ids.Q]) run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'Train', ?)`, train(c));
});

afterAll(() => {
  for (const c of ['C', 'P', 'Q']) {
    const row = get('SELECT datafile_path FROM companies WHERE id = ?', [ids[c]]);
    if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  }
  run('DELETE FROM auth_events WHERE email LIKE ?', [`%-${tag}@cat.example`]);
  run('DELETE FROM companies WHERE id IN (?, ?, ?)', [ids.Q, ids.P, ids.C]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@cat.example`]);
});

const entryOf = (body, code) => body.entries.find(e => e.code === code);

describe('GET /scenario-catalogue', () => {
  test('lists every reference scenario, with what this company\'s framework lacks', async () => {
    const res = await request(app).get('/v1/company/scenario-catalogue').set(as('TM'));
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(20);
    expect(entryOf(res.body, 'OTST_SALE_ONE_WAY_1ADT')).toMatchObject({ kind: 'OTST', area: 'sale', missing: [] });
    expect(entryOf(res.body, 'OTST_REFUND_RETURN_FULL_1ADT').missing).toEqual(expect.arrayContaining(['sales flow REFUND_FULL', 'return model SEPARATE']));
    expect(entryOf(res.body, 'OTST_SALE_RETURN_COMBINED_1ADT').missing).toEqual(['return model COMBINED', 'OSDM 3.7 or later']);
    expect(entryOf(res.body, 'NHF_EXPIRED_OFFER').kind).toBe('NHF');
  });

  test('a provider is judged by its own framework', async () => {
    const res = await request(app).get('/v1/company/scenario-catalogue').set(as('TM', 'P'));
    expect(res.status).toBe(200);
    expect(entryOf(res.body, 'OTST_REFUND_RETURN_FULL_1ADT').missing).toEqual([]);
    expect(entryOf(res.body, 'OTST_SALE_RETURN_COMBINED_1ADT').missing).toEqual([]);
  });

  test('a tester reads it; a certifier and an administrator do not', async () => {
    expect((await request(app).get('/v1/company/scenario-catalogue').set(as('TS'))).status).toBe(200);
    for (const who of ['CE', 'AD']) expect((await request(app).get('/v1/company/scenario-catalogue').set(as(who))).status).toBe(403);
  });
});

describe('copy from the catalogue', () => {
  test('the preview says what each reference scenario tests and what is missing', async () => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('TM')).send({ source_id: 'catalogue' });
    expect(res.status).toBe(200);
    expect(res.body.source).toEqual({ id: 'catalogue', name: 'Scenario catalogue' });
    const one = res.body.scenarios.find(s => s.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(one).toMatchObject({ kind: 'OTST', missing: [] });
    expect(one.purpose).toMatch(/One-way sale/);
    // #681: what it needs from the provider's data, as phrases.
    expect(one.dataNeeds).toEqual(['1 passenger']);
    const mandatory = res.body.scenarios.find(s => s.code === 'OTST_SALE_RESERVATION_MANDATORY_2ADT');
    expect(mandatory.dataNeeds).toEqual(['a journey of 2 legs', 'a train with a mandatory seat reservation', '2 passengers']);
    expect(res.body.trips.length).toBeGreaterThan(0);
  });

  test('a reference scenario the framework does not allow is refused, naming what is missing', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM'))
      .send({ source_id: 'catalogue', codes: ['OTST_SALE_ONE_WAY_1ADT', 'OTST_REFUND_RETURN_FULL_1ADT'], trip_map: {} });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/OTST_REFUND_RETURN_FULL_1ADT needs sales flow REFUND_FULL/);
    expect(await readFile(ids.C)).toBeNull();
  });

  test('a tester copies one: it is theirs, its trip is the company\'s train, and the wait is the catalogue\'s', async () => {
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TS', 'P')).send({ source_id: 'catalogue' })).body;
    const codes = ['OTST_SALE_ONE_WAY_1ADT', 'NHF_EXPIRED_OFFER'];
    const tripMap = Object.fromEntries(preview.trips.filter(t => t.usedBy.some(c => codes.includes(c)))
      .map(t => [t.id, { type: 'train', train_id: train(ids.P)[0], service_index: 0 }]));
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TS', 'P')).send({ source_id: 'catalogue', codes, trip_map: tripMap });
    expect(res.status).toBe(200);
    expect(res.body.copied.map(c => c.to)).toEqual(codes);
    const file = await readFile(ids.P);
    const [sale, probe] = codes.map(c => file.scenarios.find(s => s.code === c));
    expect(sale.created_by).toBe(users.TS.email);
    expect(sale.shared).toBeFalsy();
    expect(probe.expiredOfferMaxWaitMinutes).toBe(40);
    const trip = file.tripRequirements.find(t => t.id === sale.tripRequirementId);
    expect(trip.trip.origin).toBe('urn:c:a');
    expect(file.systemInfoParameters).toBeUndefined();
  });

  // #959: the trip an exchange is for is mapped and copied like the sale's.
  test('the exchange to another route is copied with a trip of its own for the exchange', async () => {
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P')).send({ source_id: 'catalogue' })).body;
    const code = 'OTST_EXCHANGE_OTHER_ROUTE_1ADT';
    expect(preview.scenarios.find(s => s.code === code).dataNeeds).toContain('a second train, on another route, to exchange to');
    const used = preview.trips.filter(t => t.usedBy.includes(code) || t.usedBy.includes(`${code} (exchange)`));
    expect(used.map(t => t.usedBy.some(u => u === `${code} (exchange)`))).toEqual([false, true]);
    const tripMap = Object.fromEntries(used.map(t => [t.id, { type: 'train', train_id: train(ids.P)[0], service_index: 0 }]));
    const copy = () => request(app).post('/v1/company/scenario-copy').set(as('TM', 'P')).send({ source_id: 'catalogue', codes: [code], trip_map: tripMap });
    // The golden rule: P's Test Framework does not declare the exchange.
    const refused = await copy();
    expect([refused.status, refused.body.detail]).toEqual([400, `${code} needs sales flow EXCHANGE_FULL in the Test Framework.`]);
    const stored = get('SELECT config FROM test_frameworks WHERE company_id = ?', [ids.P]).config;
    run('UPDATE test_frameworks SET config = ? WHERE company_id = ?',
      [framework({ osdmVersion: '3.8.0', salesFlows: ['SALE', 'REFUND_FULL', 'EXCHANGE_FULL'], returnModels: ['SEPARATE', 'COMBINED'] }), ids.P]);
    try {
      const res = await copy();
      expect([res.status, res.body.detail]).toEqual([200, undefined]);
      const file = await readFile(ids.P);
      const copied = file.scenarios.find(s => s.code === res.body.copied[0].to);
      expect(copied.exchange.tripRequirementId).not.toBe(copied.tripRequirementId);
      expect(file.tripRequirements.map(t => t.id)).toEqual(expect.arrayContaining([copied.tripRequirementId, copied.exchange.tripRequirementId]));
    } finally {
      run('UPDATE test_frameworks SET config = ? WHERE company_id = ?', [stored, ids.P]);
    }
  });

  // #681: the company's values replace the simulator's, and the page is told what is left.
  test('the preview proposes the company\'s train and says what is left to complete or check', async () => {
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P')).send({ source_id: 'catalogue' })).body;
    for (const t of preview.trips.filter(x => !x.needsJourney)) expect(t.suggested).toBe(`train::${train(ids.P)[0]}::0`);
    expect(preview.trips.filter(x => x.needsJourney).every(t => t.suggested === null)).toBe(true);
    // #799: no journey in this Test Data, so a scenario with a multi-leg trip says so.
    const multi = new Set(preview.trips.filter(t => t.needsJourney).flatMap(t => t.usedBy));
    expect(multi.size).toBeGreaterThan(0);
    for (const s of preview.scenarios) {
      expect(s.journeyLegsMissing.length > 0).toBe(multi.has(s.code));
    }
    const tech = preview.scenarios.find(s => s.code === 'OTST_REFUND_TECHNICAL_CANCELLATION_1ADT');
    expect(tech.toComplete).toEqual([expect.stringMatching(/overrule code/)]);
    expect(preview.scenarios.find(s => s.code === 'OTST_SALE_RESERVATION_MANDATORY_2ADT').toCheck)
      .toEqual(['the chosen train must carry a mandatory seat reservation']);
    expect(preview.runsAll).toBe(false);
  });

  test('a reference scenario with an overrule code is copied with none when the framework declares none, and says so', async () => {
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P')).send({ source_id: 'catalogue' })).body;
    const codes = ['OTST_REFUND_TECHNICAL_CANCELLATION_1ADT'];
    const tripMap = Object.fromEntries(preview.trips.filter(t => t.usedBy.some(c => codes.includes(c)))
      .map(t => [t.id, { type: 'train', train_id: train(ids.P)[0], service_index: 0 }]));
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM', 'P')).send({ source_id: 'catalogue', codes, trip_map: tripMap });
    expect(res.status).toBe(200);
    expect(res.body.copied[0].toComplete).toEqual([expect.stringMatching(/overrule code/)]);
    // #681 part 3: the report of the copy, under the code it has here.
    expect(res.body.report).toMatchObject({ ready: [], toComplete: [{ code: res.body.copied[0].to }] });
    expect(res.body.report.runsAll).toBe(false);
    const copied = (await readFile(ids.P)).scenarios.find(s => s.code === res.body.copied[0].to);
    expect(copied.overruleCode).toBeNull();
  });

  test('with a run list of ALL, the preview and the copy say that a scenario to complete would run', async () => {
    const { writeDatafile } = require('../../src/utils/datafileWrite');
    const slug = get('SELECT slug FROM companies WHERE id = ?', [ids.P]).slug;
    const stored = await readFile(ids.P);
    await writeDatafile({ id: ids.P, slug }, { ...stored, scenariosToRun: 'ALL' });
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P')).send({ source_id: 'catalogue' })).body;
    expect(preview.runsAll).toBe(true);
    // A tester with a list of their own does not run ALL.
    require('../../src/utils/runSelections').setRunSelection(ids.P, ids.TS, ['OTST_SALE_ONE_WAY_1ADT']);
    const forTester = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TS', 'P')).send({ source_id: 'catalogue' })).body;
    expect(forTester.runsAll).toBe(false);
  });

  test('a certifier cannot copy from it', async () => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('CE')).send({ source_id: 'catalogue' });
    expect(res.status).toBe(403);
  });
});

describe('#748: a provider that takes searches and specifications', () => {
  test('lists each convertible search twice, and refuses what needs trip ids', async () => {
    const res = await request(app).get('/v1/company/scenario-catalogue').set(as('TM', 'Q'));
    expect(res.status).toBe(200);
    expect(entryOf(res.body, 'OTST_SALE_ONE_WAY_1ADT_SPEC')).toMatchObject({ variantOf: 'OTST_SALE_ONE_WAY_1ADT', tripAs: 'SPECIFICATION', missing: [] });
    expect(entryOf(res.body, 'OTST_SALE_BY_TRIP_ID_1ADT').missing).toContain('offer requests by trip id');
  });

  test('copies the twin onto a one-leg specification trip filled from the train', async () => {
    const preview = (await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'Q')).send({ source_id: 'catalogue' })).body;
    const codes = ['OTST_SALE_ONE_WAY_1ADT', 'OTST_SALE_ONE_WAY_1ADT_SPEC'];
    expect(preview.scenarios.find(s => s.code === codes[1]).toCheck).toEqual([expect.stringMatching(/number and operator code/)]);
    const tripMap = Object.fromEntries(preview.trips.filter(t => t.usedBy.some(c => codes.includes(c)))
      .map(t => [t.id, { type: 'train', train_id: train(ids.Q)[0], service_index: 0 }]));
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM', 'Q')).send({ source_id: 'catalogue', codes, trip_map: tripMap });
    expect(res.status).toBe(200);
    const file = await readFile(ids.Q);
    const tripOf = (code) => file.tripRequirements.find(t => t.id === file.scenarios.find(s => s.code === code).tripRequirementId);
    expect(tripOf(codes[0]).tripType).toBe('SEARCH');
    expect(tripOf(codes[1])).toMatchObject({ tripType: 'SPECIFICATION', legs: [{ origin: 'urn:c:a', destination: 'urn:c:b', vehicleNumber: 'C-7' }] });
  });
});
