'use strict';

/**
 * bruno-fare-reservations.test.js — fare reservations, a bicycle place (#255).
 *
 * The offers and bookings come from the OSDM simulator's own modules (gamma,
 * OSDM 3.8): its fare reservations pass every check, and each of its two wrong
 * answers breaks exactly check V1. Hand-made answers cover the other rules.
 */

const fs = require('fs');
const path = require('path');
const fr = require('../../../Bruno_Collection/library-bruno/fareReservations.js');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const fareBooking = require('../../../Bruno_Collection/library-bruno/fareBooking.js');
const fareRefund = require('../../../Bruno_Collection/library-bruno/fareRefund.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking, confirmBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const ROOT = path.join(__dirname, '..', '..', '..');
const providers = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers'));
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const ADULT = { externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' };
const BICYCLE = { externalRef: '00002', type: 'BICYCLE', dateOfBirth: '1990-01-15' };
const BOTH = ['FARE_ADMISSION', 'FARE_RESERVATION'];

function request({ parts = BOTH, passengers = [ADULT, BICYCLE], start = '0000001' } = {}) {
  return {
    tripSpecifications: [{ isPartOfInternationalTrip: true, legs: [{ timedLeg: {
      start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
      end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
      service: { vehicleNumbers: ['1001'] },
    } }] }],
    requestedSections: [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: parts },
    anonymousPassengerSpecifications: passengers,
  };
}

const answer = (req, provider = 'gamma') => buildOfferCollection(req, providers.get(provider), NOW);

// A fare sale on the simulator: the first fare offer, booked with its fare reservations selected.
function sale({ req = request(), lastName = 'Example', select = true } = {}) {
  const { response, remembered } = answer(req);
  const offer = fares.chooseFareOffer(response, null);
  const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const selection = { offerId: offer.offerId, passengerRefs: offer.passengerRefs };
  if (select) selection.optionalReservationSelections = fr.selectionsFor(offer);
  const booking = createBooking({
    offers: [selection],
    passengerSpecifications: req.anonymousPassengerSpecifications.map((p, i) => ({ ...p, detail: { firstName: `P${i}`, lastName: i === 0 ? lastName : 'Example' } })),
  }, (id) => known.get(id), providers.get('gamma'), NOW);
  const booked = structuredClone(booking);
  const fulfillments = structuredClone(confirmBooking(booking, providers.get('gamma'), NOW + 1000));
  return { response, offer, booked, fulfillments, confirmed: structuredClone(booking) };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort((a, b) => a.localeCompare(b));
const ids = (checks) => checks.map((c) => `${c.id} ${c.level}`).sort((a, b) => a.localeCompare(b));

describe('the offer step on the simulator\'s answers', () => {
  test('fare admissions and reservations: V1, V3 and V2 pass, and O7 lets the bicycle go without a fare', () => {
    const req = request();
    const { response } = answer(req);
    const checks = fr.offerChecks(response, req, { osdmVersion: '3.8.0' });
    expect(ids(checks)).toEqual(['V1 FAIL', 'V2 WARNING', 'V3 FAIL']);
    expect(failing(checks)).toEqual([]);
    expect(failing(fares.fareChecks(response, req, { travelDay: '2026-11-20' }))).toEqual([]);
    expect(fr.unaskedReservationsCheck(response, req)).toBeNull();
  });

  test('fare reservations alone: one offer holding the place, a fare offer for the sale', () => {
    const req = request({ parts: ['FARE_RESERVATION'], passengers: [BICYCLE] });
    const { response } = answer(req);
    expect(failing(fr.offerChecks(response, req, { osdmVersion: '3.8.0' }))).toEqual([]);
    const chosen = fares.chooseFareOffer(response, null);
    expect(chosen.fares).toBeUndefined();
    expect(fr.selectionsFor(chosen)).toEqual([{ reservationId: chosen.reservationOfferParts[0].id }]);
    expect(fares.productOffersOf(response).includes(chosen)).toBe(false);
  });

  test('the place in product mode fails V1 only', () => {
    const req = request({ start: '0000088' });
    const { response } = answer(req);
    expect(failing(fr.offerChecks(response, req, { osdmVersion: '3.8.0' }))).toEqual(['V1 FAIL']);
    expect(failing(fares.fareChecks(response, req, { travelDay: '2026-11-20' }))).toEqual([]);
  });

  test('V1 is not asked when product reservations are asked too; V3 when there is no reservation at all', () => {
    const req = request({ parts: [...BOTH, 'RESERVATION'], start: '0000088' });
    const { response } = answer(req);
    expect(ids(fr.offerChecks(response, req, { osdmVersion: '3.8.0' }))).toEqual(['V2 WARNING', 'V3 FAIL']);
    const none = { offers: [{ offerId: 'F', fares: [{}] }] };
    expect(failing(fr.offerChecks(none, request(), { osdmVersion: '3.8.0' }))).toEqual(['V3 FAIL']);
    expect(failing(fr.offerChecks(none, request({ passengers: [ADULT] }), { osdmVersion: '3.8.0' }))).toEqual(['V3 FAIL']);
  });

  test('V2: a product on a fare reservation is a WARNING', () => {
    const req = request();
    const { response } = answer(req);
    response.offers.find((o) => o.reservationOfferParts?.length && o.fares).reservationOfferParts[0].products = [{ productId: 'P' }];
    expect(failing(fr.offerChecks(response, req, { osdmVersion: '3.8.0' }))).toEqual(['V2 WARNING']);
  });

  test('below OSDM 3.8, one WARNING and nothing checked; not asked, nothing at all', () => {
    const req = request();
    const checks = fr.offerChecks({ offers: [] }, req, { osdmVersion: '3.7.0' });
    expect(checks.map((c) => `${c.id} ${c.level} ${c.ok}`)).toEqual(['V1 WARNING false']);
    expect(checks[0].message).toContain('3.7.0');
    expect(fr.offerChecks({ offers: [] }, request({ parts: ['FARE_ADMISSION'] }), { osdmVersion: '3.8.0' })).toEqual([]);
    // The simulator offers none below 3.8.
    expect(fr.fareReservationCount(answer(req, 'beta').response)).toBe(0);
  });

  test('V8: fare reservations that were not asked fail; none, or none named, says nothing', () => {
    const { response } = answer(request());
    expect(failing([fr.unaskedReservationsCheck(response, request({ parts: ['FARE_ADMISSION'] }))])).toEqual(['V8 FAIL']);
    expect(fr.unaskedReservationsCheck(response, request({ parts: [] }))).toBeNull();
    expect(fr.unaskedReservationsCheck(answer(request({ parts: ['FARE_ADMISSION'] })).response, request({ parts: ['FARE_ADMISSION'] }))).toBeNull();
  });

  test('#905: a scenario expecting no fare counts fare reservations too', () => {
    const { response } = answer(request());
    const [none] = fares.noFareChecks(response, request());
    expect(none.ok).toBe(false);
    expect(none.message).toContain('fare reservation(s)');
  });
});

describe('the booking and fulfilment on the simulator\'s answers', () => {
  test('the sale passes every check at every step, the place counted with the fares', () => {
    const { offer, booked, fulfillments, confirmed } = sale();
    expect(failing(fareBooking.bookingChecks(booked, offer, 'booked'))).toEqual([]);
    expect(failing(fareBooking.bookingChecks(booked, offer, 'prebooked'))).toEqual([]);
    const reservationId = booked.bookedOffers[0].reservations[0].id;
    expect(fareBooking.productPartIdsOf(booked, offer)).not.toContain(reservationId);
    expect(fareBooking.farePartIdsOf(booked, offer)).toContain(reservationId);
    expect(failing(fareBooking.fulfillmentChecks(fulfillments, { fareIds: fareBooking.farePartIdsOf(booked, offer), productIds: fareBooking.productPartIdsOf(booked, offer) }))).toEqual([]);
    const final = fareBooking.confirmedBookingChecks(confirmed, offer);
    expect(failing(final)).toEqual([]);
    expect(final.map((c) => c.id)).toEqual(expect.arrayContaining(['V9', 'V1', 'V3', 'V10', 'V4', 'V7', 'V11', 'F4']));
  });

  test('a place alone is booked and checked without any fare check', () => {
    const { offer, booked, confirmed } = sale({ req: request({ parts: ['FARE_RESERVATION'], passengers: [BICYCLE] }) });
    const prebooked = fareBooking.bookingChecks(booked, offer, 'prebooked');
    expect(prebooked.some((c) => c.id.startsWith('B') && c.id !== 'B5')).toBe(false);
    expect(failing(prebooked)).toEqual([]);
    expect(failing(fareBooking.confirmedBookingChecks(confirmed, offer))).toEqual([]);
  });

  test('the place booked in product mode fails V1 only, and still counts as a fare part', () => {
    const { offer, booked, confirmed } = sale({ lastName: 'Simvariant-Fare-Reservation-Product-Mode' });
    expect(failing(fareBooking.bookingChecks(booked, offer, 'booked'))).toEqual(['V1 FAIL']);
    expect(failing(fareBooking.bookingChecks(booked, offer, 'prebooked'))).toEqual(['V1 FAIL']);
    expect(failing(fareBooking.confirmedBookingChecks(confirmed, offer))).toEqual(['V1 FAIL']);
    expect(fareBooking.productPartIdsOf(booked, offer)).toEqual([]);
  });

  test('a place not selected is not booked: V9 fails', () => {
    const { offer, booked } = sale({ select: false });
    expect(failing(fareBooking.bookingChecks(booked, offer, 'booked'))).toEqual(['V9 FAIL']);
  });
});

describe('the booking on hand-made answers', () => {
  const base = () => sale();
  const reservationOf = (booking) => booking.bookedOffers[0].reservations[0];

  test('V3 the place for another passenger, V10 another status', () => {
    const { offer, booked } = base();
    const other = structuredClone(booked);
    reservationOf(other).passengerIds = [other.passengers.find((p) => p.externalRef === '00001').id];
    expect(failing(fareBooking.bookingChecks(other, offer, 'booked'))).toEqual(['V3 FAIL']);
    const status = structuredClone(booked);
    reservationOf(status).status = 'CONFIRMED';
    expect(failing(fareBooking.bookingChecks(status, offer, 'prebooked'))).toEqual(['V10 FAIL']);
  });

  test('V4 and V7 say what the places and the IRS reference are', () => {
    const { offer, confirmed } = base();
    const notes = (booking) => fareBooking.confirmedBookingChecks(booking, offer).filter((c) => c.level === 'INFO' && c.id.startsWith('V')).map((c) => c.message);
    expect(notes(confirmed).join(' ')).toMatch(/1 place\(s\) allocated, 1 with place numbers/);
    expect(notes(confirmed).join(' ')).toMatch(/bookingPartCode absent, not an IRS 90918-1 reference/);
    const irs = structuredClone(confirmed);
    reservationOf(irs).bookingPartCode = '123456789012';
    delete reservationOf(irs).placeAllocation;
    expect(notes(irs).join(' ')).toMatch(/no place allocated/);
    expect(notes(irs).join(' ')).toMatch(/bookingPartCode "123456789012", an IRS 90918-1 reference/);
  });

  test('V11 a place in no fulfilment; V6 fulfilment parts told when present', () => {
    const { offer, confirmed } = base();
    const out = structuredClone(confirmed);
    out.fulfillments[0].bookingParts = out.fulfillments[0].bookingParts.filter((p) => p.id !== reservationOf(out).id);
    expect(failing(fareBooking.confirmedBookingChecks(out, offer))).toEqual(['V11 FAIL']);
    const parts = structuredClone(confirmed);
    parts.fulfillments[0].fulfillmentParts = [{ controlId: 'C1', securityFeatures: [{ type: 'BARCODE' }] }, { passengerRef: 'x' }];
    const note = fareBooking.confirmedBookingChecks(parts, offer).find((c) => c.id === 'V6');
    expect(note.message).toMatch(/^2 fulfilment part\(s\): 1 with a control id, 1 with security features/);
  });

  test('pairing is by id, else by passengers and leg', () => {
    const { offer, booked } = base();
    const renamed = structuredClone(booked);
    reservationOf(renamed).id = 'OTHER-ID';
    expect(fr.pairReservations(offer, renamed).pairs).toHaveLength(1);
    reservationOf(renamed).tripCoverage = { coveredTripId: 'T', coveredLegIds: ['elsewhere'] };
    expect(fr.pairReservations(offer, renamed).missing).toHaveLength(1);
  });

  test('an empty fulfilment is what GET /fulfillments/{id} may give for a fare reservation', () => {
    expect([undefined, null, {}, { id: 'F' }, { id: 'F', status: 'FULFILLED' }].map(fr.isEmptyFulfillment)).toEqual([true, true, true, true, false]);
  });

  test('the refund of #907 reads a fare reservation as a fare part with its price', () => {
    const { confirmed } = base();
    const kept = fareRefund.fareFulfillmentsOf(confirmed);
    expect(kept).toHaveLength(1);
    expect(kept[0].fares.map((f) => f.id)).toContain(reservationOf(confirmed).id);
    expect(fareRefund.feeRuleOf(kept[0].fares)).toBe('OTHER');
  });
});

describe('the Bruno glue', () => {
  const env = {};
  const recorded = [];
  const logged = [];
  let next = null;
  const realTest = test;
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    recorded.length = 0;
    logged.length = 0;
    next = null;
    global.bru = {
      getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; },
      runner: { setNextRequest: (n) => { next = n; }, stopExecution: () => {} },
    };
    global.test = (name, fn) => { try { fn(); recorded.push(`${name}: ok`); } catch (e) { recorded.push(`${name}: ${e.message}`); } };
    global.validationLogger = (line) => logged.push(line);
  });
  afterAll(() => { delete global.bru; delete global.validationLogger; global.test = realTest; });

  realTest('01 books a fare offer with its fare reservations selected; the product-mode place stops the sale', () => {
    const req = request();
    Object.assign(env, { OfferCollectionRequest: JSON.stringify(req), __travelDay: '2026-11-20', osdmVersion: '3.8.0' });
    expect(fares.checkFareOffers(answer(req).response)).toBe(true);
    expect(fares.isFareSale()).toBe(true);
    expect(JSON.parse(env.optionalReservationSelections)).toHaveLength(1);
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
    for (const k of Object.keys(env)) delete env[k];
    const wrong = request({ start: '0000088' });
    Object.assign(env, { OfferCollectionRequest: JSON.stringify(wrong), __travelDay: '2026-11-20', osdmVersion: '3.8.0' });
    expect(fares.checkFareOffers(answer(wrong).response)).toBe(true);
    expect(fares.isFareSale()).toBe(false);
    expect(env.optionalReservationSelections).toBeUndefined();
  });

  realTest('02 keeps the fare reservation among the fare parts; 07 names it for a refund', () => {
    const { offer, booked, confirmed } = sale();
    Object.assign(env, { __fareSale: 'true', offer, offerId: offer.offerId });
    fareBooking.checkFareBookingStep(200, { booking: booked });
    const reservationId = booked.bookedOffers[0].reservations[0].id;
    expect(JSON.parse(env.__fareIds)).toContain(reservationId);
    expect(JSON.parse(env.__fareReservationIds)).toEqual([reservationId]);
    expect(JSON.parse(env.__fareProductIds)).toEqual([]);
    fareBooking.checkFareConfirmedStep({ booking: confirmed });
    expect(env.admissionReservationAncillaryBookingPartsIds).toContain(reservationId);
  });

  realTest('06b: an error or an empty fulfilment is allowed for a fare reservation, then the next read', () => {
    const steps = require('../../../Bruno_Collection/library-bruno/fulfillmentSteps.js');
    // displays.js, loaded by fulfillmentSteps.js, puts its own logger on the global object.
    global.validationLogger = (line) => logged.push(line);
    Object.assign(env, { __fareSale: 'true', __fareReservationIds: JSON.stringify(['R1']), __fulfillmentsToRead: JSON.stringify(['F1', 'F2']) });
    expect(steps.checkFulfillmentReadStep(404, { title: 'not found' })).toBe(steps.READ_STEP);
    expect(recorded).toEqual([expect.stringMatching(/06b\. GET Fulfillment returns 404, allowed for a fare reservation .*: ok$/)]);
    // (06b logs through displays.js, not the global logger this test watches.)
    recorded.length = 0;
    expect(steps.checkFulfillmentReadStep(200, { fulfillment: {} })).toBe(steps.AFTER_READS);
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
    expect(logged.filter((l) => l.startsWith('[INFO] [fares V12]'))).toHaveLength(1);
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  test('both reset lists clear the fare reservation ids', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect(read(file)).toContain('"__fareRefundFeesSent", "__fareReservationIds"');
    }
  });

  test('no copy of a fare reservation scenario below OSDM 3.8', () => {
    const { reasonNotPossible } = require('../../../OSDM_Simulator/scripts/version-copies-lib.js');
    const source = { code: 'X_38', osdmVersion: '3.8.0', offerSearchCriteria: { requestedOfferParts: ['FARE_RESERVATION'] } };
    expect(reasonNotPossible(source, '3.6.0')).toMatch(/distributionMode/);
    expect(reasonNotPossible(source, '3.7.0')).toMatch(/distributionMode/);
    expect(reasonNotPossible(source, '3.9.0')).toBeNull();
  });
});
