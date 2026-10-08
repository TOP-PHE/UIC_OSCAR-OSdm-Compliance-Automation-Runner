// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-copy-routes.test.js — POST /v1/company/scenario-copy[/preview]
 * (#540): who may copy from where, what a tester sees of the source, the
 * target's preconditions, and what is written.
 *
 * Distributor D (Test Manager TM, testers ANA granted provider P1, BEN not) and
 * another distributor O. D's own file holds a shared scenario, one of ANA's
 * and one private to BEN. Copies go from D into P1.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-scenario-copy';

const fs      = require('fs');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, colEncrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { decryptFromFileAsync } = require('../../src/utils/at-rest');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-scenario-copy'));

const tag = uuidv4().slice(0, 8);
const ids = { D: uuidv4(), P1: uuidv4(), P2: uuidv4(), O: uuidv4(), TM: uuidv4(), ANA: uuidv4(), BEN: uuidv4(), OTM: uuidv4() };
const users = {
  TM:  { company: 'D', role: 'test_manager', email: `tm-${tag}@sc.example` },
  ANA: { company: 'D', role: 'company_user', email: `ana-${tag}@sc.example` },
  BEN: { company: 'D', role: 'company_user', email: `ben-${tag}@sc.example` },
  OTM: { company: 'O', role: 'test_manager', email: `otm-${tag}@sc.example` },
};
const as = (who, provider) => {
  const u = users[who];
  const h = { Authorization: `Bearer ${jwt.sign({ sub: ids[who], email: u.email, companyId: ids[u.company], role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` };
  if (provider) h['X-Provider-Id'] = ids[provider];
  return h;
};

const SOURCE = () => ({
  scenariosToRun: ['SHARED'],
  systemInfoParameters: { api_base: 'https://d.example' },
  scenarios: [
    { code: 'SHARED', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, requestedFulfillmentOptionsListId: 1, shared: true, created_by: users.TM.email },
    { code: 'ANA_OWN', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, requestedFulfillmentOptionsListId: 1, created_by: users.ANA.email },
    { code: 'BEN_PRIVATE', scenarioType: 'SALE', tripRequirementId: 2, passengersListId: 1, requestedFulfillmentOptionsListId: 1, created_by: users.BEN.email },
  ],
  tripRequirements: [
    { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:d:a', destination: 'urn:d:b' } },
    { id: 2, tripType: 'SEARCH', trip: { origin: 'urn:d:secret', destination: 'urn:d:b' } },
  ],
  passengersList: [{ id: 1, passengers: [{ type: 'ADULT' }] }],
  requestedFulfillmentOptionsList: [{ id: 1, requestedFulfillmentOptions: [{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] }],
});

async function readFile(companyId) {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  return row?.datafile_path ? JSON.parse((await decryptFromFileAsync(row.datafile_path)).toString('utf8')) : null;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [ids.D, `sc-d-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P1', ?, ?)`, [ids.P1, `sc-d-${tag}--p1`, ids.D]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P2', ?, ?)`, [ids.P2, `sc-d-${tag}--p2`, ids.D]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'O', ?)`, [ids.O, `sc-o-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids[who], ids[u.company], u.email, u.role]);
  }
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [ids.P1, ids.ANA]);
  await writeDatafile({ id: ids.D, slug: `sc-d-${tag}` }, SOURCE());
  await writeDatafile({ id: ids.O, slug: `sc-o-${tag}` }, SOURCE());
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`,
    [uuidv4(), ids.P1, colEncrypt(JSON.stringify({ osdmVersion: '3.6', fulfillment: { types: ['ETICKET'], media: ['PDF_A4'] } }))]);
  run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'P1 train', ?)`,
    [`tr-${tag}`, ids.P1, colEncrypt(JSON.stringify({ originURN: 'urn:p1:a', destinationURN: 'urn:p1:b', services: [{ vehicleNumber: 'P1-7', departureTime: '09:00:00Z', arrivalTime: '10:00:00Z' }] }))]);
});

afterAll(() => {
  for (const c of ['D', 'P1', 'P2', 'O']) {
    const row = get('SELECT datafile_path FROM companies WHERE id = ?', [ids[c]]);
    if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  }
  run('DELETE FROM auth_events WHERE email LIKE ?', [`%-${tag}@sc.example`]);
  run('DELETE FROM companies WHERE id IN (?, ?, ?, ?)', [ids.P1, ids.P2, ids.D, ids.O]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@sc.example`]);
});

const MAP = () => ({ 1: { type: 'train', train_id: `tr-${tag}`, service_index: 0 } });

describe('who may copy from where', () => {
  test.each([
    ['another distributor\'s company as source', 'TM', 'P1', () => ids.O],
    ['a provider of another distributor', 'OTM', null, () => ids.P1],
    ['the target itself', 'TM', 'P1', () => ids.P1],
    ['an unknown id', 'TM', 'P1', () => uuidv4()],
    ['a source given as an object', 'TM', 'P1', () => ({ id: ids.D })],
  ])('%s answers 404', async (_l, who, provider, sourceId) => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as(who, provider)).send({ source_id: sourceId() });
    expect(res.status).toBe(404);
  });

  test('a tester not granted the target provider cannot act in it', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('BEN', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED'], trip_map: MAP() });
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('Provider not found.');
  });
});

describe('preview', () => {
  test('a Test Manager sees every source scenario, its warnings and the target Test Data', async () => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P1')).send({ source_id: ids.D });
    expect(res.status).toBe(200);
    expect(res.body.scenarios.map(s => s.code)).toEqual(['SHARED', 'ANA_OWN', 'BEN_PRIVATE']);
    expect(res.body.testData.trains).toEqual([expect.objectContaining({ id: `tr-${tag}`, services: [expect.objectContaining({ vehicleNumber: 'P1-7' })] })]);
    expect(res.body.target.name).toBe('P1');
  });

  test('a tester sees only what their view of the source shows', async () => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('ANA', 'P1')).send({ source_id: ids.D });
    expect(res.status).toBe(200);
    expect(res.body.scenarios.map(s => s.code)).toEqual(['SHARED', 'ANA_OWN']);
    expect(JSON.stringify(res.body)).not.toContain('urn:d:secret');
  });

  test('the target must have a Test Framework and Test Data', async () => {
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P2')).send({ source_id: ids.D });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/Test Framework/);
  });
});

describe('copy', () => {
  test('a tester cannot copy another tester\'s private scenario', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('ANA', 'P1'))
      .send({ source_id: ids.D, codes: ['BEN_PRIVATE'], trip_map: { 2: { type: 'train', train_id: `tr-${tag}` } } });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('Scenario BEN_PRIVATE is not in the source.');
    expect(await readFile(ids.P1)).toBeNull();
  });

  test('a trip without a mapping is refused and nothing is written', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED'], trip_map: {} });
    expect(res.status).toBe(400);
    expect(await readFile(ids.P1)).toBeNull();
  });

  test('a tester\'s copy is written into the target, as theirs, re-pointed to the target\'s train', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('ANA', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED', 'ANA_OWN'], trip_map: MAP() });
    expect(res.status).toBe(200);
    expect(res.body.copied).toEqual([{ from: 'SHARED', to: 'SHARED' }, { from: 'ANA_OWN', to: 'ANA_OWN' }]);
    const p1 = await readFile(ids.P1);
    expect(p1.scenarios.map(s => [s.code, s.created_by, s.shared, s.osdmVersion])).toEqual([
      ['SHARED', users.ANA.email, false, '3.6'], ['ANA_OWN', users.ANA.email, false, '3.6']]);
    expect(p1.tripRequirements).toEqual([{ id: 1, tripType: 'SEARCH', trip: expect.objectContaining({ origin: 'urn:p1:a', vehicleNumber: 'P1-7' }) }]);
    expect(p1.systemInfoParameters).toBeUndefined();
    expect(get('SELECT datafile_hash FROM companies WHERE id = ?', [ids.P1]).datafile_hash).toBe(res.body.hash);
    expect(get(`SELECT 1 AS x FROM auth_events WHERE company_id = ? AND event_type = ?`, [ids.P1, `scenarios_copied:${ids.D}:2`])).toBeTruthy();
    // The source is unchanged.
    expect((await readFile(ids.D)).scenarios).toHaveLength(3);
  });

  test('copying again renames, and keeps what is there', async () => {
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED'], trip_map: MAP() });
    expect(res.status).toBe(200);
    expect(res.body.copied).toEqual([{ from: 'SHARED', to: 'SHARED_2' }]);
    expect((await readFile(ids.P1)).scenarios.map(s => s.code)).toEqual(['SHARED', 'ANA_OWN', 'SHARED_2']);
  });

  test('a template in the source text is not copied', async () => {
    const src = SOURCE();
    src.scenarios[0].description = 'see {{access_token}}';
    await writeDatafile({ id: ids.D, slug: `sc-d-${tag}` }, src);
    const res = await request(app).post('/v1/company/scenario-copy').set(as('TM', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED'], trip_map: MAP() });
    expect(res.status).toBe(400);
    expect((await readFile(ids.P1)).scenarios).toHaveLength(3);
    await writeDatafile({ id: ids.D, slug: `sc-d-${tag}` }, SOURCE());
  });

  test('the target\'s run list is kept as it is, "ALL" included', async () => {
    await writeDatafile({ id: ids.P1, slug: `sc-d-${tag}--p1` }, { ...(await readFile(ids.P1)), scenariosToRun: 'ALL' });
    const res = await request(app).post('/v1/company/scenario-copy').set(as('ANA', 'P1'))
      .send({ source_id: ids.D, codes: ['SHARED'], trip_map: MAP() });
    expect(res.status).toBe(200);
    expect((await readFile(ids.P1)).scenariosToRun).toBe('ALL');
  });

  test('a train whose stored data is not an object is offered without services', async () => {
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'odd', ?)`,
      [`odd-${tag}`, ids.P1, colEncrypt(JSON.stringify(true))]);
    const res = await request(app).post('/v1/company/scenario-copy/preview').set(as('TM', 'P1')).send({ source_id: ids.D });
    expect(res.status).toBe(200);
    expect(res.body.testData.trains.find(t => t.id === `odd-${tag}`)).toEqual(expect.objectContaining({ services: [] }));
  });
});
