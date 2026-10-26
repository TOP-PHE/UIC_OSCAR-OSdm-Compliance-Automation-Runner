// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-exchange-trip.test.js — the trip an exchange asks for (#959): the
 * scenario's `exchange` block read by the parser, sent by the exchange offer
 * request, and checked at steps 10 and 15.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       () => undefined,
  setVar:       () => {},
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  ...jest.requireActual('../../../Bruno_Collection/library-bruno/displays.js'),
  validationLogger: (line) => { mockLogs.push(line); },
}));
// The booking checks of step 15 are not what this file reads.
jest.mock('../../../Bruno_Collection/library-bruno/bookings.js', () => ({
  ...jest.requireActual('../../../Bruno_Collection/library-bruno/bookings.js'),
  postCreateBookingResponse: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
}));

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const X = require(path.join(LIB, 'exchangeTrip.js'));
const sp = require(path.join(LIB, 'scenarioParser.js'));
const { requestExchangeOffersBody } = require(path.join(LIB, 'requestsBuilder.js'));
const exchanges = require(path.join(LIB, 'exchanges.js'));

const ROOT = path.join(__dirname, '..', '..', '..');
const SIMULATOR_FILE = path.join(ROOT, 'Bruno_Collection', 'data_base', 'simulator_datafile.json');

beforeEach(() => {
  envStore = {}; mockResults = []; mockLogs = [];
  global.validationLogger = (line) => { mockLogs.push(line); };
});

const SEARCH_TRIP = { id: 2, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000003', destination: 'urn:uic:stn:0000001', startDatetime: '%TRIP_DATE%T14:30:00+01:00', endDatetime: '%TRIP_DATE%T16:00:00+01:00' } };
const SALE_TRIP = { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', startDatetime: '%TRIP_DATE%T08:00:00+01:00' } };
const SPEC_TRIP = { id: 4, tripType: 'SPECIFICATION', legs: [
  { origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000004', startDatetime: '%TRIP_DATE%T08:00:00+01:00', vehicleNumber: '101' },
  { origin: 'urn:uic:stn:0000004', destination: 'urn:uic:stn:0000002', startDatetime: '%TRIP_DATE%T10:20:00+01:00', vehicleNumber: '2202' }] };
const TRIPS = [SALE_TRIP, SEARCH_TRIP, SPEC_TRIP];

// An OSDM trip of one or two legs.
function osdmTrip(id, from, to, departure, numbers = []) {
  return {
    id,
    legs: [{ timedLeg: {
      start: { stopPlaceRef: { stopPlaceRef: from }, serviceDeparture: { timetabledTime: departure } },
      end: { stopPlaceRef: { stopPlaceRef: to } },
      service: { vehicleNumbers: numbers },
    } }],
  };
}

describe('exchangePlan', () => {
  test('no block, or a block that changes nothing: no plan', () => {
    expect(X.exchangePlan({}, TRIPS, SALE_TRIP).plan).toBeNull();
    const nothing = X.exchangePlan({ exchange: { dateOffsetDays: 0 } }, TRIPS, SALE_TRIP);
    expect(nothing.plan).toBeNull();
    expect(nothing.lines.join(' ')).toContain('changes nothing');
  });

  test('another trip, a day, a time and criteria', () => {
    const { plan, lines } = X.exchangePlan({ exchange: {
      tripRequirementId: 2, dateOffsetDays: 3, time: '12:05',
      offerSearchCriteria: { travelClasses: ['FIRST'], flexibilities: [], currency: 'EUR' },
    } }, TRIPS, SALE_TRIP);
    expect(plan).toEqual({ trip: SEARCH_TRIP, otherTrip: true, offsetDays: 3, time: '12:05', criteria: { travelClasses: ['FIRST'] } });
    expect(lines.join(' ')).toContain('currency not taken');
  });

  test('a trip id the data file does not hold is a problem', () => {
    const out = X.exchangePlan({ exchange: { tripRequirementId: 99 } }, TRIPS, SALE_TRIP);
    expect(out.plan).toBeNull();
    expect(out.problem).toContain('99');
  });

  test('values out of range are warned about and left out', () => {
    for (const bad of [61, -61, 1.5, 'x']) {
      const out = X.exchangePlan({ exchange: { dateOffsetDays: bad, time: '12:00' } }, TRIPS, SALE_TRIP);
      expect(out.plan.offsetDays).toBe(0);
      expect(out.lines[0]).toMatch(/^\[WARNING\]/);
    }
    for (const bad of ['24:00', '9:00', 'noon']) {
      expect(X.exchangePlan({ exchange: { time: bad, dateOffsetDays: 1 } }, TRIPS, SALE_TRIP).plan.time).toBeNull();
    }
    const spec = X.exchangePlan({ exchange: { tripRequirementId: 4, time: '12:00' } }, TRIPS, SALE_TRIP);
    expect(spec.plan.time).toBeNull();
    expect(spec.lines[0]).toContain('SEARCH trip');
    expect(X.exchangePlan({ exchange: 'x' }, TRIPS, SALE_TRIP).lines[0]).toMatch(/^\[WARNING\]/);
  });
});

describe('dates, times and the trip asked', () => {
  test('addDays counts on the UTC calendar, across months', () => {
    expect(X.addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(X.addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(X.addDays('not a date', 1)).toBe('not a date');
  });

  test('withTime replaces the departure\'s hour and minute and drops the arrival', () => {
    const t = X.withTime(SEARCH_TRIP, '07:45');
    expect(t.trip.startDatetime).toBe('%TRIP_DATE%T07:45:00+01:00');
    expect(t.trip.endDatetime).toBeUndefined();
    expect(SEARCH_TRIP.trip.endDatetime).toBeDefined();          // the data file's is not changed
    expect(X.withTime(SPEC_TRIP, '07:45')).toBe(SPEC_TRIP);
    expect(X.withTime(SEARCH_TRIP, null)).toBe(SEARCH_TRIP);
  });

  test('askedTrip of a search and of a specification', () => {
    expect(X.askedTrip(SEARCH_TRIP, '2026-11-21')).toEqual({ from: 'urn:uic:stn:0000003', to: 'urn:uic:stn:0000001', date: '2026-11-21', departure: '14:30', trains: [], kind: 'SEARCH' });
    expect(X.askedTrip(SPEC_TRIP, '2026-11-21')).toEqual({ from: 'urn:uic:stn:0000001', to: 'urn:uic:stn:0000002', date: '2026-11-21', departure: '08:00', trains: ['101', '2202'], kind: 'SPECIFICATION' });
  });
});

describe('checks of the answers', () => {
  const asked = X.askedTrip(SEARCH_TRIP, '2026-11-21');
  const right = osdmTrip('T2', 'urn:uic:stn:3', 'urn:uic:stn:0000001', '2026-11-21T14:30:00+01:00', ['900']);
  const wrong = osdmTrip('T1', 'urn:uic:stn:0000001', 'urn:uic:stn:0000002', '2026-11-20T08:00:00+01:00');

  test('the exchange offers cover the trip asked (UIC codes compared without leading zeros)', () => {
    const out = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }], trips: [right] }, asked);
    expect(out.checks).toEqual([expect.objectContaining({ ok: true })]);
    expect(out.offerId).toBeNull();
  });

  test('the offer covering the trip asked is taken when the first does not', () => {
    const out = X.checkExchangeOffers({ exchangeOffers: [
      { offerId: 'A', tripCoverage: { coveredTripId: 'T1' } },
      { offerId: 'B', admissionOfferParts: [{ tripCoverage: { coveredTripId: 'T2' } }] },
    ], trips: [wrong, right] }, asked);
    expect(out.offerId).toBe('B');
    expect(out.checks[0].ok).toBe(true);
  });

  test('offers for another trip fail, naming each difference', () => {
    const out = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A', tripCoverage: { coveredTripId: 'T1' } }], trips: [wrong] }, asked);
    expect(out.checks[0].ok).toBe(false);
    expect(out.checks[0].level).toBeUndefined();
    expect(out.checks[0].message).toContain('leaves from urn:uic:stn:0000001, not urn:uic:stn:0000003');
    expect(out.checks[0].message).toContain('leaves on 2026-11-20, not 2026-11-21');
  });

  test('no trips in the answer: nothing checked yet; offers naming no trip: a warning', () => {
    const none = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A' }] }, asked);
    expect(none.checks).toEqual([]);
    expect(none.lines[0]).toMatch(/^\[INFO\]/);
    const unnamed = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A' }], trips: [right] }, asked);
    expect(unnamed.checks[0]).toMatchObject({ ok: false, level: 'warn' });
    expect(X.checkExchangeOffers({}, asked).checks).toEqual([]);
  });

  test('another train: a warning for a search, a failure for a specification', () => {
    const train = { ...asked, trains: ['901'] };
    const search = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }], trips: [right] }, train);
    expect(search.checks.map((c) => [c.ok, c.level])).toEqual([[true, undefined], [false, 'warn']]);
    const spec = X.checkExchangeOffers({ exchangeOffers: [{ offerId: 'A', tripCoverage: { coveredTripId: 'T2' } }], trips: [right] }, { ...train, kind: 'SPECIFICATION' });
    expect(spec.checks[1].ok).toBe(false);
    expect(spec.checks[1].level).toBeUndefined();
  });

  test('the confirmed booking: the booked offer of the exchange covers the trip asked', () => {
    const booking = { booking: {
      trips: [wrong, right],
      bookedOffers: [
        { offerId: 'OLD', tripCoverage: { coveredTripId: 'T1' }, admissions: [{ id: 'a1' }] },
        { offerId: 'NEW', admissions: [{ id: 'a2', tripCoverage: { coveredTripId: 'T2' } }] },
      ],
    } };
    expect(X.checkExchangedBooking(booking, ['a2'], asked)).toEqual([expect.objectContaining({ ok: true })]);
    const old = X.checkExchangedBooking(booking, ['a1'], asked)[0];
    expect(old.ok).toBe(false);
    expect(old.level).toBeUndefined();
    expect(X.checkExchangedBooking(booking, [], asked)[0]).toMatchObject({ ok: false, level: 'warn' });
    expect(X.checkExchangedBooking({ booking: { bookedOffers: booking.booking.bookedOffers } }, ['a2'], asked)[0])
      .toMatchObject({ ok: false, level: 'warn', message: expect.stringContaining('names no trip') });
  });
});

// The parser over a scenario of the simulator's data file.
function parse(code, change = () => {}) {
  const file = JSON.parse(fs.readFileSync(SIMULATOR_FILE, 'utf8'));
  const scenario = file.scenarios.find((s) => s.code === code);
  change(scenario, file);
  envStore = { scenario_override: code };
  const jestTest = global.test;
  global.test = (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  };
  try { withBrunoExpect(() => sp.parseScenarioData(file)); } finally { global.test = jestTest; }
  return { ...envStore };
}
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

describe('the parser', () => {
  test('no exchange block: no exchange variables, the sale as before', () => {
    const env = parse('SIM_EXCHANGE_1ADT_38');
    for (const k of ['exchangeTripType', 'exchangeTripSearchCriteria', 'exchangeTripSpecifications', 'exchangeOfferSearchCriteria', '__exchangeTripAsked']) {
      expect(env[k]).toBeUndefined();
    }
  });

  test('another route: the exchange trip is built apart, and the sale\'s variables do not move', () => {
    const plain = parse('SIM_EXCHANGE_1ADT_38');
    const env = parse('SIM_EXCHANGE_OTHER_ROUTE_1ADT_38');
    for (const k of ['offerTripSearchCriteria', 'tripStartStopPlaceRef', 'tripEndStopPlaceRef', 'tripStartDatetime', '__travelDay', 'TripType']) {
      expect([k, env[k]]).toEqual([k, plain[k]]);
    }
    expect(env.exchangeTripType).toBe('SEARCH');
    const criteria = json(env.exchangeTripSearchCriteria);
    expect(criteria.origin.stopPlaceRef).toBe('urn:uic:stn:0000003');
    expect(criteria.destination.stopPlaceRef).toBe('urn:uic:stn:0000001');
    expect(criteria.departureTime).toBe(`${env.__travelDay}T14:30:00`);
    expect(json(env.__exchangeTripAsked)).toMatchObject({ from: 'urn:uic:stn:0000003', date: env.__travelDay, kind: 'SEARCH' });
    expect(env.exchangeOfferSearchCriteria).toBe('');
  });

  test('another day, time and class', () => {
    const env = parse('SIM_EXCHANGE_OTHER_DAY_1ADT_38');
    const next = X.addDays(env.__travelDay, 1);
    expect(json(env.exchangeTripSearchCriteria).departureTime).toBe(`${next}T12:00:00`);
    expect(json(env.__exchangeTripAsked).date).toBe(next);
    expect(json(env.exchangeOfferSearchCriteria)).toEqual({ travelClasses: ['FIRST'] });
  });

  test('a trip specification for the exchange writes its legs apart too', () => {
    const plain = parse('SIM_EXCHANGE_1ADT_38');
    const env = parse('SIM_EXCHANGE_OTHER_ROUTE_1ADT_38', (s) => { s.exchange = { tripRequirementId: 4 }; });
    expect(env.exchangeTripType).toBe('SPECIFICATION');
    const [spec] = json(env.exchangeTripSpecifications);
    expect(spec.legs).toHaveLength(2);
    expect(env.leg1StartStopPlaceRef).toBe(plain.leg1StartStopPlaceRef);
    expect(env.offerTripSpecifications).toBe(plain.offerTripSpecifications);
  });

  test('an unknown trip id fails a check; a block on another type of scenario is warned about', () => {
    parse('SIM_EXCHANGE_OTHER_ROUTE_1ADT_38', (s) => { s.exchange = { tripRequirementId: 999 }; });
    expect(mockResults).toContainEqual(expect.objectContaining({ name: '🔁 The exchange trip of the scenario is in the data file', ok: false }));
    const env = parse('SIM_SALE_SEARCH_1ADT_38', (s) => { s.exchange = { tripRequirementId: 2 }; });
    expect(env.exchangeTripType).toBeUndefined();
    expect(mockLogs.some((l) => l.includes('has an exchange block but its type is SALE'))).toBe(true);
  });
});

describe('the exchange offer request', () => {
  const sale = { origin: { stopPlaceRef: 'urn:uic:stn:0000001' } };
  const base = () => ({
    offerPassengerSpecifications: JSON.stringify([{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-01' }]),
    fulfillmentIds: JSON.stringify(['F1']),
    TripType: 'SEARCH',
    offerTripSearchCriteria: JSON.stringify(sale),
    offerSearchCriteria: JSON.stringify({ currency: 'CZK', travelClasses: ['SECOND'] }),
  });

  test('without an exchange trip, the sale\'s trip and criteria', () => {
    envStore = base();
    requestExchangeOffersBody(null);
    const body = JSON.parse(envStore.requestExchangeOffersBodyData);
    expect(body.tripSearchCriteria).toEqual(sale);
    expect(body.offerSearchCriteria).toEqual({ currency: 'CZK', travelClasses: ['SECOND'] });
  });

  test('with one, its trip and its criteria over the sale\'s', () => {
    envStore = { ...base(), exchangeTripType: 'SEARCH', exchangeTripSearchCriteria: JSON.stringify({ origin: { stopPlaceRef: 'X' } }), exchangeOfferSearchCriteria: JSON.stringify({ travelClasses: ['FIRST'] }) };
    requestExchangeOffersBody(null);
    const body = JSON.parse(envStore.requestExchangeOffersBodyData);
    expect(body.tripSearchCriteria).toEqual({ origin: { stopPlaceRef: 'X' } });
    expect(body.offerSearchCriteria).toEqual({ currency: 'CZK', travelClasses: ['FIRST'] });
    envStore = { ...base(), exchangeTripType: 'SPECIFICATION', exchangeTripSpecifications: JSON.stringify([{ legs: [] }]) };
    requestExchangeOffersBody(null);
    const spec = JSON.parse(envStore.requestExchangeOffersBodyData);
    expect(spec.tripSpecifications).toEqual([{ legs: [] }]);
    expect(spec.tripSearchCriteria).toBeUndefined();
  });
});

describe('the steps', () => {
  const asked = JSON.stringify(X.askedTrip(SEARCH_TRIP, '2026-11-21'));
  const right = osdmTrip('T2', 'urn:uic:stn:0000003', 'urn:uic:stn:0000001', '2026-11-21T14:30:00+01:00');
  const wrong = osdmTrip('T1', 'urn:uic:stn:0000001', 'urn:uic:stn:0000002', '2026-11-20T08:00:00+01:00');

  test('step 10 takes the offer covering the trip asked, and records the check', () => {
    envStore = { __exchangeTripAsked: asked, exchangeOffersOfferId: 'A' };
    withBrunoExpect(() => exchanges.checkExchangeTripOffers({ exchangeOffers: [
      { offerId: 'A', tripCoverage: { coveredTripId: 'T1' } }, { offerId: 'B', tripCoverage: { coveredTripId: 'T2' } }], trips: [wrong, right] }));
    expect(envStore.exchangeOffersOfferId).toBe('B');
    expect(mockResults).toEqual([expect.objectContaining({ ok: true })]);
  });

  test('step 10 and 15 check nothing without an exchange trip', () => {
    envStore = {};
    exchanges.checkExchangeTripOffers({ exchangeOffers: [{ offerId: 'A' }], trips: [wrong] });
    expect(mockResults).toEqual([]);
  });

  test('step 15: the booked offer of the confirmed exchange is held to the trip asked', () => {
    const booking = { booking: { id: 'B1', trips: [wrong], bookedOffers: [
      { offerId: 'OLD', tripCoverage: { coveredTripId: 'T1' }, admissions: [{ id: 'a1', status: 'EXCHANGED' }] },
      { offerId: 'NEW', tripCoverage: { coveredTripId: 'T1' }, admissions: [{ id: 'a2', status: 'FULFILLED' }] }] } };
    envStore = { __exchangeTripAsked: asked, __partIdsBeforeExchange: JSON.stringify(['a1']), offer: JSON.stringify({ offerId: 'O' }) };
    withBrunoExpect(() => exchanges.checkBookingAroundExchange(booking, 'confirmed'));
    expect(mockResults).toContainEqual(expect.objectContaining({ name: expect.stringContaining('The booked offer of the exchange covers the trip asked'), ok: false }));
  });

  test('the wiring: step 10 calls the check, both reset lists clear the variables', () => {
    const step10 = fs.readFileSync(path.join(ROOT, 'Bruno_Collection', '04-Exchange', '10. POST Exchange Offers.yml'), 'utf8');
    expect(step10).toContain('checkExchangeTripOffers(jsonData);');
    const parser = fs.readFileSync(path.join(LIB, 'scenarioParser.js'), 'utf8');
    const collection = fs.readFileSync(path.join(ROOT, 'Bruno_Collection', 'opencollection.yml'), 'utf8');
    for (const name of ['exchangeTripType', 'exchangeTripSpecifications', 'exchangeTripSearchCriteria', 'exchangeOfferSearchCriteria', '__exchangeTripAsked']) {
      expect(parser).toContain(`"${name}"`);
      expect(collection).toContain(`"${name}"`);
    }
  });
});
