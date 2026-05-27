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
