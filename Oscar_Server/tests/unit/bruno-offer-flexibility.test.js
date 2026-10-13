'use strict';

/**
 * bruno-offer-flexibility.test.js — #223.
 *
 * Covers the offer-flexibility helpers in offers.js: an offer's overall
 * flexibility is the offerSummary.overallFlexibility when present (OPTIONAL in
 * OSDM), otherwise the MOST RESTRICTIVE of its products' flexibilities (a
 * journey is only as flexible as its least-flexible leg, e.g. TGV FULL + TER
 * NON_FLEXIBLE -> NON_FLEXIBLE).
 */

// Stub the Bruno globals some library modules expect at load time.
global.bru = { getEnvVar: () => undefined, setEnvVar: () => {} };
global.validationLogger = () => {};

const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

describe('deriveOfferFlexibilityFromProducts', () => {
  test('single product → its own flexibility', () => {
    expect(offers.deriveOfferFlexibilityFromProducts({ products: [{ flexibility: 'FULL_FLEXIBLE' }] }))
      .toBe('FULL_FLEXIBLE');
  });

  test('mixed legs → most restrictive (TGV FULL + TER NON_FLEXIBLE → NON_FLEXIBLE)', () => {
    expect(offers.deriveOfferFlexibilityFromProducts({
      products: [{ flexibility: 'FULL_FLEXIBLE' }, { flexibility: 'NON_FLEXIBLE' }],
    })).toBe('NON_FLEXIBLE');
  });

  test('FULL + SEMI → SEMI_FLEXIBLE', () => {
    expect(offers.deriveOfferFlexibilityFromProducts({
      products: [{ flexibility: 'FULL_FLEXIBLE' }, { flexibility: 'SEMI_FLEXIBLE' }],
    })).toBe('SEMI_FLEXIBLE');
  });

  test('unknown/vendor flexibility values are ignored', () => {
    expect(offers.deriveOfferFlexibilityFromProducts({
      products: [{ flexibility: 'PROMO' }, { flexibility: 'FULL_FLEXIBLE' }],
    })).toBe('FULL_FLEXIBLE');
  });

  test('no products → undefined', () => {
    expect(offers.deriveOfferFlexibilityFromProducts({ products: [] })).toBeUndefined();
    expect(offers.deriveOfferFlexibilityFromProducts({})).toBeUndefined();
  });
});

describe('offerFlexibility', () => {
  test('uses offerSummary.overallFlexibility when present', () => {
    expect(offers.offerFlexibility({
      offerSummary: { overallFlexibility: 'SEMI_FLEXIBLE' },
      products: [{ flexibility: 'FULL_FLEXIBLE' }],
    })).toBe('SEMI_FLEXIBLE');
  });

  test('falls back to most-restrictive product when offerSummary is absent', () => {
    expect(offers.offerFlexibility({
      products: [{ flexibility: 'FULL_FLEXIBLE' }, { flexibility: 'NON_FLEXIBLE' }],
    })).toBe('NON_FLEXIBLE');
  });

  test('undefined when neither offerSummary nor product flexibility is available', () => {
    expect(offers.offerFlexibility({ products: [] })).toBeUndefined();
  });
});

describe('#709 legs that are not timed legs', () => {
  test('a transfer or continuous leg gives its kind and its start and end stop places', () => {
    const at = (ref) => ({ objectType: 'StopPlaceRef', stopPlaceRef: ref });
    expect(offers.otherLegOf({ id: '1', timedLeg: null, transferLeg: { start: at('urn:uic:stn:8502113'), end: at('urn:uic:stn:8502113') } }))
      .toEqual({ kind: 'transfer', from: 'urn:uic:stn:8502113', to: 'urn:uic:stn:8502113' });
    expect(offers.otherLegOf({ continuousLeg: { start: { name: 'A' }, end: {} } })).toEqual({ kind: 'continuous', from: 'A', to: undefined });
  });

  test('a timed leg, or a leg of no known kind, is checked as before', () => {
    expect(offers.otherLegOf({ timedLeg: { start: {} }, transferLeg: { start: {} } })).toBeNull();
    expect(offers.otherLegOf({ id: '1' })).toBeNull();
    expect(offers.otherLegOf(null)).toBeNull();
  });

  test('validateTripsAndLegs checks a transfer leg for its start and end, not for a train', () => {
    const recorded = [];
    const jestTest = global.test;
    global.test = (name, body) => { try { body(); recorded.push([name, 'pass']); } catch (e) { recorded.push([name, 'fail']); } };
    const jestExpect = global.expect;
    global.expect = require('../helpers/bruno-chai.js').chaiExpect;
    const timed = { timedLeg: { service: { vehicleNumbers: ['IC 1'] }, start: { stopPlaceName: 'A' }, end: { stopPlaceName: 'B' } } };
    const walk = { transferLeg: { start: { stopPlaceRef: 'urn:uic:stn:2' }, end: { stopPlaceRef: 'urn:uic:stn:2' } } };
    try {
      offers.validateTripsAndLegs({ trips: [{ id: 't', legs: [timed, walk, timed] }] });
    } finally { global.test = jestTest; global.expect = jestExpect; }
    const legs = recorded.filter(([name]) => / Leg /.test(name));
    expect(legs).toEqual([
      ['Trip 1 Leg 1 has TrainID, Origin & Destination - TrainID: IC 1, Origin: A, Destination: B', 'pass'],
      ['Trip 1 Leg 2 is a transfer leg with a start and an end - urn:uic:stn:2 → urn:uic:stn:2', 'pass'],
      ['Trip 1 Leg 3 has TrainID, Origin & Destination - TrainID: IC 1, Origin: A, Destination: B', 'pass'],
    ]);
  });
});
