// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #813: POST /v1/company/test-resources/:id/probe-journey, with a stubbed
// provider (global.fetch). The route changes nothing.

process.env.JWT_SECRET = 'test-jwt-secret-for-journey-probe';

const { credentialsAsMigrated } = require('../helpers/credentials');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, encrypt, colEncrypt } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company-test-resources');

const companyId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const A = 'urn:uic:stn:8000001';
const B = 'urn:uic:stn:8000002';
const C = 'urn:uic:stn:8000003';

const token = (role, uid, cid = companyId) => `Bearer ${jwt.sign(
  { sub: uid, email: `${role}@jp-test.com`, companyId: cid, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

const seed = (id, type, data, cid = companyId) => run(
  `INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)`,
  [id, cid, type, `${type} ${id.slice(0, 4)}`, colEncrypt(JSON.stringify(data))]);

const t1 = uuidv4();
const t2 = uuidv4();
const journeyId = uuidv4();

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'JP Test', 'jp-test', 'https://vendor.example/osdm')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'JP Other', 'jp-other', 'https://other.example/osdm')`, [otherId]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, 'test_manager@jp-test.com', 'x', 'test_manager', 'bearer', ?)`, [tmId, companyId, encrypt('stub-bearer-token')]);
  credentialsAsMigrated(tmId);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'company_user@jp-test.com', 'x', 'company_user')`, [testerId, companyId]);
  seed(t1, 'TRAIN', { originURN: A, destinationURN: B, services: [{ vehicleNumber: 'IC 1', departureTime: '08:00:00', arrivalTime: '09:00:00' }] });
  seed(t2, 'TRAIN', { originURN: B, destinationURN: C, services: [{ vehicleNumber: 'RE 2', departureTime: '09:15:00', arrivalTime: '10:00:00' }] });
  seed(journeyId, 'JOURNEY', { legs: [{ trainResourceId: t1, serviceIndex: 0 }, { trainResourceId: t2, serviceIndex: 0 }] });
});

const leg = (o, d, n, dep, arr, date) => ({ timedLeg: {
  start: { stopPlaceRef: o, serviceDeparture: { timetabledTime: `${date}T${dep}:00` } },
  end: { stopPlaceRef: d, serviceArrival: { timetabledTime: `${date}T${arr}:00` } },
  service: { vehicleNumbers: [n] } } });

async function withProvider(answer, fn) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return answer(url, body);
  };
  try { return await fn(calls); } finally { global.fetch = orig; }
}

const probe = (id = journeyId, auth = token('test_manager', tmId)) =>
  request(app).post(`/v1/company/test-resources/${id}/probe-journey`).set('Authorization', auth).send({});

test('403 for a tester, 404 for another company\'s journey or a train set', async () => {
  expect((await probe(journeyId, token('company_user', testerId))).status).toBe(403);
  const foreign = uuidv4();
  seed(foreign, 'JOURNEY', { legs: [] }, otherId);
  expect((await probe(foreign)).status).toBe(404);
  expect((await probe(t1)).status).toBe(404);
});

test('400 when a leg names a train set no longer in Test Data', async () => {
  const id = uuidv4();
  seed(id, 'JOURNEY', { legs: [{ trainResourceId: t1 }, { trainResourceId: 'gone' }] });
  const res = await probe(id);
  expect(res.status).toBe(400);
  expect(res.body.detail).toMatch(/no longer in Test Data/);
});

test('the trip search of three days, first to last stop place at the first departure; nothing written', async () => {
  const before = get('SELECT data, updated_at FROM test_resources WHERE id = ?', [journeyId]);
  await withProvider((url, body) => {
    const date = body.departureTime.slice(0, 10);
    const trips = [{ legs: [leg(A, B, 'IC 1', '08:00', '09:00', date), leg(B, C, 'RE 2', '09:15', '10:00', date)] }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ trips }) };
  }, async (calls) => {
    const res = await probe();
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.url === 'https://vendor.example/osdm/trips-collection')).toBe(true);
    expect(calls[0].body.origin.stopPlaceRef).toBe(A);
    expect(calls[0].body.destination.stopPlaceRef).toBe(C);
    expect(calls[0].body.departureTime).toMatch(/T08:00:00$/);
    expect(res.body.days.map(d => d.outcome)).toEqual(['found', 'found', 'found']);
    expect(res.body.summary).toBe('Offered on every day searched (3).');
    expect(res.body.legs).toHaveLength(2);
  });
  expect(get('SELECT data, updated_at FROM test_resources WHERE id = ?', [journeyId])).toEqual(before);
});

test('no trip search (501): /offers, kept for the next days; a differing trip is described', async () => {
  await withProvider((url, body) => {
    if (url.endsWith('/trips-collection')) return { ok: false, status: 501, text: async () => '' };
    const date = body.tripSearchCriteria.departureTime.slice(0, 10);
    const trips = [{ legs: [leg(A, B, 'IC 1', '08:00', '09:00', date), leg(B, C, 'RE 4', '09:45', '10:30', date)] }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ trips, offers: [] }) };
  }, async (calls) => {
    const res = await probe();
    expect(res.status).toBe(200);
    expect(calls.map(c => c.url.split('/').pop())).toEqual(['trips-collection', 'offers', 'offers', 'offers']);
    const day = res.body.days[0];
    expect(day.via).toBe('offers');
    expect(day.outcome).toBe('differences');
    expect(day.differences).toEqual(['leg 2 is train RE 4, not RE 2', 'leg 2 leaves at 09:45, not 09:15', 'leg 2 arrives at 10:30, not 10:00']);
  });
});

test('a provider that answers no search: each day says why', async () => {
  await withProvider(() => ({ ok: false, status: 500, text: async () => 'oops' }), async (calls) => {
    const res = await probe();
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(6);
    expect(res.body.days.map(d => d.error)).toEqual(['HTTP 500', 'HTTP 500', 'HTTP 500']);
    expect(res.body.summary).toMatch(/answered no search/);
  });
});
