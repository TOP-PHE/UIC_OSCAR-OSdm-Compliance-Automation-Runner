// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * productSelection.js — offers asked by product tag or product code (#780).
 *
 * `offerSearchCriteria.productTags` and `productSelections` (a productCode or a
 * productTag each) narrow the offers to those holding such a product. The
 * simulator tags its products by type: an admission ADMISSION_POINT2POINT, a
 * first-class upgrade UPGRADE_POINT2POINT, a seat reservation RESERVATION. The
 * tags are written on the products of an answer to such a request only, so no
 * other answer changes.
 *
 * Asked only for what it does not sell (another tag, an unknown code), the
 * simulator answers as usual and says the member was ignored
 * (PARAMETER_NOT_SUPPORTED), as it does for requestedOfferParts.
 */

const TAG_OF_TYPE = Object.freeze({
  ADMISSION: 'ADMISSION_POINT2POINT',
  UPGRADE_POINT2POINT: 'UPGRADE_POINT2POINT',
  RESERVATION: 'RESERVATION',
});
const TAGS = Object.values(TAG_OF_TYPE);
const MAX_ASKED = 20;

const text = (v) => (typeof v === 'string' && v.trim() !== '' && v.length <= 60 ? v.trim() : null);

/** The tags and product codes a request asks, null when it asks none. */
function productsAsked(criteria) {
  const tags = Array.isArray(criteria?.productTags) ? criteria.productTags.slice(0, MAX_ASKED).map(text).filter(Boolean) : [];
  const selectionTags = [];
  const codes = [];
  const selections = Array.isArray(criteria?.productSelections) ? criteria.productSelections.slice(0, MAX_ASKED) : [];
  for (const s of selections) {
    if (text(s?.productCode)) codes.push(text(s.productCode));
    else if (text(s?.productTag)) selectionTags.push(text(s.productTag));
  }
  if (!tags.length && !selectionTags.length && !codes.length) return null;
  return { tags, selectionTags, codes };
}

const tagOf = (product) => TAG_OF_TYPE[product?.type];

function holds(offer, tags, codes) {
  return (offer.products || []).some((p) => tags.includes(tagOf(p)) || codes.includes(p.code));
}

function ignored(member, asked) {
  return {
    code: 'PARAMETER_NOT_SUPPORTED',
    title: `Parameter 'offerSearchCriteria.${member}' was ignored.`,
    detail: `No product is sold for ${asked.join(', ')}; offers are given as without it.`,
    pointers: [{ requestPointer: `/offerSearchCriteria/${member}` }],
  };
}

/**
 * The offers kept for the products asked, and the problems to answer with.
 * The offers' products carry their tag when anything was asked.
 */
function selectProducts(criteria, offers) {
  const asked = productsAsked(criteria);
  if (!asked) return { offers, problems: [] };
  const tagged = offers.map((offer) => ({
    ...offer,
    products: (offer.products || []).map((p) => (tagOf(p) ? { ...p, productTags: [tagOf(p)] } : p)),
  }));
  const problems = [];
  const sold = (codes) => codes.filter((c) => offers.some((o) => holds(o, [], [c])));
  const tags = asked.tags.filter((t) => TAGS.includes(t));
  if (asked.tags.length && !tags.length) problems.push(ignored('productTags', asked.tags));
  const selectionTags = asked.selectionTags.filter((t) => TAGS.includes(t));
  const codes = sold(asked.codes);
  const selections = [...asked.codes, ...asked.selectionTags];
  if (selections.length && !selectionTags.length && !codes.length) problems.push(ignored('productSelections', selections));
  const wantedTags = [...tags, ...selectionTags];
  if (!wantedTags.length && !codes.length) return { offers: tagged, problems };
  return { offers: tagged.filter((o) => holds(o, wantedTags, codes)), problems };
}

module.exports = { TAG_OF_TYPE, productsAsked, selectProducts };
