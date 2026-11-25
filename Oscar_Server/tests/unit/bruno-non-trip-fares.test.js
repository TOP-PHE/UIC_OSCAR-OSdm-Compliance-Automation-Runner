// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-non-trip-fares.test.js — #1449: fares sold without a trip (a
 * theoretical case), and the zone of a stop place of the trip
 * (nonTrip.zoneOf). The answers come from the OSDM simulator's own modules
 * (gamma, OSDM 3.8): its sale passes every check, and each check fails on
 * the answer broken for it.
 */

const path = require('path');

let envStore = {};
let sent = [];
let answers = [];
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar: (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  sendRequest: (options, callback) => { sent.push(options); const next = answers.shift(); callback(null, next); },
  runner: { setNextRequest: (name) => { envStore.__next = name; }, stopExecution: () => { envStore.__stopped = true; } },
};
let recorded = [];
// Bruno's test(), recorded; Jest's own is put back after each call (bruno()).
const brunoTest = (name, fn) => { try { fn(); recorded.push({ name, ok: true }); } catch (e) { recorded.push({ name, ok: false, message: e.message }); } };
const jestTest = global.test;
function bruno(fn) {
  global.test = brunoTest;
  const back = () => { global.test = jestTest; };
  let out;
  try { out = fn(); } catch (e) { back(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(back);
  back();
  return out;
}
let mockLogs = [];
global.validationLogger = (line) => { mockLogs.push(line); };
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));

const NT = require('../../../Bruno_Collection/library-bruno/nonTrip.js');
const nonTripFares = require('../../../Bruno_Collection/library-bruno/nonTripFares.js');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const fareBooking = require('../../../Bruno_Collection/library-bruno/fareBooking.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking, confirmBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const simNonTrip = require('../../../OSDM_Simulator/src/osdm/nonTrip');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const ROOT = path.join(__dirname, '..', '..', '..');
const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
const NOW = Date.parse('2026-11-02T09:00:00Z');
const CARRIER = gamma.carrier.ref;
const CENTRAL = 'urn:uic:stn:0000040';
const AIRPORT = 'urn:uic:stn:0000041';
const NORTH = 'urn:uic:stn:0000042';
const stop = (stopPlaceRef) => ({ objectType: 'StopPlaceRef', stopPlaceRef });
const PASSENGERS = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }, { externalRef: '00002', type: 'PERSON', dateOfBirth: '1985-06-01' }];
const VALID_FROM = '2026-11-20T00:00:00+01:00';

const FORMS = {
  zone: { criteria: { zones: [{ id: 'SIM-CITY', carrier: CARRIER }] }, asked: { by: 'ZONES', places: [], zones: [{ id: 'SIM-CITY', carrier: CARRIER }], nutsCodes: [] } },
  nuts: { criteria: { nutsCodes: ['XS111'] }, asked: { by: 'NUTS', places: [], zones: [], nutsCodes: ['XS111'] } },
  places: { criteria: { places: [stop(CENTRAL), stop(AIRPORT)] }, asked: { by: 'PLACES', places: [stop(CENTRAL), stop(AIRPORT)], zones: [], nutsCodes: [] } },
};

function requestOf(form) {
  return {
    nonTripSearchCriteria: { validFrom: VALID_FROM, ...FORMS[form].criteria },
    offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] },
    anonymousPassengerSpecifications: PASSENGERS,
  };
}

// A sale without a trip on the simulator: the answer, the offer chosen, its booking.
function sale(form) {
  const request = requestOf(form);
  const { response, remembered } = buildOfferCollection(request, gamma, NOW);
  const offer = response.offers[0];
  const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const booking = createBooking({
    offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
    passengerSpecifications: PASSENGERS.map((p, i) => ({ ...p, detail: { firstName: `P${i}`, lastName: 'Example' } })),
  }, (id) => known.get(id), gamma, NOW);
  const booked = structuredClone(booking);
  confirmBooking(booking, gamma, NOW + 1000);
  return { request, response: structuredClone(response), offer, booked, confirmed: structuredClone(booking) };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort();
const offerStep = (response, request, asked) => [...fares.fareChecks(response, request, { travelDay: '2026-11-20' }), ...nonTripFares.offerChecks(response, asked)];

beforeEach(() => {
  envStore = { api_base: 'https://provider.example/osdm', osdmVersion: '3.8.0', access_token: 'tok' };
  sent = [];
  answers = [];
  recorded = [];
  mockLogs = [];
});

describe('the simulator\'s sale of fares without a trip', () => {
  test.each(Object.keys(FORMS))('%s: every check passes at 01 and at each booking step; O8 has no section to look at', (form) => {
    const { request, response, offer, booked, confirmed } = sale(form);
    expect(offer.fares).toHaveLength(2);
    const checks = offerStep(response, request, FORMS[form].asked);
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['O1', 'O4', 'O7', 'O21', 'O22', 'O23']));
    expect(checks.some((c) => c.id === 'O8')).toBe(false);
    expect(failing([...fareBooking.bookingChecks(booked, offer, 'booked'), ...nonTripFares.bookingChecks(booked)])).toEqual([]);
    expect(failing([...fareBooking.bookingChecks(booked, offer, 'prebooked'), ...nonTripFares.bookingChecks(booked)])).toEqual([]);
    expect(failing([...fareBooking.confirmedBookingChecks(confirmed, offer), ...nonTripFares.bookingChecks(confirmed)])).toEqual([]);
  });

  test('O21 fails a trip in the answer, O22 a fare offer covering a trip, O23 warns a fare valid elsewhere', () => {
    const { request, response } = sale('zone');
    const withTrip = { ...response, trips: [{ id: 'T1' }] };
    expect(failing(nonTripFares.offerChecks(withTrip, FORMS.zone.asked))).toEqual(['O21 FAIL']);
    const covering = structuredClone(response);
    covering.offers[0].tripCoverage = { coveredTripId: 'T1' };
    expect(failing(nonTripFares.offerChecks(covering, FORMS.zone.asked))).toEqual(['O22 FAIL']);
    const elsewhere = structuredClone(response);
    elsewhere.offers[0].fares[0].regionalConstraint.regionalValidities[0].zone.carrier = 'urn:x_other:carrier';
    const warned = nonTripFares.offerChecks(elsewhere, FORMS.zone.asked).find((c) => c.id === 'O23');
    expect(warned).toMatchObject({ level: 'WARNING', ok: false });
    expect(warned.message).toContain('offers[0].fares[0]');
    // A fare without validity is O4's failure, not O23's.
    const none = structuredClone(response);
    none.offers[0].fares[0].regionalConstraint.regionalValidities = [];
    expect(failing(offerStep(none, request, FORMS.zone.asked))).toEqual(['O4 FAIL']);
  });

  test('O23 by NUTS code and by stop places', () => {
    const nuts = sale('nuts').response;
    nuts.offers[0].fares[1].regionalConstraint.regionalValidities[0].zone.nutsCode = 'XS999';
    expect(nonTripFares.offerChecks(nuts, FORMS.nuts.asked).find((c) => c.id === 'O23').message).toContain('offers[0].fares[1] (XS999)');
    const places = sale('places').response;
    places.offers[0].fares[0].regionalConstraint.regionalValidities[0].route.routeItemList.pop();
    expect(nonTripFares.offerChecks(places, FORMS.places.asked).find((c) => c.id === 'O23').message).toContain(AIRPORT);
  });

  test('B7 fails a booked offer or a fulfilment covering a trip', () => {
    const { confirmed } = sale('zone');
    const offerCovering = structuredClone(confirmed);
    offerCovering.bookedOffers[0].tripCoverage = { coveredTripId: 'T1' };
    expect(failing(nonTripFares.bookingChecks(offerCovering))).toEqual(['B7 FAIL']);
    const fulfillmentCovering = structuredClone(confirmed);
    fulfillmentCovering.fulfillments[0].tripCoverage = { coveredTripId: 'T1' };
    expect(nonTripFares.bookingChecks(fulfillmentCovering)[0].message).toContain('fulfillments[0]');
  });
});

describe('step 01 and the booking steps of a sale without a trip', () => {
  function armSale(form) {
    const { request, response, offer, booked, confirmed } = sale(form);
    Object.assign(envStore, { TripType: 'NON_TRIP', __nonTripAsked: JSON.stringify(FORMS[form].asked), OfferCollectionRequest: JSON.stringify(request), __travelDay: '2026-11-20' });
    return { response, offer, booked, confirmed };
  }

  test('01 checks the fares with O21 to O23 and books the offer; no warning about a requested section', () => {
    const { response } = armSale('zone');
    expect(bruno(() => fares.checkFareOffers(response))).toBe(true);
    expect(envStore.__fareSale).toBe('true');
    expect(recorded.filter((r) => !r.ok)).toEqual([]);
    expect(recorded.map((r) => r.name)).toEqual(expect.arrayContaining([
      '[fares O21] A request without a trip gets no trip in the answer (trips)',
      '[fares O22] No fare offer of a request without a trip covers a trip (tripCoverage absent)',
    ]));
    expect(mockLogs.some((l) => l.includes('without a requested section'))).toBe(false);
    expect(mockLogs.some((l) => l.startsWith('[WARNING]'))).toBe(false);
  });

  test('01 does not book an offer covering a trip (O22 failed)', () => {
    const { response } = armSale('zone');
    for (const offer of response.offers) offer.tripCoverage = { coveredTripId: 'T1' };
    expect(bruno(() => fares.checkFareOffers(response))).toBe(true);
    expect(envStore.__fareSale).toBeUndefined();
    expect(recorded.filter((r) => !r.ok).map((r) => r.name)).toEqual(['[fares O22] No fare offer of a request without a trip covers a trip (tripCoverage absent)']);
    expect(mockLogs.some((l) => l.includes('is not booked: its fares failed O22'))).toBe(true);
  });

  test('a sale with a trip gets none of the non-trip checks', () => {
    const { response } = armSale('zone');
    envStore.TripType = 'SEARCH';
    bruno(() => fares.checkFareOffers(response));
    expect(recorded.some((r) => /O2[1-3]\]/.test(r.name))).toBe(false);
  });

  test('05 and 07 add B7 for a sale without a trip only', () => {
    const { offer, booked, confirmed } = armSale('places');
    Object.assign(envStore, { __fareSale: 'true', offer: JSON.stringify(offer), offerId: offer.offerId });
    expect(bruno(() => fareBooking.checkFarePrebookedStep({ booking: booked }))).toBe(true);
    expect(recorded.filter((r) => r.name.startsWith('[fares B7]'))).toEqual([{ name: '[fares B7] Nothing of a booking without a trip covers a trip (tripCoverage absent)', ok: true }]);
    recorded = [];
    envStore.__confirmedFulfillments = JSON.stringify(confirmed.fulfillments);
    expect(bruno(() => fareBooking.checkFareConfirmedStep({ booking: confirmed }))).toBe(true);
    expect(recorded.filter((r) => !r.ok)).toEqual([]);
    expect(recorded.some((r) => r.name.startsWith('[fares B7]'))).toBe(true);
    recorded = [];
    envStore.TripType = 'SEARCH';
    bruno(() => fareBooking.checkFarePrebookedStep({ booking: booked }));
    expect(recorded.some((r) => r.name.startsWith('[fares B7]'))).toBe(false);
  });
});

describe('the zone of a stop place of the trip (nonTrip.zoneOf)', () => {
  const requirement = (nonTrip) => NT.nonTripRequirementOf({ tripType: 'NON_TRIP', nonTrip });

  test('read for ZONES and NUTS left to the lookup; refused otherwise', () => {
    expect(requirement({ by: 'ZONES', zoneOf: '0000042' }).zoneOf).toEqual(stop('urn:uic:stn:0000042'));
    expect(requirement({ by: 'NUTS', zoneOf: CENTRAL, nutsCodes: [] }).zoneOf).toEqual(stop(CENTRAL));
    expect(requirement({ by: 'ZONES' })).not.toHaveProperty('zoneOf');
    expect(requirement({ by: 'ZONES', zoneOf: 'AUTO' })).not.toHaveProperty('zoneOf');
    expect(requirement({ by: 'PLACES', places: [CENTRAL, AIRPORT], zoneOf: CENTRAL }).problem).toMatch(/ZONES or NUTS, not PLACES/);
    expect(requirement({ by: 'ZONES', zones: [{ id: 'SIM-CITY', carrier: CARRIER }], zoneOf: CENTRAL }).problem).toMatch(/one or the other/);
    expect(requirement({ by: 'NUTS', nutsCodes: ['XS111'], zoneOf: CENTRAL }).problem).toMatch(/NUTS codes .* one or the other/);
    expect(requirement({ by: 'ZONES', zoneOf: 'Simtown' }).problem).toMatch(/must be a stop place/);
  });

  test('the zone holding it, from GET /zones; a code without its leading zeros is the same stop place', () => {
    const zones = simNonTrip.zoneCollection(gamma);
    expect(NT.checkZonesAnswer(200, zones, stop(NORTH)).holding.id).toBe('SIM-NORTH');
    expect(NT.checkZonesAnswer(200, zones, stop('urn:uic:stn:41')).holding.id).toBe('SIM-CITY');
    expect(NT.checkZonesAnswer(200, zones, stop('urn:uic:stn:0000099')).holding).toBeNull();
    expect(NT.checkZonesAnswer(200, zones).holding).toBeNull();
    expect(NT.zoneHolds({ places: [CENTRAL] }, CENTRAL)).toBe(true);
    expect(NT.zoneHolds({ places: [{ id: CENTRAL }] }, CENTRAL)).toBe(true);
    expect(NT.zoneHolds({}, CENTRAL)).toBe(false);
  });

  test('the check: a zone holds it, and for NUTS names codes', () => {
    const zones = simNonTrip.zoneCollection(gamma);
    const south = stop('urn:uic:stn:0000045');
    expect(NT.zoneOfCheck(NT.checkZonesAnswer(200, zones, south), south, 'ZONES')).toMatchObject({ check: { ok: true }, zone: { id: 'SIM-SOUTH' } });
    const nuts = NT.zoneOfCheck(NT.checkZonesAnswer(200, zones, south), south, 'NUTS');
    expect(nuts.zone).toBeNull();
    expect(nuts.check).toMatchObject({ ok: false, message: 'zone SIM-SOUTH lists no NUTS code (ZoneDefinition.nutsCodes)' });
    const nowhere = stop('urn:uic:stn:0000099');
    expect(NT.zoneOfCheck(NT.checkZonesAnswer(200, zones, nowhere), nowhere, 'ZONES').check.message).toMatch(/no zone of GET \/zones lists it/);
    expect(NT.zoneOfCheck(NT.checkZonesAnswer(501, {}, nowhere), nowhere, 'ZONES').check.message).toMatch(/not implemented/);
  });

  test('the run: GET /zones, then the zone or its NUTS codes asked; none holding it ends the scenario with a failed check', async () => {
    const zones = { status: 200, data: simNonTrip.zoneCollection(gamma) };
    envStore.TripType = 'NON_TRIP';
    envStore.OfferCollectionRequest = '{}';
    envStore.nonTripRequirement = JSON.stringify(requirement({ by: 'ZONES', zoneOf: NORTH }));
    answers.push(zones);
    await NT.prepareNonTripRequest();
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://provider.example/osdm/zones']);
    expect(JSON.parse(envStore.OfferCollectionRequest).nonTripSearchCriteria).toEqual({ zones: [{ id: 'SIM-NORTH', carrier: CARRIER }] });
    expect(NT.checkNonTripLookup(brunoTest)).toBe(false);
    expect(recorded.filter((r) => !r.ok)).toEqual([]);
    expect(mockLogs.some((l) => l.includes(`stop place ${NORTH} is in zone SIM-NORTH (Simtown north)`))).toBe(true);

    envStore.OfferCollectionRequest = '{}';
    envStore.nonTripRequirement = JSON.stringify(requirement({ by: 'NUTS', zoneOf: AIRPORT }));
    answers.push(zones);
    await NT.prepareNonTripRequest();
    expect(JSON.parse(envStore.OfferCollectionRequest).nonTripSearchCriteria).toEqual({ nutsCodes: ['XS111'] });
    expect(JSON.parse(envStore.__nonTripAsked)).toMatchObject({ by: 'NUTS', nutsCodes: ['XS111'] });

    recorded = [];
    envStore.OfferCollectionRequest = '{}';
    envStore.nonTripRequirement = JSON.stringify(requirement({ by: 'ZONES', zoneOf: 'urn:uic:stn:0000099' }));
    answers.push(zones);
    await NT.prepareNonTripRequest();
    expect(envStore.OfferCollectionRequest).toBe('{}');
    expect(NT.checkNonTripLookup(brunoTest)).toBe(true);
    expect(recorded.filter((r) => !r.ok).map((r) => r.name)).toEqual(['Non-trip offers: a zone of GET /zones holds stop place urn:uic:stn:0000099 of the trip (nonTrip.zoneOf)']);
  });
});
