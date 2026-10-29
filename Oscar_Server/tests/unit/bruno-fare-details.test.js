'use strict';

/**
 * bruno-fare-details.test.js — what a fare says of its passengers, cards,
 * class, dates and coverage (#1045): checks O16 to O20, and O8 reading a
 * fare's coverage from its route or its offer as a real provider gives it.
 */

const path = require('path');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const details = require('../../../Bruno_Collection/library-bruno/fareDetails.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const providers = loadProviders(path.join(__dirname, '..', '..', '..', 'OSDM_Simulator', 'providers'));
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const stopPlace = (code) => ({ objectType: 'StopPlace', id: `urn:uic:stn:${code}`, name: `Station ${code}` });
const ADULT = { externalRef: 'a1', type: 'PERSON', dateOfBirth: '1990-01-15' };

function request({ from = '0000004', classes = null, passengers = [ADULT] } = {}) {
  return {
    tripSpecifications: [{
      isPartOfInternationalTrip: true,
      legs: [{ timedLeg: {
        start: { stopPlaceRef: station(from), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
        end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
        service: { vehicleNumbers: ['1001'] },
      } }],
    }],
    requestedSections: [{ startPlace: station(from), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'], ...(classes ? { travelClasses: classes } : {}) },
    anonymousPassengerSpecifications: passengers,
  };
}
const failing = (body, req) => fares.fareChecks(body, req, { travelDay: '2026-11-20' }).filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort();

// A fare as a real provider gave one: no covered section, no connection point.
function realForm(route, offerExtra = {}) {
  return {
    trips: [{ id: 't1', legs: [{ id: '0', timedLeg: {} }, { id: '1', transferLeg: {} }, { id: '2', timedLeg: {} }] }],
    offers: [{
      offerId: 'o1',
      passengerRefs: ['a1'],
      ...offerExtra,
      fares: [{
        id: 'f1', type: 'ADMISSION', prices: [{ amount: 10000, currency: 'EUR', scale: 2 }], travelClass: 'SECOND',
        regionalConstraint: { regionalValidities: [{ seqNb: 0, route }], distance: 0 },
        afterSalesCondition: { conditions: [{ condition: 'REFUND' }], isProviderFee: true },
        combinationConstraint: [{ model: 'CLUSTERING', referenceCluster: 'FULL_FLEX', allowedClusters: ['NON_FLEX', 'SEMI_FLEX', 'FULL_FLEX'] }],
        travelValidityConstraint: { validityRange: { timeUnit: 'DAYS', value: 1, hoursAfterMidnight: 5 }, validTravelDates: { from: '2026-11-20T00:00:00+01:00', until: '2026-11-21T05:00:00+01:00', utcOffset: -60 }, validityType: 'SINGLE_TRIP' },
        passengerRefs: ['a1'],
        involvedTCOs: ['c1'],
      }],
    }],
  };
}

describe('O8 reads what a fare covers from its route or its offer (#1045)', () => {
  test('a route given as a bare list of stations, as a real provider gives it', () => {
    const body = realForm({ routeItem: null, routeItemList: [{ station: stopPlace('0000004') }, { station: stopPlace('0000002') }] });
    expect(failing(body, request())).toEqual([]);
    expect(fares.coverageOfPassenger(body.offers[0].fares, { start: 'urn:uic:stn:0000004', end: 'urn:uic:stn:0000002' }, (f) => null)).toBe('unknown');
  });

  test('a route item naming its parts by index, a station set at an end, alternatives inside', () => {
    const route = {
      routeItem: { routeItemIndices: [3, 2, 4] },
      routeItemList: [
        { station: stopPlace('0000005') },
        { station: stopPlace('0000006') },
        { alternativeRouteItemIndices: [0, 1] },
        { fareReferenceStation: { name: 'Set', code: '1', carrier: 'c', stations: [station('0000004'), station('0000009')] } },
        { routeItemIndices: [1, 5] },
        { station: stopPlace('0000002') },
      ],
    };
    expect(failing(realForm(route), request())).toEqual([]);
    // A route that ends elsewhere leaves a gap.
    route.routeItemList[5] = { station: stopPlace('0000007') };
    expect(failing(realForm(route), request())).toEqual(['O8 FAIL']);
  });

  test('else the offer\'s covered sections: the first section\'s start, the last one\'s end', () => {
    const coverage = { tripCoverage: { coveredTripId: 't1', coveredSections: [
      { startPlace: station('0000004'), endPlace: station('0000003'), startLegId: '0', endLegId: '0' },
      { startPlace: station('0000003'), endPlace: station('0000002'), startLegId: '2', endLegId: '2' },
    ] } };
    expect(failing(realForm({ routeSummary: 'A - B' }, coverage), request())).toEqual([]);
    expect(failing(realForm({ routeSummary: 'A - B' }), request())).toEqual(['O8 WARNING']);
  });
});

describe('O16 to O20 on hand-made fares', () => {
  const one = (change, req = request()) => {
    const body = realForm({ routeItem: null, routeItemList: [{ station: stopPlace('0000004') }, { station: stopPlace('0000002') }] });
    change(body.offers[0].fares[0], body);
    return failing(body, req);
  };

  test('O16: a card required that the passenger holds is fine; one no passenger holds, or an empty list, warns', () => {
    const card = { type: 'REDUCTION_CARD', code: 'C25', issuer: 'i1' };
    const holder = request({ passengers: [{ ...ADULT, cards: [{ type: 'REDUCTION_CARD', code: 'C25', issuer: 'i1' }] }] });
    expect(one((f) => { f.requiredCards = [card]; }, holder)).toEqual([]);
    expect(one((f) => { f.requiredCards = [card]; })).toEqual(['O16 WARNING']);
    expect(one((f) => { f.requiredCards = [{ ...card, issuer: 'other' }]; }, holder)).toEqual(['O16 WARNING']);
    expect(one((f) => { f.requiredCards = []; })).toEqual(['O16 WARNING']);
  });

  test('O17: the passenger\'s age on the travel day within the fare\'s passenger constraints', () => {
    expect(one((f) => { f.passengerConstraints = [{ number: 1, lowerAgeLimit: 15, upperAgeLimit: 150 }]; })).toEqual([]);
    expect(one((f) => { f.passengerConstraints = [{ number: 1, lowerAgeLimit: 6, upperAgeLimit: 14 }]; })).toEqual(['O17 WARNING']);
    expect(details.ageOn({ dateOfBirth: '2010-11-21' }, '2026-11-20')).toBe(15);
    expect(details.ageOn({ dateOfBirth: '2010-11-20' }, '2026-11-20')).toBe(16);
    expect(details.ageOn({ age: 30 }, '2026-11-20')).toBe(30);
    expect(details.ageOn({}, '2026-11-20')).toBeNull();
    // An unknown age checks nothing.
    expect(one((f) => { f.passengerConstraints = [{ lowerAgeLimit: 6, upperAgeLimit: 14 }]; }, request({ passengers: [{ externalRef: 'a1', type: 'PERSON' }] }))).toEqual([]);
  });

  test('O18: a fare offer in each class asked; a bicycle in second class does not count against first', () => {
    expect(one(() => {}, request({ classes: ['SECOND'] }))).toEqual([]);
    expect(one(() => {}, request({ classes: ['FIRST'] }))).toEqual(['O18 WARNING']);
    expect(details.classIssues({ offers: [{ fares: [{ travelClass: 'FIRST', passengerRefs: ['a1'] }, { travelClass: 'SECOND', passengerRefs: ['b1'] }] }] },
      request({ classes: ['FIRST'], passengers: [ADULT, { externalRef: 'b1', type: 'BICYCLE' }] }))).toEqual([]);
  });

  test('O19: utcOffset is the minutes added to get UTC: -60 for dates at +01:00', () => {
    expect(one((f) => { f.travelValidityConstraint.validTravelDates.utcOffset = 0; })).toEqual(['O19 WARNING']);
    expect(one((f) => { f.travelValidityConstraint.validTravelDates = { from: '2026-11-20T00:00:00Z', until: '2026-11-22T00:00:00Z', utcOffset: 0 }; })).toEqual([]);
    expect(one((f) => { f.travelValidityConstraint.validTravelDates = { from: '2026-11-20T00:00:00', utcOffset: 0 }; })).toEqual([]);
    expect([details.offsetOf('2026-11-20T00:00:00-05:30'), details.offsetOf('x')]).toEqual([-330, null]);
  });

  test('O20: an offer\'s covered sections on legs of its trip that are trains', () => {
    const sections = (startLegId, endLegId, tripId = 't1') => (f, body) => {
      body.offers[0].tripCoverage = { coveredTripId: tripId, coveredSections: [{ startPlace: station('0000004'), endPlace: station('0000002'), startLegId, endLegId }] };
    };
    expect(one(sections('0', '2'))).toEqual([]);
    expect(one(sections('0', '1'))).toEqual(['O20 WARNING']);
    expect(one(sections('0', '9'))).toEqual(['O20 WARNING']);
    expect(one(sections('0', '2', 'other'))).toEqual(['O20 WARNING']);
    // A section naming no leg, and an offer without fares, are not read.
    expect(one(sections(undefined, '2'))).toEqual([]);
    expect(details.offerCoverageIssues({
      trips: [{ id: 't1', legs: [{ id: '0', transferLeg: {} }] }],
      offers: [{ products: [{}], tripCoverage: { coveredTripId: 't1', coveredSections: [{ startLegId: '0', endLegId: '0' }] } }],
    })).toEqual([]);
    expect(details.offerCoverageIssues({ trips: [{ id: 't1', legs: [{ id: '0', continuousLeg: {} }] }],
      offers: [{ fares: [{}], tripCoverage: { coveredTripId: 't1', coveredSections: [{ startLegId: '0' }] } }] }))
      .toEqual(['offers[0].tripCoverage.coveredSections[0].startLegId = "0", a continuous leg']);
  });
});

describe('the simulator\'s variants each break one of them', () => {
  const answer = (req) => buildOfferCollection(req, providers.get('gamma'), NOW).response;
  test.each([
    ['0000004', null, []],
    ['0000060', null, []],
    ['0000061', null, ['O16 WARNING']],
    ['0000062', null, ['O17 WARNING']],
    ['0000063', ['FIRST'], ['O18 WARNING']],
    ['0000064', null, ['O19 WARNING']],
    ['0000065', null, ['O20 WARNING']],
  ])('section from %s', (from, classes, expected) => {
    const req = request({ from, classes });
    expect(failing(answer(req), req)).toEqual(expected);
  });

  test('the real answer\'s form names no covered section and no connection point; its offer covers the section', () => {
    const body = answer(request({ from: '0000060' }));
    for (const offer of body.offers) {
      for (const fare of offer.fares) {
        expect(fare.coveredSection).toBeUndefined();
        expect(fare.regionalConstraint.entryConnectionPoint).toBeUndefined();
      }
      expect(offer.tripCoverage.coveredSections[0].startPlace).toEqual(station('0000060'));
    }
  });
});
