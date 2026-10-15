// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-trip-ids.test.js — #602: offers asked by trip id, after
 * POST /trips-collection.
 *
 * The collection asked offers by search criteria or by trip specification
 * only. Now a scenario can ask the provider's trips first, choose one (its
 * train, or the first at the time asked or later), and ask offers by its id;
 * and a negative test names an id the provider never gave.
 */

let envStore = {};
let sent = [];
let answer = null;
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  sendRequest:  (options, callback) => { sent.push(options); answer(callback); },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const ti = require('../../../Bruno_Collection/library-bruno/tripIds.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

beforeEach(() => { envStore = {}; sent = []; answer = null; mockResults = []; mockLogs = []; });

const place = (n) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:000000${n}` });
const trip = (id, start, number, { from = place(1), to = place(2) } = {}) => ({
  id,
  startTime: start,
  legs: [{ id: `${id}-L1`, timedLeg: { start: { stopPlaceRef: from, serviceDeparture: { timetabledTime: start } }, end: { stopPlaceRef: to }, service: { vehicleNumbers: [number] } } }],
});
// Half an hour before 08:00, at 08:00, one and two hours after.
const departures = [
  trip('T0', '2026-11-20T07:30:00+02:00', '1100'),
  trip('T1', '2026-11-20T08:00:00+02:00', '1137'),
  trip('T2', '2026-11-20T09:00:00+02:00', '1174'),
  trip('T3', '2026-11-20T10:00:00+02:00', '1211'),
];
const search = {
  departureTime: '2026-11-20T08:00:00',
  origin: place(1),
  destination: place(2),
  parameters: { dataFilter: { vehicleFilter: { exclude: false, vehicleNumbers: ['1174'] } } },
};

describe('the trip asked for', () => {
  test('the search sent to /trips-collection keeps the places and the time, and leaves the train filter out', () => {
    expect(ti.tripsCollectionRequest(search)).toEqual({ departureTime: '2026-11-20T08:00:00', origin: place(1), destination: place(2) });
    expect(ti.tripsCollectionRequest({ ...search, departureTime: undefined, arrivalTime: '2026-11-20T12:00:00', vias: [{ x: 1 }] }))
      .toEqual({ arrivalTime: '2026-11-20T12:00:00', origin: place(1), destination: place(2), vias: [{ x: 1 }] });
    expect(ti.tripsCollectionRequest({ origin: place(1) })).toBeNull();
    expect(ti.tripsCollectionRequest(null)).toBeNull();
  });

  test('the train named wins, wherever it is in the answer', () => {
    expect(ti.chooseTrip(departures, { vehicleNumber: '1174', departureTime: '2026-11-20T08:00:00' }).trip.id).toBe('T2');
    const none = ti.chooseTrip(departures, { vehicleNumber: '9999', departureTime: '2026-11-20T08:00:00' });
    expect(none.trip).toBeNull();
    expect(none.reason).toMatch(/no trip of the answer runs train 9999 \(trains: 1100, 1137, 1174, 1211\)/);
  });

  test('without a train: the first leaving at the time asked or later, not the first of the answer', () => {
    expect(ti.chooseTrip(departures, { departureTime: '2026-11-20T08:00:00' }).trip.id).toBe('T1');
    expect(ti.chooseTrip(departures, { departureTime: '2026-11-20T08:01:00' }).trip.id).toBe('T2');
    const late = ti.chooseTrip(departures, { departureTime: '2026-11-20T10:30:00' });
    expect(late.trip).toBeNull();
    expect(late.reason).toMatch(/leaves at 10:30 or later \(departures: 07:30, 08:00, 09:00, 10:00\)/);
    expect(ti.chooseTrip(departures, {}).trip.id).toBe('T0');
  });

  test('the times compared are the local clocks, whatever the offset written', () => {
    const utc = [trip('U', '2026-11-20T06:00:00Z', '1'), trip('L', '2026-11-20T08:00:00+02:00', '2')];
    // 06:00Z is 08:00 at the stop, but OSDM writes a trip in the stop's own
    // offset: the clock written is the one compared.
    expect(ti.chooseTrip(utc, { departureTime: '2026-11-20T07:00:00' }).trip.id).toBe('L');
  });

  test('a trip with no id is never chosen; a train is found on any leg', () => {
    const twoLegs = { id: 'X', legs: [{ timedLeg: { service: { vehicleNumbers: ['1'] } } }, { timedLeg: { service: { vehicleNumber: '42' } } }] };
    expect(ti.chooseTrip([{ legs: [] }, twoLegs], { vehicleNumber: '42' }).trip.id).toBe('X');
    expect(ti.chooseTrip([{ legs: [] }], {}).reason).toMatch(/no trip with an id/);
    expect(ti.vehicleNumbersOf(twoLegs)).toEqual(['1', '42']);
  });

  test('the offer request names the trip and drops the search', () => {
    const request = { tripSearchCriteria: search, tripSpecifications: [], anonymousPassengerSpecifications: [{ externalRef: 'P1' }] };
    expect(ti.offerRequestByTripIds(request, 'T2')).toEqual({ tripIds: ['T2'], anonymousPassengerSpecifications: [{ externalRef: 'P1' }] });
    expect(request.tripSearchCriteria).toBe(search);
  });
});

describe('the checks', () => {
  const failed = (checks) => checks.filter((c) => !c.ok && c.level !== 'warn').map((c) => c.name);
  const warned = (checks) => checks.filter((c) => !c.ok && c.level === 'warn').map((c) => c.name);

  test('a conformant answer passes every check', () => {
    const checks = ti.checkTripsCollection(200, { id: 'C1', trips: departures }, ti.tripsCollectionRequest(search));
    expect(failed(checks)).toEqual([]);
    expect(warned(checks)).toEqual([]);
  });

  test('a status other than 200, no id, no trip, a trip without id or legs, an id twice: failures', () => {
    expect(failed(ti.checkTripsCollection(404, null, search))).toEqual(['Trips collection: HTTP status 200 — actual 404']);
    expect(failed(ti.checkTripsCollection(200, { trips: departures }, search))).toEqual(['Trips collection: has an id (TripCollectionResponse.id is required)']);
    expect(failed(ti.checkTripsCollection(200, { id: 'C', trips: [] }, search))).toEqual(['Trips collection: holds trips — 0']);
    const broken = [departures[0], { ...departures[1], id: undefined }, { ...departures[2], legs: [] }];
    expect(failed(ti.checkTripsCollection(200, { id: 'C', trips: broken }, search))).toEqual([
      'Trips collection: every trip has an id, none twice', 'Trips collection: every trip has legs',
    ]);
    const twice = ti.checkTripsCollection(200, { id: 'C', trips: [departures[0], departures[0]] }, search);
    expect(twice.find((c) => !c.ok).message).toBe('id(s) given twice: T0');
  });

  test('a trip from another stop is a warning, not a failure', () => {
    const other = trip('O', '2026-11-20T08:00:00+02:00', '1', { from: place(9) });
    const checks = ti.checkTripsCollection(200, { id: 'C', trips: [departures[1], other] }, search);
    expect(failed(checks)).toEqual([]);
    expect(checks.find((c) => !c.ok).message).toBe('trip 2: urn:uic:stn:0000009 → urn:uic:stn:0000002');
  });

  test('offers for another trip fail; offers that name no trip, or an answer without the trip, warn', () => {
    const body = (offerList, trips = [departures[2]]) => ({ offers: offerList, trips });
    expect(failed(ti.checkOffersForTrip(body([{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }]), 'T2'))).toEqual([]);
    const wrong = ti.checkOffersForTrip(body([{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }, { offerId: 'B', admissionOfferParts: [{ tripCoverage: { coveredTripId: 'T3' } }] }]), 'T2');
    expect(failed(wrong)).toEqual(['Offers by trip id: every offer covers the trip asked (T2)']);
    expect(wrong[0].message).toBe('offer B covers T3');
    const vague = ti.checkOffersForTrip(body([{ offerId: 'A' }], []), 'T2');
    expect(failed(vague)).toEqual([]);
    expect(warned(vague)).toEqual(['Offers by trip id: 1 offer(s) name no trip they cover', 'Offers by trip id: the answer\'s trips hold the trip asked']);
  });
});

describe('step 01', () => {
  const baseEnv = () => ({
    offersByTripIds: 'true',
    api_base: 'https://sim.example/gamma',
    osdmVersion: '3.8.0',
    access_token: 'tok',
    requestor: 'req',
    tripVehicleNumber: '1174',
    offerTripSearchCriteria: JSON.stringify(search),
    OfferCollectionRequest: JSON.stringify({ tripSearchCriteria: search, anonymousPassengerSpecifications: [{ externalRef: 'P1' }] }),
  });
  const respond = (status, data) => { answer = (cb) => cb(null, { status, data }); };

  test('off: nothing is sent and the request stays as built', async () => {
    envStore = { ...baseEnv(), offersByTripIds: 'false' };
    const before = envStore.OfferCollectionRequest;
    await offers.prepareOfferRequestByTripIds();
    expect(sent).toEqual([]);
    expect(envStore.OfferCollectionRequest).toBe(before);
    expect(offers.checkOfferRequestByTripIds(200, {})).toBe(false);
  });

  test('on: the trips are asked, the train chosen, the offers asked by its id; the checks go with the offer', async () => {
    envStore = baseEnv();
    respond(200, { id: 'C1', trips: departures });
    await offers.prepareOfferRequestByTripIds();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://sim.example/gamma/trips-collection');
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers).toEqual({ 'Content-Type': 'application/json;version=3.8.0', Accept: 'application/json', Authorization: 'Bearer tok', Requestor: 'req' });
    expect(JSON.parse(sent[0].data)).toEqual(ti.tripsCollectionRequest(search));
    expect(JSON.parse(envStore.OfferCollectionRequest)).toEqual({ tripIds: ['T2'], anonymousPassengerSpecifications: [{ externalRef: 'P1' }] });

    const stop = offers.checkOfferRequestByTripIds(200, { offers: [{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }], trips: [departures[2]] });
    expect(stop).toBe(false);
    expect(mockResults.filter((r) => !r.ok)).toEqual([]);
    expect(mockResults.map((r) => r.name)).toContain('Trips collection: a trip to ask offers for — the trip of train 1174, T2');
    expect(mockResults.map((r) => r.name)).toContain('Offers by trip id: every offer covers the trip asked (T2)');
  });

  test('a refused trip search fails and ends the scenario; the offer request is left by search', async () => {
    envStore = baseEnv();
    const before = envStore.OfferCollectionRequest;
    answer = (cb) => cb({ response: { status: 501, data: { code: 'NOT_IMPLEMENTED' } } });
    await offers.prepareOfferRequestByTripIds();
    expect(envStore.OfferCollectionRequest).toBe(before);
    expect(offers.checkOfferRequestByTripIds(200, { offers: [] })).toBe(true);
    expect(mockResults).toEqual([{ name: 'Trips collection: HTTP status 200 — actual 501', ok: false, message: 'HTTP 501' }]);
  });

  test('no trip of the train named fails and ends the scenario', async () => {
    envStore = { ...baseEnv(), tripVehicleNumber: '9999' };
    respond(200, { id: 'C1', trips: departures });
    await offers.prepareOfferRequestByTripIds();
    expect(offers.checkOfferRequestByTripIds(200, {})).toBe(true);
    expect(mockResults.filter((r) => !r.ok).map((r) => r.name)).toEqual(['Trips collection: a trip to ask offers for — none']);
  });

  test('an answer with no trip: the log says what it held (#729)', async () => {
    envStore = baseEnv();
    respond(200, { problems: [{ code: 'urn:uic:problem:PARAMETER_NOT_SUPPORTED', title: "Parameter 'x' was ignored." }] });
    await offers.prepareOfferRequestByTripIds();
    expect(offers.checkOfferRequestByTripIds(200, {})).toBe(true);
    expect(mockLogs).toContain("[INFO] POST /trips-collection: problem 1: urn:uic:problem:PARAMETER_NOT_SUPPORTED — Parameter 'x' was ignored.");
    expect(mockLogs).toContain('[INFO] POST /trips-collection: members of the answer: problems');
  });

  // #764: a real provider was sent `Requestor: ""` and answered HTTP 200 with a body that did not parse.
  test('no requestor set: no Requestor header at all', async () => {
    for (const requestor of [undefined, '', '  ']) {
      envStore = { ...baseEnv(), requestor };
      sent = [];
      respond(200, { id: 'C1', trips: departures });
      await offers.prepareOfferRequestByTripIds();
      expect(Object.keys(sent[0].headers)).not.toContain('Requestor');
    }
  });

  test('an answer that is not JSON: the log gives its type, length and first characters', async () => {
    envStore = baseEnv();
    const page = '<html><head><title>Request Rejected</title></head><body>\n  <p>The requested URL was rejected.</p>\n  Your support ID is: 123</body></html>';
    answer = (cb) => cb(null, { status: 200, data: page, headers: { 'content-type': 'text/html; charset=utf-8' } });
    await offers.prepareOfferRequestByTripIds();
    expect(offers.checkOfferRequestByTripIds(200, {})).toBe(true);
    expect(mockLogs).toContain(`[INFO] POST /trips-collection: the answer is not JSON (Content-Type text/html; charset=utf-8, ${page.length} characters): "Request Rejected The requested URL was rejected. Your support ID is: 123"`);
    expect(mockLogs.some((l) => l.includes('no JSON body'))).toBe(false);
  });

  test('an empty answer, or one given as bytes, is described too; a JSON text is read as before', async () => {
    envStore = baseEnv();
    answer = (cb) => cb(null, { status: 200, data: '', headers: {} });
    await offers.prepareOfferRequestByTripIds();
    expect(mockLogs).toContain('[INFO] POST /trips-collection: the answer is empty (Content-Type none)');
    mockLogs = [];
    answer = (cb) => cb(null, { status: 200, data: new TextEncoder().encode('Service Unavailable'), headers: { 'Content-Type': 'text/plain' } });
    await offers.prepareOfferRequestByTripIds();
    expect(mockLogs).toContain('[INFO] POST /trips-collection: the answer is not JSON (Content-Type text/plain, 19 characters): "Service Unavailable"');
    answer = (cb) => cb(null, { status: 200, data: JSON.stringify({ id: 'C1', trips: departures }) });
    await offers.prepareOfferRequestByTripIds();
    expect(JSON.parse(envStore.OfferCollectionRequest).tripIds).toEqual(['T2']);
  });

  test('a transport error is a failed status, not a thrown step', async () => {
    envStore = baseEnv();
    answer = (cb) => cb(new Error('ECONNREFUSED'));
    await offers.prepareOfferRequestByTripIds();
    expect(offers.checkOfferRequestByTripIds(0, null)).toBe(true);
    expect(mockLogs.some((l) => l.includes('could not be sent: ECONNREFUSED'))).toBe(true);
  });

  test('the probe names an unknown id without asking the trips, grades the refusal and ends the scenario', async () => {
    envStore = { ...baseEnv(), offersByTripIds: 'false', tripIdsExpectRejection: 'true' };
    await offers.prepareOfferRequestByTripIds();
    expect(sent).toEqual([]);
    expect(JSON.parse(envStore.OfferCollectionRequest).tripIds).toEqual([ti.UNKNOWN_TRIP_ID]);
    expect(offers.checkOfferRequestByTripIds(400, { code: 'VALIDATION_ERROR', title: 'x', detail: 'tripIds[0] is unknown' })).toBe(true);
    expect(mockResults.filter((r) => !r.ok)).toEqual([]);
    mockResults = [];
    expect(offers.checkOfferRequestByTripIds(200, { offers: [] })).toBe(true);
    expect(mockResults.filter((r) => !r.ok).map((r) => r.name)).toEqual(['🧪 Trip id probe: provider rejects with a client error (4xx)']);
  });
});

describe('describeTripsAnswer (#729)', () => {
  test('says what an answer without trips held', () => {
    expect(ti.describeTripsAnswer(null)).toEqual(['the answer has no JSON body']);
    expect(ti.describeTripsAnswer([])).toEqual(['the answer is not an object (a list)']);
    expect(ti.describeTripsAnswer('x')).toEqual(['the answer is not an object (string)']);
    expect(ti.describeTripsAnswer({})).toEqual(['the answer is an empty object']);
    expect(ti.describeTripsAnswer({ trips: [], warnings: {} })).toEqual(['members of the answer: trips, warnings']);
    expect(ti.describeTripsAnswer({ problems: [{ detail: 'd' }, null] })).toEqual([
      'problem 1: (no code) — d', 'problem 2: (no code) — (no title)', 'members of the answer: problems',
    ]);
  });

  test('#764: a raw answer is cut at 200 characters', () => {
    const [line] = ti.describeRawAnswer('a'.repeat(500), 'text/plain');
    expect(line).toBe(`the answer is not JSON (Content-Type text/plain, 500 characters): "${'a'.repeat(200)}…"`);
    expect(ti.describeRawAnswer(null, null)).toEqual(['the answer is empty (Content-Type none)']);
  });

  test('at most ten problems, each at most 300 characters', () => {
    const lines = ti.describeTripsAnswer({ problems: Array.from({ length: 12 }, () => ({ code: 'C', title: 'x'.repeat(400) })) });
    expect(lines).toHaveLength(11);
    expect(Math.max(...lines.map((l) => l.length))).toBe(300);
  });
});
