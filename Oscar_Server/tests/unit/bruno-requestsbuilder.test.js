// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-requestsbuilder.test.js — increment 2 of the library-bruno harness (#85).
 *
 * Exercises every exported builder in requestsBuilder.js with a mocked `bru`
 * (getEnvVar/setEnvVar over an in-memory store) and a no-op `validationLogger`.
 * Covers the main branches of each so the file is well-covered (it joins the
 * Jest coverage set when loaded). Also validates the #84 hardening: a missing
 * REQUIRED scenario variable now throws an actionable error via parseEnvJson.
 */

let store = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
  setEnvVar: (k, v) => { store[k] = v; },
};
global.validationLogger = () => {};

const rb = require('../../../Bruno_Collection/library-bruno/requestsBuilder.js');

beforeEach(() => { store = {}; });
function setEnv(obj) { Object.assign(store, obj); }

describe('buildOfferCollectionRequest', () => {
  test('SEARCH (non-paxone): builds trip/passenger/criteria/fulfillment', () => {
    setEnv({
      TripType: 'SEARCH',
      api_base: 'https://sqills-osdm-test.cloud',
      offerTripSearchCriteria: '{"departureTime":"2026-05-29T07:00:00"}',
      offerPassengerSpecifications: '[{"externalRef":"00001","type":"PERSON"}]',
      offerSearchCriteria: '{"currency":"EUR","offerMode":"INDIVIDUAL"}',
      offerFulfillmentOptions: '[{"type":"ETICKET","media":"PDF_A4"}]',
    });
    rb.buildOfferCollectionRequest();
    const body = JSON.parse(store.OfferCollectionRequest);
    expect(body.tripSearchCriteria.departureTime).toBe('2026-05-29T07:00:00');
    expect(body.anonymousPassengerSpecifications).toHaveLength(1);
    expect(body.offerSearchCriteria.currency).toBe('EUR');
    expect(body.requestedFulfillmentOptions[0].type).toBe('ETICKET');
    expect(body.tripSpecifications).toBeUndefined();
  });

  test('SPECIFICATION: builds tripSpecifications instead of tripSearchCriteria', () => {
    setEnv({
      TripType: 'SPECIFICATION',
      api_base: 'https://x',
      offerTripSpecifications: '[{"trip":"T1"}]',
      offerPassengerSpecifications: '[{"externalRef":"00001"}]',
      offerSearchCriteria: '{"currency":"EUR"}',
      offerFulfillmentOptions: '',
    });
    rb.buildOfferCollectionRequest();
    const body = JSON.parse(store.OfferCollectionRequest);
    expect(body.tripSpecifications).toEqual([{ trip: 'T1' }]);
    expect(body.tripSearchCriteria).toBeUndefined();
    expect(body.requestedFulfillmentOptions).toEqual([]); // non-paxone keeps []
  });

  test('paxone + empty fulfillment options omits requestedFulfillmentOptions', () => {
    setEnv({
      TripType: 'SEARCH',
      api_base: 'https://staging.sandbox.paxone.app/api/osdm',
      offerTripSearchCriteria: '{}',
      offerPassengerSpecifications: '[]',
      offerSearchCriteria: '{}',
      offerFulfillmentOptions: '',
    });
    rb.buildOfferCollectionRequest();
    const body = JSON.parse(store.OfferCollectionRequest);
    expect(body).not.toHaveProperty('requestedFulfillmentOptions');
  });

  test('#84: missing required offerSearchCriteria throws actionable error', () => {
    setEnv({
      TripType: 'SEARCH',
      api_base: 'https://x',
      offerTripSearchCriteria: '{}',
      offerPassengerSpecifications: '[]',
      // offerSearchCriteria intentionally absent
    });
    expect(() => rb.buildOfferCollectionRequest())
      .toThrow(/Required scenario variable "offerSearchCriteria"/);
  });
});

describe('buildBookingRequest', () => {
  test('builds booking body (non-paxone, no place selection)', () => {
    setEnv({
      requiresPlaceSelection: 'false',
      accommodationSelection: 'NONE',
      api_base: 'https://x',
      bookingPassengerSpecifications: '[{"externalRef":"00001","detail":{"firstName":"John","lastName":"Doe"}}]',
      bookingPassengerReferences: '["00001"]',
      bookingPurchaserSpecifications: '{"detail":{"firstName":"P"}}',
      offerId: 'OFFER-1',
    });
    rb.buildBookingRequest();
    const body = JSON.parse(store.BookingRequest);
    expect(body.offers[0].offerId).toBe('OFFER-1');
    expect(body.offers[0].passengerRefs).toEqual(['00001']);
    expect(body.offers[0]).not.toHaveProperty('placeSelections');
    expect(body.purchaser.detail.firstName).toBe('P');
    expect(body.passengerSpecifications[0].detail.firstName).toBe('John');
    expect(body.externalRef).toBe('00001');
  });

  test('falls back to offerPassengerSpecifications when booking spec lacks names', () => {
    setEnv({
      requiresPlaceSelection: 'false',
      accommodationSelection: 'NONE',
      api_base: 'https://x',
      bookingPassengerSpecifications: '[{"externalRef":"00001"}]',
      offerPassengerSpecifications: '[{"externalRef":"00001","type":"PERSON"}]',
      bookingPassengerReferences: '["00001"]',
      bookingPurchaserSpecifications: '{}',
      offerId: 'O',
    });
    rb.buildBookingRequest();
    const body = JSON.parse(store.BookingRequest);
    expect(body.passengerSpecifications[0].type).toBe('PERSON');
  });

  test('#178 return: first (combined) attempt books BOTH the outbound and inbound offers', () => {
    setEnv({
      requiresPlaceSelection: 'false',
      accommodationSelection: 'NONE',
      api_base: 'https://x',
      bookingPassengerSpecifications: '[{"externalRef":"PAX1","detail":{"firstName":"A","lastName":"B"}}]',
      bookingPassengerReferences: '["PAX1"]',
      bookingPurchaserSpecifications: '{"detail":{"firstName":"P"}}',
      outboundOfferId: 'OUT-1',
      inboundOfferId: 'IN-1',
      offerId: 'IN-1',   // last offer captured = inbound; must NOT shadow the two-offer path
    });
    rb.buildBookingRequest();
    const body = JSON.parse(store.BookingRequest);
    expect(body.offers).toHaveLength(2);
    expect(body.offers[0].offerId).toBe('OUT-1');
    expect(body.offers[1].offerId).toBe('IN-1');
    expect(body.offers[0].passengerRefs).toEqual(['PAX1']);
    expect(body.offers[1].passengerRefs).toEqual(['PAX1']);
  });

  test('#180 return fallback: sep-out books only the outbound offer', () => {
    setEnv({
      requiresPlaceSelection: 'false', accommodationSelection: 'NONE', api_base: 'https://x',
      bookingPassengerSpecifications: '[{"externalRef":"PAX1","detail":{"firstName":"A","lastName":"B"}}]',
      bookingPassengerReferences: '["PAX1"]',
      bookingPurchaserSpecifications: '{}',
      outboundOfferId: 'OUT-1', inboundOfferId: 'IN-1', offerId: 'IN-1',
      __returnBookMode: 'sep-out',
    });
    rb.buildBookingRequest();
    const body = JSON.parse(store.BookingRequest);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].offerId).toBe('OUT-1');
  });

  test('#180 return fallback: sep-in books only the inbound offer', () => {
    setEnv({
      requiresPlaceSelection: 'false', accommodationSelection: 'NONE', api_base: 'https://x',
      bookingPassengerSpecifications: '[{"externalRef":"PAX1","detail":{"firstName":"A","lastName":"B"}}]',
      bookingPassengerReferences: '["PAX1"]',
      bookingPurchaserSpecifications: '{}',
      outboundOfferId: 'OUT-1', inboundOfferId: 'IN-1', offerId: 'IN-1',
      __returnBookMode: 'sep-in',
    });
    rb.buildBookingRequest();
    const body = JSON.parse(store.BookingRequest);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].offerId).toBe('IN-1');
  });
});

describe('buildReturnOfferCollectionRequest (#178)', () => {
  test('builds the inward request: O&D swapped, departureTime = inwardReturnDate, outwardOfferIds set', () => {
    setEnv({
      api_base: 'https://sqills-osdm-test.cloud',
      offerTripSearchCriteria: JSON.stringify({
        departureTime: '2026-06-03T09:22:00',
        origin: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:5457076' },
        destination: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:5454300' },
        returnSearchParameters: { inwardReturnDate: '2026-06-05T09:22:00' }
      }),
      outboundOfferId: 'OUT-1',
      offerPassengerSpecifications: '[{"externalRef":"PAX1","type":"PERSON"}]',
      offerSearchCriteria: '{}',
      offerFulfillmentOptions: '[{"type":"ETICKET","media":"PDF_A4"}]',
    });
    const ok = rb.buildReturnOfferCollectionRequest();
    expect(ok).toBe(true);
    const body = JSON.parse(store.ReturnOfferCollectionRequest);
    expect(body.tripSearchCriteria.departureTime).toBe('2026-06-05T09:22:00');
    expect(body.tripSearchCriteria.origin.stopPlaceRef).toBe('urn:uic:stn:5454300');      // swapped
    expect(body.tripSearchCriteria.destination.stopPlaceRef).toBe('urn:uic:stn:5457076'); // swapped
    expect(body.tripSearchCriteria.returnSearchParameters.outwardOfferIds).toEqual(['OUT-1']);
    expect(body.tripSearchCriteria.returnSearchParameters.inwardReturnDate).toBeUndefined();
    expect(body.anonymousPassengerSpecifications).toHaveLength(1);
    expect(body.requestedFulfillmentOptions[0].type).toBe('ETICKET');
  });

  test('returns false for a one-way scenario (no returnSearchParameters)', () => {
    setEnv({
      api_base: 'https://x',
      offerTripSearchCriteria: '{"departureTime":"2026-06-03T09:22:00","origin":{},"destination":{}}',
      outboundOfferId: 'OUT-1',
    });
    expect(rb.buildReturnOfferCollectionRequest()).toBe(false);
    expect(store.ReturnOfferCollectionRequest).toBeUndefined();
  });

  test('returns false when the outbound offer was not captured', () => {
    setEnv({
      api_base: 'https://x',
      offerTripSearchCriteria: JSON.stringify({ returnSearchParameters: { inwardReturnDate: '2026-06-05T09:22:00' } }),
    });
    expect(rb.buildReturnOfferCollectionRequest()).toBe(false);
  });
});

describe('accommodationAndPlaceSelection', () => {
  test('no selection → empty placeSelections', () => {
    setEnv({ requiresPlaceSelection: 'false', accommodationSelection: 'NONE' });
    rb.accommodationAndPlaceSelection();
    expect(JSON.parse(store.placeSelections)).toEqual([]);
  });

  test('COUCHETTE → accommodations entry, no places', () => {
    setEnv({
      accommodationSelection: 'COUCHETTE',
      requiresPlaceSelection: 'false',
      tripLegCoverage: '[{"tripId":"T1","legId":"L1"}]',
      bookingPassengerReferences: '["00001"]',
      reservationId: 'R1',
    });
    rb.accommodationAndPlaceSelection();
    const ps = JSON.parse(store.placeSelections);
    expect(ps[0].reservationId).toBe('R1');
    expect(ps[0].tripLegCoverage).toEqual({ tripId: 'T1', legId: 'L1' });
    expect(ps[0].accommodations[0].accommodationType).toBe('COUCHETTE');
    expect(ps[0].accommodations[0].passengerRefs).toEqual(['00001']);
    expect(ps[0]).not.toHaveProperty('places');
  });

  test('requiresPlaceSelection true → places entry', () => {
    setEnv({
      accommodationSelection: 'NONE',
      requiresPlaceSelection: 'true',
      tripLegCoverage: '[]',
      bookingPassengerReferences: '["00001"]',
      reservationId: 'R1',
      preselectedCoach: 'C1',
      preselectedPlace: 'P1',
    });
    rb.accommodationAndPlaceSelection();
    const ps = JSON.parse(store.placeSelections);
    expect(ps[0].places[0].coachNumber).toBe('C1');
    expect(ps[0].places[0].placeNumber).toBe('P1');
  });

  test('preselectedPlaces → one place per passenger (multi-pax, distinct seats)', () => {
    setEnv({
      // No requiresPlaceSelection flag: the picks alone enable place selection.
      accommodationSelection: 'NONE',
      tripLegCoverage: '[{"tripId":"T1","legId":"L1"}]',
      bookingPassengerReferences: '["00001","00002"]',
      reservationId: 'R1',
      preselectedPlaces: '[{"coachNumber":"12","placeNumber":"21"},{"coachNumber":"12","placeNumber":"22"}]',
    });
    rb.accommodationAndPlaceSelection();
    const ps = JSON.parse(store.placeSelections);
    expect(ps[0].places).toHaveLength(2);
    expect(ps[0].places[0]).toEqual({ passengerRefs: ['00001'], coachNumber: '12', placeNumber: '21' });
    expect(ps[0].places[1]).toEqual({ passengerRefs: ['00002'], coachNumber: '12', placeNumber: '22' });
  });

  test('preselectedPlaces fewer than passengers → surplus pax reuse the last place', () => {
    setEnv({
      accommodationSelection: 'NONE',
      tripLegCoverage: '[]',
      bookingPassengerReferences: '["00001","00002","00003"]',
      reservationId: 'R1',
      preselectedPlaces: '[{"coachNumber":"1","placeNumber":"5"}]',
    });
    rb.accommodationAndPlaceSelection();
    const ps = JSON.parse(store.placeSelections);
    expect(ps[0].places).toHaveLength(3);
    expect(ps[0].places.map((p) => p.passengerRefs[0])).toEqual(['00001', '00002', '00003']);
    expect(ps[0].places.every((p) => p.placeNumber === '5')).toBe(true);
  });
});

describe('collectAvailablePlaces', () => {
  test('returns [] for missing/invalid vehicle', () => {
    expect(rb.collectAvailablePlaces(null, 2)).toEqual([]);
    expect(rb.collectAvailablePlaces({}, 2)).toEqual([]);
    expect(rb.collectAvailablePlaces({ coaches: 'x' }, 2)).toEqual([]);
  });

  test('skips occupied/reserved/unavailable places, keeps available, respects count', () => {
    const vehicle = {
      coaches: [{
        coachNumber: '12', layoutId: 'L9',
        places: [
          { number: '1', available: false },
          { number: '2', occupied: true },
          { number: '3', state: 'RESERVED' },
          { number: '4', available: true },
          { number: '5', availability: 'AVAILABLE' },
          { number: '6' }, // no availability info → assumed available
        ],
      }],
    };
    const out = rb.collectAvailablePlaces(vehicle, 2);
    expect(out).toEqual([
      { coachNumber: '12', placeNumber: '4', layoutId: 'L9' },
      { coachNumber: '12', placeNumber: '5', layoutId: 'L9' },
    ]);
  });

  test('flattens across coaches and handles compartments[].places + compartment.place shapes', () => {
    const vehicle = {
      coaches: [
        { coachNumber: 'A', layoutId: 'LA', compartments: [{ places: [{ place: 'a1', available: true }] }] },
        { coachNumber: 'B', layoutId: 'LB', compartments: [{ place: 'b1', state: 'FREE' }] }, // compartment IS a place
      ],
    };
    const out = rb.collectAvailablePlaces(vehicle, 5);
    expect(out).toEqual([
      { coachNumber: 'A', placeNumber: 'a1', layoutId: 'LA' },
      { coachNumber: 'B', placeNumber: 'b1', layoutId: 'LB' },
    ]);
  });

  test('count defaults to at least 1', () => {
    const vehicle = { coaches: [{ coachNumber: '1', places: [{ number: 'x', available: true }, { number: 'y', available: true }] }] };
    expect(rb.collectAvailablePlaces(vehicle, 0)).toHaveLength(1);
    expect(rb.collectAvailablePlaces(vehicle)).toHaveLength(1);
  });
});

describe('placesForPassengers', () => {
  const picked = [
    { coachNumber: '12', placeNumber: '21' },
    { coachNumber: '12', placeNumber: '22' },
  ];

  test('one entry per passenger, paired by index', () => {
    expect(rb.placesForPassengers(picked, ['00001', '00002'])).toEqual([
      { passengerRefs: ['00001'], coachNumber: '12', placeNumber: '21' },
      { passengerRefs: ['00002'], coachNumber: '12', placeNumber: '22' },
    ]);
  });

  test('surplus passengers reuse the last picked place', () => {
    const out = rb.placesForPassengers([{ coachNumber: '1', placeNumber: '5' }], ['00001', '00002', '00003']);
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.placeNumber === '5')).toBe(true);
    expect(out.map((p) => p.passengerRefs[0])).toEqual(['00001', '00002', '00003']);
  });

  test('returns [] when nothing to assign', () => {
    expect(rb.placesForPassengers([], ['00001'])).toEqual([]);
    expect(rb.placesForPassengers(picked, [])).toEqual([]);
    expect(rb.placesForPassengers(null, ['00001'])).toEqual([]);
    expect(rb.placesForPassengers(picked, null)).toEqual([]);
  });
});

describe('requestRefundOffersBody', () => {
  test('includes fulfillmentIds + optional overruleCode/refundDate', () => {
    setEnv({ fulfillmentIds: '["F1","F2"]' });
    rb.requestRefundOffersBody('PAYMENT_FAILURE', '2026-01-15');
    const body = JSON.parse(store.requestRefundOffersBodyData);
    expect(body.fulfillmentIds).toEqual(['F1', 'F2']);
    expect(body.overruleCode).toBe('PAYMENT_FAILURE');
    expect(body.refundDate).toBe('2026-01-15');
  });

  test('omits overruleCode/refundDate when null', () => {
    setEnv({ fulfillmentIds: '["F1"]' });
    rb.requestRefundOffersBody();
    const body = JSON.parse(store.requestRefundOffersBodyData);
    expect(body).not.toHaveProperty('overruleCode');
    expect(body).not.toHaveProperty('refundDate');
  });
});

describe('requestExchangeOffersBody', () => {
  test('happy: per-passenger anonymousPassengerSpecifications + overruleCode', () => {
    setEnv({
      fulfillmentIds: '["F1"]',
      offerPassengerSpecifications: '[{"externalRef":"00001","type":"PERSON","dateOfBirth":"1999-01-01"}]',
      offerTripSearchCriteria: '{"departureTime":"x"}',
      offerSearchCriteria: '{"currency":"EUR"}',
    });
    rb.requestExchangeOffersBody('PAYMENT_FAILURE');
    const body = JSON.parse(store.requestExchangeOffersBodyData);
    expect(body.anonymousPassengerSpecifications).toHaveLength(1);
    expect(body.anonymousPassengerSpecifications[0].externalRef).toBe('00001');
    expect(body.tripSearchCriteria).toBeDefined();
    expect(body.overruleCode).toBe('PAYMENT_FAILURE');
  });

  test('fallback (catch): empty passenger specs → single default passenger, no overruleCode', () => {
    setEnv({
      fulfillmentIds: '["F1"]',
      offerPassengerSpecifications: '[]',
      offerTripSearchCriteria: '{}',
      offerSearchCriteria: '{}',
    });
    rb.requestExchangeOffersBody();
    const body = JSON.parse(store.requestExchangeOffersBodyData);
    expect(body.anonymousPassengerSpecifications).toHaveLength(1);
    expect(body.anonymousPassengerSpecifications[0].externalRef).toBe('00001');
    expect(body).not.toHaveProperty('overruleCode');
  });
});

describe('requestExchangeOperationsBody', () => {
  test('builds exchangeOffers with offerId + passengerRefs', () => {
    setEnv({
      exchangeOffersOfferId: 'EX-1',
      bookingPassengerReferences: '["00001"]',
    });
    rb.requestExchangeOperationsBody();
    const body = JSON.parse(store.requestExchangeOperationsBodyData);
    expect(body.exchangeOffers[0].offerId).toBe('EX-1');
    expect(body.exchangeOffers[0].passengerRefs).toEqual(['00001']);
  });
});
