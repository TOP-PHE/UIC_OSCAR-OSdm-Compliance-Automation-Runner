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

// ── #815 ──────────────────────────────────────────────────────────────────────
const { all, colDecrypt } = require('../../src/db/db');
const tm = () => token('test_manager', tmId);

test('#815: the trips offered over the days, each once, ready to keep', async () => {
  await withProvider((url, body) => {
    const date = body.departureTime.slice(0, 10);
    const trips = [{ legs: [leg(A, B, 'IC 1', '08:00', '09:00', date), leg(B, C, 'RE 4', '09:45', '10:30', date)] }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ trips }) };
  }, async () => {
    const res = await probe();
    expect(res.body.offeredTrips).toHaveLength(1);
    const t = res.body.offeredTrips[0];
    expect(t.dates).toHaveLength(3);
    expect(t.days).toHaveLength(3);
    expect(t.legs.map(l => l.vehicleNumber)).toEqual(['IC 1', 'RE 4']);
    expect(res.body.days.every(d => !('candidates' in d))).toBe(true);
  });
});

test('#815: a result of Find journeys is probed by its legs', async () => {
  const bad = await request(app).post('/v1/company/test-resources/probe-journey').set('Authorization', tm()).send({ legs: [{ trainResourceId: t1, serviceIndex: -1 }] });
  expect(bad.status).toBe(400);
  expect((await request(app).post('/v1/company/test-resources/probe-journey').set('Authorization', token('company_user', testerId)).send({ legs: [] })).status).toBe(403);
  await withProvider((url, body) => {
    const date = body.departureTime.slice(0, 10);
    return { ok: true, status: 200, text: async () => JSON.stringify({ trips: [{ legs: [leg(A, B, 'IC 1', '08:00', '09:00', date), leg(B, C, 'RE 2', '09:15', '10:00', date)] }] }) };
  }, async (calls) => {
    const res = await request(app).post('/v1/company/test-resources/probe-journey').set('Authorization', tm())
      .send({ legs: [{ trainResourceId: t1, serviceIndex: 0 }, { trainResourceId: t2, serviceIndex: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.journey.id).toBeNull();
    expect(res.body.summary).toBe('Offered on every day searched (3).');
    expect(calls[0].body.destination.stopPlaceRef).toBe(C);
  });
  const gone = await request(app).post('/v1/company/test-resources/probe-journey').set('Authorization', tm()).send({ legs: [{ trainResourceId: 'gone', serviceIndex: 0 }] });
  expect(gone.status).toBe(400);
});

describe('#815: journey-from-trip', () => {
  const D = 'urn:uic:stn:8000009';
  const kept = { legs: [
    { originURN: A, destinationURN: B, vehicleNumber: 'IC 1', departureTime: '08:00:00', arrivalTime: '09:00:00' },
    { originURN: B, destinationURN: D, originName: 'Bee', destName: 'Dee', vehicleNumber: 'S 7', departureTime: '09:20:00', arrivalTime: '09:50:00' },
  ], days: ['MON', 'TUE'] };
  const keep = (body, auth = tm()) => request(app).post('/v1/company/test-resources/journey-from-trip').set('Authorization', auth).send(body);
  const trainsOf = () => all(`SELECT * FROM test_resources WHERE company_id = ? AND resource_type = 'TRAIN'`, [companyId])
    .map(r => ({ id: r.id, data: JSON.parse(colDecrypt(r.data)) }));

  test('403 for a tester, 400 for a trip that is not one', async () => {
    expect((await keep(kept, token('company_user', testerId))).status).toBe(403);
    expect((await keep({ legs: [], days: ['MON'] })).status).toBe(400);
    const count = () => get('SELECT COUNT(*) AS n FROM test_resources WHERE company_id = ?', [companyId]).n;
    const before = count();
    const t1Before = get('SELECT data FROM test_resources WHERE id = ?', [t1]).data;
    const night = await keep({ legs: [kept.legs[0], { ...kept.legs[1], departureTime: '07:00:00', arrivalTime: '07:30:00' }], days: ['MON'] });
    expect(night.status).toBe(400);
    expect(night.body.detail).toMatch(/one trip date/);
    // Nothing written.
    expect(count()).toBe(before);
    expect(get('SELECT data FROM test_resources WHERE id = ?', [t1]).data).toBe(t1Before);
  });

  test('the legs become train services, the journey points at them; asked twice, made once', async () => {
    const before = trainsOf().length;
    const res = await keep(kept);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.journey.label).toBe('8000001 → Dee via Bee (08:00)');
    // A → B already has IC 1 (no calendar): it gets the days; B → D is new.
    expect(res.body.trainsCreated).toHaveLength(1);
    expect(res.body.trainsUpdated.map(t => t.id)).toEqual([t1]);
    expect(trainsOf().length).toBe(before + 1);
    const newSet = trainsOf().find(t => t.data.destinationURN === D);
    expect(newSet.data.daysOfWeek).toEqual(['MON', 'TUE']);
    expect(newSet.data.services).toEqual([{ vehicleNumber: 'S 7', departureTime: '09:20:00', arrivalTime: '09:50:00' }]);
    const stored = JSON.parse(colDecrypt(get('SELECT data FROM test_resources WHERE id = ?', [res.body.journey.id]).data));
    expect(stored.legs).toEqual([{ trainResourceId: t1, serviceIndex: 0 }, { trainResourceId: newSet.id, serviceIndex: 0 }]);

    const again = await keep(kept);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, journey: { id: res.body.journey.id }, trainsCreated: [] });
  });

  test('a direct trip makes a one-leg journey named without "via"', async () => {
    const res = await keep({ legs: [{ originURN: A, destinationURN: C, vehicleNumber: 'EC 5', departureTime: '11:00:00', arrivalTime: '13:00:00' }], days: ['SAT'] });
    expect(res.status).toBe(201);
    expect(res.body.journey.label).toBe('8000001 → 8000003 (11:00)');
  });
});
