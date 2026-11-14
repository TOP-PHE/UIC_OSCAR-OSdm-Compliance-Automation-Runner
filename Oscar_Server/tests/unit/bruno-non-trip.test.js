// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-non-trip.test.js — #1258: offers without a trip, by stop places or
 * by zones (library-bruno/nonTrip.js), and the parser's NON_TRIP branch.
 */

let envStore = {};
let sent = [];
let answers = [];
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar: (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  sendRequest: (options, callback) => { sent.push(options); const next = answers.shift(); callback(null, next); },
};

let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));

const NT = require('../../../Bruno_Collection/library-bruno/nonTrip.js');

const CENTRAL = 'urn:uic:stn:0000040';
const AIRPORT = 'urn:uic:stn:0000041';
const stop = (stopPlaceRef) => ({ objectType: 'StopPlaceRef', stopPlaceRef });
const route = (...refs) => ({ seqNb: 1, route: { routeItemList: refs.map((id) => ({ station: { objectType: 'StopPlace', id, name: id } })) } });
const admission = (extra = {}) => ({
  objectType: 'AdmissionOfferPart',
  id: 'A1',
  regionalValiditySummary: { description: 'Central - Airport', shortDescription: 'C - A' },
  regionalValidities: [route(CENTRAL, AIRPORT)],
  ...extra,
});
const PLACES = { by: 'PLACES', places: [stop(CENTRAL), stop(AIRPORT)], zones: [] };
const ZONES = { by: 'ZONES', places: [], zones: [{ id: 'SIM-CITY', carrier: 'urn:x_osdm_simulator:carrier:gamma' }] };
const failed = (checks) => checks.filter((c) => !c.ok && c.level !== 'warn').map((c) => c.name);
const warned = (checks) => checks.filter((c) => !c.ok && c.level === 'warn').map((c) => c.name);

beforeEach(() => {
  envStore = { api_base: 'https://provider.example/osdm', osdmVersion: '3.8.0', access_token: 'tok' };
  sent = [];
  answers = [];
  mockLogs = [];
});

describe('the trip requirement', () => {
  test('stop places as URNs or UIC codes, two or more', () => {
    const r = NT.nonTripRequirementOf({ tripType: 'NON_TRIP', nonTrip: { by: 'PLACES', places: ['0000040', AIRPORT], validFrom: '%TRIP_DATE%T00:00:00+01:00' } });
    expect(r.problem).toBeUndefined();
    expect(r.places).toEqual([stop('urn:uic:stn:0000040'), stop(AIRPORT)]);
    expect(r.validFrom).toBe('%TRIP_DATE%T00:00:00+01:00');
  });

  test('by is PLACES when not given; a lookup name stands in for the places', () => {
    const r = NT.nonTripRequirementOf({ nonTrip: { places: [], placeLookup: '  Simtown ' } });
    expect(r).toMatchObject({ by: 'PLACES', places: [], placeLookup: 'Simtown' });
  });

  test('refused: no nonTrip, an unknown by, one place, a place that is no stop place, nothing to look up, a zone without carrier', () => {
    for (const requirement of [
      { tripType: 'NON_TRIP' },
      { nonTrip: { by: 'NUTS' } },
      { nonTrip: { places: [CENTRAL] } },
      { nonTrip: { places: [CENTRAL, 'Simtown Airport'] } },
      { nonTrip: { places: 'AUTO' } },
      { nonTrip: { by: 'ZONES', zones: [{ id: 'SIM-CITY' }] } },
    ]) {
      expect(NT.nonTripRequirementOf(requirement).problem).toEqual(expect.any(String));
    }
  });

  test('zones given, or none (AUTO) to take one from GET /zones', () => {
    expect(NT.nonTripRequirementOf({ nonTrip: { by: 'zones', zones: [{ id: 'Z1', carrier: 'urn:c' }] } }).zones).toEqual([{ id: 'Z1', carrier: 'urn:c' }]);
    expect(NT.nonTripRequirementOf({ nonTrip: { by: 'ZONES', zones: 'AUTO' } })).toMatchObject({ by: 'ZONES', zones: [] });
  });
});

describe('the request', () => {
  test('nonTripSearchCriteria, and no trip member left', () => {
    const request = {
      tripSearchCriteria: { origin: stop(CENTRAL) }, tripIds: ['T'], requestedSections: [], anonymousPassengerSpecifications: [{ externalRef: 'P1' }],
    };
    const out = NT.nonTripOfferRequest(request, NT.nonTripCriteria({ ...PLACES, validFrom: '2026-11-20T00:00:00+01:00' }));
    expect(out).toEqual({
      anonymousPassengerSpecifications: [{ externalRef: 'P1' }],
      nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', places: [stop(CENTRAL), stop(AIRPORT)] },
    });
    expect(NT.nonTripCriteria(ZONES)).toEqual({ zones: ZONES.zones });
  });

  test('POST /places asks stop places only', () => {
    expect(NT.placeRequest('Praha')).toEqual({ placeInput: { name: 'Praha' }, restrictions: { type: 'STOP', numberOfResults: 5 } });
  });
});

describe('the lookups', () => {
  test('POST /places: the stop places are kept, another kind of place is warned and left out', () => {
    const body = { places: [
      { objectType: 'StopPlace', id: CENTRAL, name: 'Central' },
      { objectType: 'Address', id: 'urn:addr:1', name: 'Main street 1' },
      { objectType: 'StopPlace', id: AIRPORT, name: 'Airport' },
    ] };
    const r = NT.checkPlaceAnswer(200, body, 'Simtown');
    expect(r.stops.map((p) => p.id)).toEqual([CENTRAL, AIRPORT]);
    expect(failed(r.checks)).toEqual([]);
    expect(warned(r.checks)).toEqual(['POST /places: only stop places for a request of type STOP']);
  });

  test('POST /places: fewer than two stop places fails; 501 is not implemented, with no check', () => {
    expect(failed(NT.checkPlaceAnswer(200, { places: [{ objectType: 'StopPlace', id: CENTRAL, name: 'C' }] }, 'x').checks))
      .toEqual(['POST /places: at least two stop places to ask offers between']);
    expect(NT.checkPlaceAnswer(501, null, 'x')).toEqual({ checks: [], stops: [], notImplemented: true });
    expect(failed(NT.checkPlaceAnswer(500, null, 'x').checks)).toEqual(['POST /places (“x”): HTTP 200 — actual 500']);
  });

  test('GET /zones: the first zone with an id and a carrier', () => {
    const r = NT.checkZonesAnswer(200, { zones: [{ id: 'NO-CARRIER' }, { id: 'Z1', carrier: 'urn:c', name: 'Z' }] });
    expect(r.zone).toMatchObject({ id: 'Z1', carrier: 'urn:c' });
    expect(failed(r.checks)).toEqual([]);
    expect(failed(NT.checkZonesAnswer(200, { zones: [] }).checks)).toHaveLength(1);
    expect(NT.checkZonesAnswer(404, null).notImplemented).toBe(true);
  });
});

describe('the offers', () => {
  test('a right answer passes: no trip, no coverage, the validity names the places asked', () => {
    const checks = NT.checkNonTripOffers({ offers: [{ offerId: 'O1', admissionOfferParts: [admission()] }] }, PLACES, '3.8.0');
    expect(failed(checks)).toEqual([]);
    expect(warned(checks)).toEqual([]);
  });

  test('a trip, or a trip coverage, fails', () => {
    const body = { trips: [{ id: 'T1' }], offers: [{ offerId: 'O1', tripCoverage: { coveredTripId: 'T1' }, admissionOfferParts: [admission({ tripCoverage: { coveredTripId: 'T1' } })] }] };
    expect(failed(NT.checkNonTripOffers(body, PLACES, '3.8.0'))).toEqual([
      'Non-trip offers: the answer gives no trip',
      'Non-trip offers: no offer or offer part covers a trip (tripCoverage absent)',
    ]);
  });

  test('no regional validity fails; no summary is a warning', () => {
    const part = admission();
    delete part.regionalValidities;
    delete part.regionalValiditySummary;
    const checks = NT.checkNonTripOffers({ offers: [{ admissionOfferParts: [part] }] }, PLACES, '3.8.0');
    expect(failed(checks)).toEqual(['Non-trip offers: each admission says where it is valid (regionalValidities) — 1 admission']);
    expect(warned(checks)).toEqual(['Non-trip offers: each admission has a regionalValiditySummary with its description']);
  });

  test('3.6 expects the one regionalValidity; from 3.7 the deprecated member alone is a warning', () => {
    const single = admission({ regionalValidities: undefined, regionalValidity: route(CENTRAL, AIRPORT) });
    const body = { offers: [{ admissionOfferParts: [single] }] };
    const old = NT.checkNonTripOffers(body, PLACES, '3.6.0');
    expect(failed(old)).toEqual([]);
    expect(warned(old)).toEqual([]);
    expect(old[2].name).toContain('(regionalValidity)');
    expect(warned(NT.checkNonTripOffers(body, PLACES, '3.8.0'))).toEqual(['Non-trip offers: regionalValidities, not the deprecated regionalValidity (OSDM 3.7+)']);
  });

  test('a validity naming nothing fails; one leaving a place out, or a zone of another carrier, warns', () => {
    expect(failed(NT.checkNonTripOffers({ offers: [{ admissionOfferParts: [admission({ regionalValidities: [{ seqNb: 1 }] })] }] }, PLACES, '3.8.0')))
      .toEqual(['Non-trip offers: each regional validity names a zone, route, train link, line or polygon']);
    expect(warned(NT.checkNonTripOffers({ offers: [{ admissionOfferParts: [admission({ regionalValidities: [route('urn:uic:stn:40', 'urn:uic:stn:0000099')] })] }] }, PLACES, '3.8.0')))
      .toEqual(['Non-trip offers: the regional validity names every stop place asked']);
    const zone = (carrier) => admission({ regionalValidities: [{ seqNb: 1, zone: { carrier, name: 'City' } }] });
    expect(warned(NT.checkNonTripOffers({ offers: [{ admissionOfferParts: [zone('urn:x_osdm_simulator:carrier:gamma')] }] }, ZONES, '3.8.0'))).toEqual([]);
    expect(warned(NT.checkNonTripOffers({ offers: [{ admissionOfferParts: [zone('urn:other')] }] }, ZONES, '3.8.0')))
      .toEqual(['Non-trip offers: the regional validity names a zone of the carrier asked']);
  });

  test('a UIC code written without its leading zeros is the same stop place', () => {
    expect(NT.sameStopPlace('urn:uic:stn:40', CENTRAL)).toBe(true);
    expect(NT.sameStopPlace('urn:uic:stn:41', CENTRAL)).toBe(false);
  });
});

describe('the booking', () => {
  test('booked admissions keep the validity, nothing covers a trip', () => {
    const booking = { bookedOffers: [{ admissions: [{ ...admission(), objectType: 'Admission' }] }], fulfillments: [{ id: 'F1' }] };
    expect(failed(NT.checkNonTripBooking(booking, PLACES, '3.8.0', 'Confirmed'))).toEqual([]);
    const covered = { bookedOffers: [{ tripCoverage: { coveredTripId: 'T' }, admissions: [{ objectType: 'Admission' }] }] };
    expect(failed(NT.checkNonTripBooking(covered, PLACES, '3.8.0', 'Pre-booked'))).toEqual([
      'Pre-booked: non-trip booking — nothing covers a trip (tripCoverage absent)',
      'Pre-booked: non-trip booking: each admission says where it is valid (regionalValidities) — 1 admission',
    ]);
  });
});

describe('the run (01 before-request and after-response)', () => {
  const recorded = [];
  const test2 = (name, fn) => { try { fn(); recorded.push({ name, ok: true }); } catch (e) { recorded.push({ name, ok: false, message: e.message }); } };
  beforeEach(() => { recorded.length = 0; });

  test('not a non-trip sale: nothing is sent or changed', async () => {
    envStore.TripType = 'SEARCH';
    envStore.OfferCollectionRequest = '{"tripSearchCriteria":{}}';
    await NT.prepareNonTripRequest();
    expect(sent).toEqual([]);
    expect(envStore.OfferCollectionRequest).toBe('{"tripSearchCriteria":{}}');
    expect(NT.checkNonTripLookup(test2)).toBe(false);
  });

  test('stop places from POST /places, then the request without a trip', async () => {
    envStore.TripType = 'NON_TRIP';
    envStore.nonTripRequirement = JSON.stringify({ by: 'PLACES', places: [], placeLookup: 'Simtown', zones: [], validFrom: '2026-11-20T00:00:00+01:00' });
    envStore.OfferCollectionRequest = JSON.stringify({ anonymousPassengerSpecifications: [{ externalRef: 'P1' }] });
    answers.push({ status: 200, data: { places: [{ objectType: 'StopPlace', id: CENTRAL, name: 'Central' }, { objectType: 'StopPlace', id: AIRPORT, name: 'Airport' }] } });
    await NT.prepareNonTripRequest();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://provider.example/osdm/places' });
    expect(JSON.parse(sent[0].data)).toEqual(NT.placeRequest('Simtown'));
    expect(sent[0].headers.traceparent).toEqual(expect.any(String));
    expect(JSON.parse(envStore.OfferCollectionRequest).nonTripSearchCriteria).toEqual({ validFrom: '2026-11-20T00:00:00+01:00', places: [stop(CENTRAL), stop(AIRPORT)] });
    expect(NT.checkNonTripLookup(test2)).toBe(false);
    expect(recorded.every((r) => r.ok)).toBe(true);
    expect(recorded.length).toBeGreaterThan(0);
  });

  test('a zone from GET /zones; none ends the scenario with a failed check', async () => {
    envStore.TripType = 'NON_TRIP';
    envStore.nonTripRequirement = JSON.stringify({ by: 'ZONES', places: [], zones: [], validFrom: null });
    envStore.OfferCollectionRequest = '{}';
    answers.push({ status: 200, data: { zones: [{ id: 'SIM-CITY', carrier: 'urn:c', name: 'City' }] } });
    await NT.prepareNonTripRequest();
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://provider.example/osdm/zones' });
    expect(sent[0].data).toBeUndefined();
    expect(sent[0].headers['Content-Type']).toBeUndefined();
    expect(JSON.parse(envStore.OfferCollectionRequest).nonTripSearchCriteria).toEqual({ zones: [{ id: 'SIM-CITY', carrier: 'urn:c' }] });
    expect(JSON.parse(envStore.__nonTripAsked)).toMatchObject({ by: 'ZONES', zones: [{ id: 'SIM-CITY', carrier: 'urn:c' }] });

    answers.push({ status: 501, data: { code: 'NOT_IMPLEMENTED' } });
    envStore.OfferCollectionRequest = '{}';
    await NT.prepareNonTripRequest();
    expect(NT.checkNonTripLookup(test2)).toBe(true);
    expect(recorded.filter((r) => !r.ok).map((r) => r.name)).toEqual(['Non-trip offers: a zone to ask offers in']);
  });

  test('the offer and booking checks run for a non-trip sale only', () => {
    envStore.TripType = 'NON_TRIP';
    envStore.__nonTripAsked = JSON.stringify(PLACES);
    NT.recordNonTripOfferChecks({ offers: [{ admissionOfferParts: [admission()] }] }, test2);
    expect(recorded.map((r) => r.ok)).toEqual([true, true, true]);
    recorded.length = 0;
    envStore.TripType = 'SEARCH';
    NT.recordNonTripOfferChecks({ trips: [{}], offers: [] }, test2);
    NT.recordNonTripBookingChecks({}, 'Confirmed', test2);
    expect(recorded).toEqual([]);
  });
});

describe('the parser', () => {
  const { nonTripRequest } = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
  // The parser logs through the global logger, as in Bruno's sandbox.
  beforeEach(() => { global.validationLogger = (line) => { mockLogs.push(line); }; });
  afterEach(() => { delete global.validationLogger; });

  test('the requirement, its validity on the trip date in the zone of the first stop place', () => {
    // A Czech station (54…): 20 November is winter time, +01:00 as written.
    nonTripRequest({ tripType: 'NON_TRIP', nonTrip: { places: ['5457076', 'urn:uic:stn:5400014'] } }, '2026-11-20');
    expect(JSON.parse(envStore.nonTripRequirement)).toEqual({
      by: 'PLACES', places: [stop('urn:uic:stn:5457076'), stop('urn:uic:stn:5400014')], placeLookup: null, zones: [],
      validFrom: '2026-11-20T00:00:00+01:00',
    });
    // In July the zone's offset is +02:00.
    nonTripRequest({ tripType: 'NON_TRIP', nonTrip: { places: ['5457076', '5400014'], validFrom: '%TRIP_DATE%T06:00:00+01:00' } }, '2027-07-01');
    expect(JSON.parse(envStore.nonTripRequirement).validFrom).toBe('2027-07-01T06:00:00+02:00');
  });

  test('zones left to OSCAR', () => {
    nonTripRequest({ tripType: 'NON_TRIP', nonTrip: { by: 'ZONES', zones: [] } }, '2026-11-20');
    expect(JSON.parse(envStore.nonTripRequirement)).toMatchObject({ by: 'ZONES', zones: [], validFrom: '2026-11-20T00:00:00+01:00' });
  });
});
