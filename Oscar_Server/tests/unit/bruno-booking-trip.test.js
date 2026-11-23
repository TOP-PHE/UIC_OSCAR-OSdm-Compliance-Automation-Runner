// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-booking-trip.test.js — the trip of the booking against the trip of
 * the offer booked (#1299). Some real providers give a booking with no trip
 * though the offer booked covers one. OSDM requires neither Booking.trips nor
 * the trip coverage, so each finding is a WARNING line, never a test; a trip
 * is compared by what it is (booked ids may differ from the offer's).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');

let env = {};
let mockLogs = [];
global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; } };
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
}));

const T = require(path.join(LIB, 'bookingTrip.js'));
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const variants = require('../../../OSDM_Simulator/src/osdm/variants');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

beforeEach(() => { env = {}; mockLogs = []; });
afterAll(() => { delete global.bru; });

const stop = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const leg = (id, from, to, dep, arr) => ({ id, timedLeg: {
  start: { stopPlaceRef: stop(from), serviceDeparture: { timetabledTime: dep } },
  end: { stopPlaceRef: stop(to), serviceArrival: { timetabledTime: arr } },
} });
const TRIP = {
  id: 'T1', origin: stop('0000001'), destination: stop('0000002'),
  startTime: '2026-11-20T08:00:00+01:00', endTime: '2026-11-20T11:00:00+01:00',
  legs: [leg('T1-L1', '0000001', '0000002', '2026-11-20T08:00:00+01:00', '2026-11-20T11:00:00+01:00')],
};
const OFFER = { offerId: 'O1', tripCoverage: { coveredTripId: 'T1' }, admissionOfferParts: [{ id: 'A1', tripCoverage: { coveredTripId: 'T1' } }] };
const SOLD = T.offerTripShapes(OFFER, [TRIP, { ...TRIP, id: 'T2' }]);

describe('the rules', () => {
  test('the trips an offer covers: its own, its inbound one, its parts\'; each once', () => {
    expect(T.coveredTripIds(OFFER, T.PART_LISTS_OFFER)).toEqual(['T1']);
    expect(T.coveredTripIds({ inboundTripCoverage: { coveredTripId: 'R' }, reservationOfferParts: [{ tripCoverage: { coveredTripId: 'S' } }, { tripCoverage: {} }] }, T.PART_LISTS_OFFER)).toEqual(['R', 'S']);
    expect(T.coveredTripIds(undefined, T.PART_LISTS_BOOKED)).toEqual([]);
    expect(SOLD).toEqual([{ id: 'T1', origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', start: '2026-11-20T08:00:00+01:00', end: '2026-11-20T11:00:00+01:00', legs: 1 }]);
  });

  test('a trip without origin, destination or times is read from its timed legs', () => {
    const bare = { id: 'X', legs: [leg('L1', '0000001', '0000009', '2026-11-20T08:00:00+01:00', '2026-11-20T09:00:00+01:00'), { id: 'W', transferLeg: {} }, leg('L3', '0000009', '0000002', '2026-11-20T09:30:00+01:00', '2026-11-20T11:00:00+01:00')] };
    expect(T.shapeOf(bare)).toEqual({ id: 'X', origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', start: '2026-11-20T08:00:00+01:00', end: '2026-11-20T11:00:00+01:00', legs: 3 });
  });

  test('the same trip under another id, a UIC code without its zeros, another offset of the same instant', () => {
    const same = { ...T.shapeOf(TRIP), id: 'BOOKED-1', origin: 'urn:uic:stn:1', start: '2026-11-20T07:00:00Z' };
    expect(T.differences(SOLD[0], same)).toEqual([]);
  });

  test('what differs is named: stop places, start, end, number of legs', () => {
    const other = { id: 'B', origin: 'urn:uic:stn:0000003', destination: 'urn:uic:stn:0000002', start: '2026-11-20T09:00:00+01:00', end: '2026-11-20T12:00:00+01:00', legs: 2 };
    expect(T.differences(SOLD[0], other)).toEqual([
      'origin urn:uic:stn:0000003, not urn:uic:stn:0000001',
      'start 2026-11-20T09:00:00+01:00, not 2026-11-20T08:00:00+01:00',
      'end 2026-11-20T12:00:00+01:00, not 2026-11-20T11:00:00+01:00',
      '2 leg(s), not 1',
    ]);
  });

  test('a booking naming no trip at all: one finding', () => {
    const found = T.bookingTripFindings({ bookedOffers: [{ admissions: [{ id: 'A1' }] }] }, SOLD, ['T1']);
    expect(found).toEqual(['The booking names no trip (no Booking.trips, no trip coverage on its booked offers or parts), though the offer booked covers urn:uic:stn:0000001 → urn:uic:stn:0000002 at 2026-11-20T08:00:00+01:00. OSDM requires neither, but GET /bookings/{id} embeds the trips by default (embed ALL)']);
    expect(T.bookingTripFindings({}, [], ['T1'])[0]).toMatch(/though the offer booked covers T1\./);
  });

  test('a trip coverage alone, or the trip under another id: nothing to say', () => {
    expect(T.bookingTripFindings({ bookedOffers: [{ tripCoverage: { coveredTripId: 'T1' } }] }, SOLD, ['T1'])).toEqual([]);
    const renamed = { ...TRIP, id: 'BK-T', legs: [{ ...TRIP.legs[0], id: 'BK-L' }] };
    expect(T.bookingTripFindings({ trips: [renamed], bookedOffers: [{ tripCoverage: { coveredTripId: 'BK-T' } }] }, SOLD, ['T1'])).toEqual([]);
  });

  test('another trip in the booking, a coverage naming a trip it does not hold', () => {
    const later = { ...TRIP, startTime: '2026-11-20T10:00:00+01:00' };
    expect(T.bookingTripFindings({ trips: [later], bookedOffers: [{ tripCoverage: { coveredTripId: 'T1' } }] }, SOLD, ['T1']))
      .toEqual(['No trip of the booking is the trip sold (urn:uic:stn:0000001 → urn:uic:stn:0000002 at 2026-11-20T08:00:00+01:00): the closest, T1, has start 2026-11-20T10:00:00+01:00, not 2026-11-20T08:00:00+01:00']);
    expect(T.bookingTripFindings({ trips: [TRIP], bookedOffers: [{ admissions: [{ tripCoverage: { coveredTripId: 'GONE' } }] }] }, SOLD, ['T1']))
      .toEqual(['The booked offers or parts cover trip GONE, which is not a trip of the booking (Booking.trips holds T1)']);
  });

  test('an offer covering no trip is not compared', () => {
    expect(T.bookingTripFindings({}, [], [])).toEqual([]);
  });
});

describe('the glue', () => {
  test('kept at 01, said at each booking step as a WARNING line', () => {
    T.keepOfferTrips(OFFER, [TRIP]);
    expect(JSON.parse(env.__offerTrips)).toEqual({ ids: ['T1'], shapes: SOLD });
    T.checkBookingTrip({ bookedOffers: [{}] });
    expect(mockLogs).toEqual([expect.stringMatching(/^\[WARNING\] Trip of the booking: The booking names no trip .*embed ALL\)\.$/)]);
  });

  test('a sale without a trip is exempt; nothing kept, nothing said', () => {
    T.keepOfferTrips(OFFER, [TRIP]);
    env.TripType = 'NON_TRIP';
    T.checkBookingTrip({});
    delete env.TripType;
    delete env.__offerTrips;
    T.checkBookingTrip({});
    expect(mockLogs).toEqual([]);
  });
});

describe('on the simulator\'s own answers', () => {
  const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
  const NOW = Date.parse('2026-11-02T09:00:00Z');
  const PASSENGERS = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }];

  function sale(lastName) {
    const request = {
      tripSearchCriteria: { origin: stop('0000001'), destination: stop('0000002'), departureTime: '2026-11-20T08:00:00' },
      anonymousPassengerSpecifications: PASSENGERS,
    };
    const { response, remembered } = buildOfferCollection(request, gamma, NOW);
    const offer = response.offers[0];
    const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
      passengerSpecifications: PASSENGERS.map((p) => ({ ...p, detail: { firstName: 'Ada', lastName } })),
    }, (id) => known.get(id), gamma, NOW);
    return { response, offer, booking };
  }

  test('a booking as the simulator gives it: nothing to say', () => {
    const s = sale('Example');
    T.keepOfferTrips(s.offer, s.response.trips);
    T.checkBookingTrip(structuredClone(variants.bookingAsAnswered(s.booking)));
    T.checkBookingTrip(structuredClone(variants.bookingAsRead(s.booking)));
    expect(mockLogs).toEqual([]);
  });

  test('variant booking-without-trip: one WARNING at the booking and at its read', () => {
    const s = sale('Simvariant-Booking-Without-Trip');
    T.keepOfferTrips(s.offer, s.response.trips);
    T.checkBookingTrip(structuredClone(variants.bookingAsAnswered(s.booking)));
    T.checkBookingTrip(structuredClone(variants.bookingAsRead(s.booking)));
    expect(mockLogs).toHaveLength(2);
    expect(mockLogs[0]).toMatch(/^\[WARNING\] Trip of the booking: The booking names no trip \(no Booking\.trips, no trip coverage on its booked offers or parts\), though the offer booked covers urn:uic:stn:0000001 → urn:uic:stn:0000002 at /);
    // The stored booking keeps its trips.
    expect(s.booking.trips.length).toBeGreaterThan(0);
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  test('01 keeps the trips with the chosen offer; every booking step checks them after the non-trip checks', () => {
    const offers = read('Bruno_Collection/library-bruno/offers.js');
    const kept = offers.indexOf('require("./bookingTrip.js").keepOfferTrips(selectedOffer, jsonData.trips);');
    expect(kept).toBeGreaterThan(offers.indexOf('bru.setEnvVar("offer", selectedOffer);'));
    const bookings = read('Bruno_Collection/library-bruno/bookings.js');
    const checked = bookings.indexOf('require("./bookingTrip.js").checkBookingTrip(booking);');
    expect(checked).toBeGreaterThan(bookings.indexOf('recordNonTripBookingChecks(booking, _stage, test);'));
    // #1407: both are in the stage that looks at the booking itself, which
    // every booking step runs before it compares the booking with its offer.
    const stage = bookings.indexOf('function checkBookingIdentity(booking, expectedBookedOffersStatus) {');
    expect(stage).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(stage);
    expect(checked).toBeLessThan(bookings.indexOf('\n}\n', stage));
    const called = bookings.indexOf('  checkBookingIdentity(booking, expectedBookedOffersStatus);');
    expect(called).toBeGreaterThan(-1);
    expect(called).toBeLessThan(bookings.indexOf('checkBookingAfterOffer(booking, selectedOffer);'));
  });

  test('the variable is cleared with each scenario', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect([file, read(file).includes('"__fulfillmentIdsSeen", "__offerTrips"')]).toEqual([file, true]);
    }
  });
});
