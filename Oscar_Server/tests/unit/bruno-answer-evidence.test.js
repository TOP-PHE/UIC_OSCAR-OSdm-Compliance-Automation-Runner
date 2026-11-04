'use strict';

/**
 * bruno-answer-evidence.test.js — the answer OSCAR stores is the provider's
 * (#1045). Bruno stores a response object after the scripts ran; the fare
 * checks of step 01 set `offers` on the object they read, and step 10 set
 * `refundOffers`, so the stored answer showed OSCAR's edit (an analysis read
 * "offers": [] where the provider had sent fares). The steps now hand their
 * checks a copy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
const { workingCopy } = require(path.join(ROOT, 'library-bruno', 'envUtils.js'));
const fares = require(path.join(ROOT, 'library-bruno', 'fares.js'));

describe('workingCopy', () => {
  test('a JSON object is copied one level deep; anything else is itself', () => {
    const answer = { offers: [{ id: 'o1' }], trips: [] };
    const copy = workingCopy(answer);
    expect(copy).toEqual(answer);
    expect(copy).not.toBe(answer);
    expect(copy.offers).toBe(answer.offers);
    for (const other of [null, undefined, 'text', 7, [1, 2]]) expect(workingCopy(other)).toBe(other);
  });

  test('what a check sets on the copy leaves the answer as it came', () => {
    const fareOnly = { offerId: 'f1', fares: [{ id: 'F1', type: 'ADMISSION' }] };
    const product = { offerId: 'p1', admissionOfferParts: [{ id: 'A1' }] };
    const answer = { offers: [fareOnly, product] };
    const copy = workingCopy(answer);
    copy.offers = fares.productOffersOf(copy);
    expect(copy.offers.map((o) => o.offerId)).toEqual(['p1']);
    expect(answer.offers.map((o) => o.offerId)).toEqual(['f1', 'p1']);
  });
});

describe('the steps that set members on their answer read a copy', () => {
  const step = (folder, file) => fs.readFileSync(path.join(ROOT, folder, file), 'utf8');

  test('01. POST Get Offer: the answer the fare and product checks read', () => {
    const text = step('02-Common Requests', '01. POST Get Offer.yml');
    expect(text).toContain('jsonData = require(bru.getEnvVar("library_base") + "envUtils.js").workingCopy(res.getBody());');
    expect(text).not.toMatch(/jsonData = res\.getBody\(\);/);
  });

  test('10. POST Refund Offers: the answer whose refundOffers the step normalises', () => {
    const text = step('03-Refund', '10. POST Refund Offers.yml');
    expect(text).toContain('require(bru.getEnvVar("library_base") + "envUtils.js").workingCopy(res.getBody())');
  });
});
