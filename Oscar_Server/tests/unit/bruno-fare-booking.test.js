'use strict';

/**
 * bruno-fare-booking.test.js — booking and fulfilment of a fare (#906).
 *
 * The bookings and fulfilments come from the OSDM simulator's own modules
 * (gamma, OSDM 3.8): its normal fare sale passes every check, and each of its
 * two wrong fare fulfilments breaks exactly the check it is made for. Hand-made
 * answers cover the other rules.
 */

const fs = require('fs');
const path = require('path');
const fareBooking = require('../../../Bruno_Collection/library-bruno/fareBooking.js');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking, confirmBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const ROOT = path.join(__dirname, '..', '..', '..');
const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const PASSENGERS = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }, { externalRef: '00002', type: 'PERSON', dateOfBirth: '1985-06-01' }];

// A fare sale on the simulator: the offer chosen, its booking, its fulfilments.
function sale({ lastName = 'Example' } = {}) {
  const request = {
    tripSpecifications: [{ isPartOfInternationalTrip: true, legs: [{ timedLeg: {
      start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
      end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
      service: { vehicleNumbers: ['1001'] },
    } }] }],
    requestedSections: [{ startPlace: station('0000001'), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] },
    anonymousPassengerSpecifications: PASSENGERS,
  };
  const { response, remembered } = buildOfferCollection(request, gamma, NOW);
  const offer = response.offers.find((o) => o.fares);
  const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const booking = createBooking({
    offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
    passengerSpecifications: PASSENGERS.map((p, i) => ({ ...p, detail: { firstName: `P${i}`, lastName: i === 0 ? lastName : 'Example' } })),
  }, (id) => known.get(id), gamma, NOW);
  const booked = structuredClone(booking);
  const fulfillments = structuredClone(confirmBooking(booking, gamma, NOW + 1000));
  return { offer, booked, fulfillments, confirmed: structuredClone(booking) };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort();
const idsOf = (booking) => ({ fareIds: fareBooking.bookedFaresOf(booking).map(({ fare }) => fare.id), productIds: fareBooking.productPartIdsOf(booking) });

describe('the fare sale on the simulator\'s answers', () => {
  test('the normal sale passes every check at every step', () => {
    const { offer, booked, fulfillments, confirmed } = sale();
    expect(failing(fareBooking.bookingChecks(booked, offer, 'booked'))).toEqual([]);
    expect(failing(fareBooking.bookingChecks(booked, offer, 'prebooked'))).toEqual([]);
    expect(failing(fareBooking.fulfillmentChecks(fulfillments, idsOf(booked)))).toEqual([]);
    expect(failing(fareBooking.confirmedBookingChecks(confirmed, offer))).toEqual([]);
    expect(fulfillments).toHaveLength(1);
  });

  test('a fare left out of bookingParts fails F5 only; a PDF ticket gives F2 warnings only', () => {
    const left = sale({ lastName: 'Simvariant-Fare-Not-In-Fulfillment' });
    expect(failing(fareBooking.fulfillmentChecks(left.fulfillments, idsOf(left.booked)))).toEqual([]);
    expect(failing(fareBooking.confirmedBookingChecks(left.confirmed, left.offer))).toEqual(['F5 FAIL']);
    const ticket = sale({ lastName: 'Simvariant-Fare-Fulfillment-Document' });
    expect(failing(fareBooking.fulfillmentChecks(ticket.fulfillments, { ...idsOf(ticket.booked), documents: ticket.confirmed.fulfillmentDocuments })))
      .toEqual(['F2 WARNING', 'F2 WARNING']);
    expect(failing(fareBooking.confirmedBookingChecks(ticket.confirmed, ticket.offer))).toEqual(['F2 WARNING', 'F2 WARNING']);
  });
});

describe('the fare sale on hand-made answers', () => {
  const base = () => sale();
  const firstFare = (booking) => booking.bookedOffers[0].fares[0];

  test('B1 no fare, B2 a fare missing, B3 a member missing, B4 another price', () => {
    const { offer, booked } = base();
    const none = structuredClone(booked);
    delete none.bookedOffers[0].fares;
    expect(failing(fareBooking.bookingChecks(none, offer, 'booked'))).toEqual(['B1 FAIL']);
    const missing = structuredClone(booked);
    missing.bookedOffers[0].fares.pop();
    expect(failing(fareBooking.bookingChecks(missing, offer, 'booked'))).toEqual(['B2 FAIL']);
    const member = structuredClone(booked);
    delete firstFare(member).travelValidityConstraint;
    expect(failing(fareBooking.bookingChecks(member, offer, 'booked'))).toEqual(['B3 FAIL']);
    const price = structuredClone(booked);
    firstFare(price).prices[0].amount += 1;
    expect(failing(fareBooking.bookingChecks(price, offer, 'booked'))).toEqual(['B4 FAIL']);
  });

  test('B5 the provisional price, B6 a status other than expected (FAIL) or none (WARNING)', () => {
    const { offer, booked, confirmed } = base();
    const sum = structuredClone(booked);
    sum.provisionalPrice.amount += 1;
    expect(failing(fareBooking.bookingChecks(sum, offer, 'prebooked'))).toEqual(['B5 WARNING']);
    const status = structuredClone(booked);
    firstFare(status).status = 'CONFIRMED';
    expect(failing(fareBooking.bookingChecks(status, offer, 'prebooked'))).toEqual(['B6 FAIL']);
    const absent = structuredClone(confirmed);
    delete firstFare(absent).status;
    expect(failing(fareBooking.bookingChecks(absent, offer, 'confirmed'))).toEqual(['B6 WARNING']);
    expect(failing(fareBooking.bookingChecks(booked, offer, 'confirmed'))).toEqual(['B6 FAIL']);
  });

  test('F1 status, F2 the members a fare fulfilment does not include, F3 parts named, F4 fares and products mixed', () => {
    const { booked, fulfillments } = base();
    const ids = idsOf(booked);
    const changed = (change) => { const f = structuredClone(fulfillments); change(f[0]); return failing(fareBooking.fulfillmentChecks(f, ids)); };
    expect(changed((f) => { f.status = 'AVAILABLE'; })).toEqual(['F1 FAIL']);
    for (const [member, value] of [['controlNumber', '123'], ['issuer', 'urn:x'], ['continuousServiceUsage', {}], ['_links', [{ rel: 'self' }]]]) {
      expect(changed((f) => { f[member] = value; })).toEqual(['F2 WARNING']);
    }
    expect(changed((f) => { f.bookingParts = []; })).toEqual(['F3 FAIL']);
    expect(changed((f) => { f.bookingParts.push({ id: 'NOT-A-PART' }); })).toEqual(['F3 FAIL']);
    expect(failing(fareBooking.fulfillmentChecks(fulfillments, { ...ids, productIds: ['ADM-1'] }))).toEqual([]);
    const mixed = structuredClone(fulfillments);
    mixed[0].bookingParts.push({ id: 'ADM-1' });
    expect(failing(fareBooking.fulfillmentChecks(mixed, { ...ids, productIds: ['ADM-1'] }))).toEqual(['F4 FAIL']);
  });

  test('F5 no fulfilment listed; F6 an attribute the ticket needs that differs from the offer', () => {
    const { offer, confirmed } = base();
    const none = structuredClone(confirmed);
    none.fulfillments = [];
    expect(failing(fareBooking.confirmedBookingChecks(none, offer))).toEqual(['F5 FAIL']);
    const region = structuredClone(confirmed);
    firstFare(region).regionalConstraint.regionalValidities[0].seqNb = 9;
    expect(failing(fareBooking.confirmedBookingChecks(region, offer))).toEqual(['F6 WARNING']);
  });

  test('pairing is by content, never by position: any order gives the same pairs', () => {
    const { offer, booked } = base();
    const reversed = structuredClone(booked);
    reversed.bookedOffers[0].fares.reverse();
    const offerReversed = { ...offer, fares: [...offer.fares].reverse() };
    const pairsOf = (o, b) => fareBooking.pairFares(o.fares, b).pairs.map((p) => `${p.offered.id}=${p.booked.id}`).sort();
    expect(pairsOf(offerReversed, reversed)).toEqual(pairsOf(offer, booked));
    expect(fareBooking.pairFares(offer.fares, booked).missing).toEqual([]);
    // A fare with another id still pairs by its passengers (the booking names them by id).
    const renamed = structuredClone(booked);
    firstFare(renamed).id = 'RENAMED';
    expect(fareBooking.pairFares(offer.fares, renamed).missing).toEqual([]);
  });
});

describe('step 01 decides the fare sale', () => {
  test('booked when no FAIL-level check failed; not when one did or no offer was chosen', () => {
    const offer = { offerId: 'F1', fares: [{}] };
    expect(fares.fareSaleDecision([{ id: 'O10', level: 'WARNING', ok: false }], offer).book).toBe(true);
    expect(fares.fareSaleDecision([{ id: 'O7', level: 'FAIL', ok: false }], offer)).toMatchObject({ book: false });
    expect(fares.fareSaleDecision([{ id: 'O7', level: 'FAIL', ok: false }], offer).reason).toMatch(/failed O7/);
    expect(fares.fareSaleDecision([], null).book).toBe(false);
  });
});

describe('the Bruno glue', () => {
  const env = {};
  const recorded = [];
  const logged = [];
  let next = null;
  let stopped = false;
  const realTest = test;
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    recorded.length = 0;
    logged.length = 0;
    next = null;
    stopped = false;
    global.bru = {
      getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; },
      runner: { setNextRequest: (n) => { next = n; }, stopExecution: () => { stopped = true; } },
    };
    global.test = (name, fn) => { try { fn(); recorded.push(`${name}: ok`); } catch (e) { recorded.push(`${name}: ${e.message}`); } };
    global.validationLogger = (line) => logged.push(line);
  });
  afterAll(() => { delete global.bru; delete global.validationLogger; global.test = realTest; });

  realTest('without a fare sale, every step leaves the answer to the product checks', () => {
    expect(fareBooking.checkFareBookingStep(200, {})).toBe(false);
    expect(fareBooking.checkFarePrebookedStep({})).toBe(false);
    expect(fareBooking.checkFareFulfillmentStep({})).toBe(false);
    expect(fareBooking.checkFareConfirmedStep({})).toBe(false);
    expect(recorded).toEqual([]);
  });

  realTest('02 keeps the booking id and goes to 05; 07 checks, keeps the fare ids and ends the scenario', () => {
    const { offer, booked, confirmed } = sale();
    Object.assign(env, { __fareSale: 'true', offer, offerId: offer.offerId });
    expect(fareBooking.checkFareBookingStep(200, { booking: booked })).toBe(true);
    expect(env.bookingId).toBe(booked.id);
    expect(next).toBe('05. GET Booking before Fulfillments');
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
    expect(JSON.parse(env.__fareIds)).toEqual(offer.fares.map((f) => f.id));
    recorded.length = 0;
    expect(fareBooking.checkFareConfirmedStep({ booking: confirmed })).toBe(true);
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
    expect(env.admissionReservationAncillaryBookingPartsIds).toEqual(offer.fares.map((f) => f.id));
    expect(stopped).toBe(true);
    env.__scenariosList = JSON.stringify(['A', 'B']);
    env.scenariosToRunIndex = '1';
    fareBooking.checkFareConfirmedStep({ booking: confirmed });
    expect(next).toBe('01. POST Get Offer');
  });

  realTest('02 refused: one failed status check and the scenario stops', () => {
    env.__fareSale = 'true';
    expect(fareBooking.checkFareBookingStep(409, { title: 'no' })).toBe(true);
    expect(recorded.filter((r) => !r.endsWith(': ok'))).toHaveLength(1);
    expect(stopped || next === '01. POST Get Offer').toBe(true);
  });

  realTest('01: a fare offer that passed its checks is booked; bookMode PRODUCT goes on with the products', () => {
    const { offer } = sale();
    const request = { requestedSections: [{ startPlace: station('0000001'), endPlace: station('0000002') }], offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] }, anonymousPassengerSpecifications: PASSENGERS };
    const body = () => ({ offers: [structuredClone(offer), { offerId: 'P1', admissionOfferParts: [{ id: 'A' }], products: [{ id: 'x' }] }] });
    Object.assign(env, { OfferCollectionRequest: JSON.stringify(request), __travelDay: '2026-11-20' });
    expect(fares.checkFareOffers(body())).toBe(true);
    expect(fares.isFareSale()).toBe(true);
    expect(env.offerId).toBe(offer.offerId);
    for (const k of Object.keys(env)) if (k !== 'OfferCollectionRequest') delete env[k];
    env.bookMode = 'PRODUCT';
    const products = body();
    expect(fares.checkFareOffers(products)).toBe(false);
    expect(fares.isFareSale()).toBe(false);
    expect(products.offers.map((o) => o.offerId)).toEqual(['P1']);
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const step = (name) => read(`Bruno_Collection/02-Common Requests/${name}`);

  test('01 routes a fare sale to 02; 02, 05, 06 and 07 hand it to fareBooking.js after their status and JSON checks', () => {
    const offer = step('01. POST Get Offer.yml');
    expect(offer).toContain('fares.js").isFareSale()) {\n            bru.runner.setNextRequest("02. POST Create Booking");');
    const booking = step('02. POST Create Booking.yml');
    const at = booking.indexOf('fareBooking.js").checkFareBookingStep(_status, _body)');
    expect(at).toBeGreaterThan(booking.indexOf('try { _body = res.getBody(); }'));
    expect(at).toBeLessThan(booking.indexOf('const _isReturn ='));
    const before = step('05. GET Booking before Fulfillments.yml');
    expect(before.indexOf('checkFarePrebookedStep(jsonData)')).toBeGreaterThan(before.indexOf('jsonObjectOrStop(jsonData'));
    expect(before.indexOf('checkFarePrebookedStep(jsonData)')).toBeLessThan(before.indexOf('postCreateBookingResponse('));
    const confirm = step('06. POST Obtaining Fulfillments from Booking.yml');
    expect(confirm.indexOf('checkFareFulfillmentStep(jsonData)')).toBeGreaterThan(confirm.indexOf('jsonData = res.getBody();'));
    expect(confirm.indexOf('checkFareFulfillmentStep(jsonData)')).toBeLessThan(confirm.indexOf('validateFulfillments(jsonData.fulfillments'));
    const after = step('07. GET Booking after Fulfillments.yml');
    expect(after.indexOf('checkFareConfirmedStep(jsonData)')).toBeGreaterThan(after.indexOf('jsonObjectOrStop(jsonData'));
    expect(after.indexOf('checkFareConfirmedStep(jsonData)')).toBeLessThan(after.indexOf('postCreateBookingResponse('));
    expect(read('Bruno_Collection/library-bruno/fulfillmentSteps.js')).toContain("fareBooking.recordFareChecks(fareBooking.fulfillmentReadChecks(body, id));");
  });

  test('both reset lists clear the fare sale', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect(read(file)).toContain('"fareOfferId", "__fareSale", "__fareIds", "__fareProductIds"');
    }
  });

  test('an offer of fares only is not counted as naming no trip (offers by trip id)', () => {
    const { checkOffersForTrip } = require('../../../Bruno_Collection/library-bruno/tripIds.js');
    const body = { trips: [{ id: 'T' }], offers: [{ offerId: 'F', fares: [{}] }, { offerId: 'P', admissionOfferParts: [{ tripCoverage: { coveredTripId: 'T' } }] }] };
    expect(checkOffersForTrip(body, 'T').filter((c) => !c.ok)).toEqual([]);
    const nothing = { trips: [{ id: 'T' }], offers: [{ offerId: 'X', admissionOfferParts: [{}] }] };
    expect(checkOffersForTrip(nothing, 'T').some((c) => /name no trip/.test(c.name))).toBe(true);
  });
});
