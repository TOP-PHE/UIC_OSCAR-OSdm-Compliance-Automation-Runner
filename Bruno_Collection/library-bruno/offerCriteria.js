/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * offerCriteria.js — do the offers keep to the offerSearchCriteria asked? (#780)
 *
 * One check per option the request carried: offerMode, requestedOfferParts,
 * flexibilities, travelClasses, serviceClassTypes, productTags, and one per
 * productSelections entry. None is a
 * failure: OSDM says of the classes that "the classes returned might be
 * different from the requested classes", and requires no provider to filter
 * on the other options either. No offer keeping to the option is a WARNING
 * (`level: 'warn'`); some offers not keeping to it is INFO (`level: 'info'`).
 * An option the provider says it ignored (PARAMETER_NOT_SUPPORTED) is a
 * warning saying so. Each check names its `parameter` and whether the answer
 * `said` it was not taken: `unsaidCheck()` gives one more WARNING listing the
 * parameters no offer kept to that the answer does not name (#1035).
 *
 * The offer mode is read on the admissions, the flexibility and classes on
 * the products of the admissions: a
 * reservation sold with a fully flexible admission is itself often
 * NON_FLEXIBLE, and says nothing of the tariff asked.
 *
 * Pure module: no Bruno globals.
 */

// requestedOfferParts → the offer's list of that kind. FARE_* are fares, not
// offer parts, and ALL asks for everything: neither is checked.
const PART_LISTS = Object.freeze({
  ADMISSION: 'admissionOfferParts',
  RESERVATION: 'reservationOfferParts',
  ANCILLARY: 'ancillaryOfferParts',
  CONTINUOUS_SERVICE: 'continuousServiceOfferParts',
});

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
const parts = (offer, list) => (Array.isArray(offer?.[list]) ? offer[list].filter(Boolean) : []);

/** The options the request carried, as lists; empty lists are not asked. */
function askedOptions(criteria) {
  const c = criteria && typeof criteria === 'object' ? criteria : {};
  const mode = typeof c.offerMode === 'string' ? c.offerMode.trim() : '';
  return {
    offerMode: mode ? [mode] : [],
    requestedOfferParts: asList(c.requestedOfferParts).filter((p) => PART_LISTS[p]),
    flexibilities: asList(c.flexibilities),
    travelClasses: asList(c.travelClasses).filter((x) => x !== 'ANY_CLASS'),
    serviceClassTypes: asList(c.serviceClassTypes).filter((x) => x !== 'ANY_CLASS'),
    productTags: asList(c.productTags),
  };
}

// The products of an offer its admissions name (3.8 `products[].productId`,
// earlier `summaryProductId`); all its products when none can be found.
function admissionProducts(offer) {
  const products = Array.isArray(offer?.products) ? offer.products.filter((p) => p && typeof p === 'object') : [];
  const ids = new Set(parts(offer, 'admissionOfferParts').flatMap((part) => [
    part.summaryProductId,
    ...(Array.isArray(part.products) ? part.products.map((ref) => ref?.productId) : []),
  ]).filter(Boolean));
  const named = products.filter((p) => ids.has(p.id));
  return named.length ? named : products;
}

// The values an offer gives for one option, [] when it says nothing.
const VALUES_OF = {
  offerMode: (offer) => parts(offer, 'admissionOfferParts').map((p) => p.offerMode).filter(Boolean),
  requestedOfferParts: (offer) => Object.entries(PART_LISTS).filter(([, list]) => parts(offer, list).length > 0).map(([kind]) => kind),
  flexibilities: (offer) => admissionProducts(offer).map((p) => p.flexibility).filter(Boolean),
  travelClasses: (offer) => admissionProducts(offer).map((p) => p.travelClass).filter(Boolean),
  serviceClassTypes: (offer) => admissionProducts(offer).map((p) => p.serviceClass?.type).filter(Boolean),
};

const LABEL = Object.freeze({
  offerMode: 'offer mode',
  requestedOfferParts: 'offer parts',
  flexibilities: 'flexibilities',
  travelClasses: 'travel classes',
  serviceClassTypes: 'service classes',
  productTags: 'product tags',
});

// An offer keeps to the option when every value it gives is one asked; an
// offer that gives none is not counted against it. Product tags: one of its
// products carries a tag asked, or is of a type asked (OSDM: "all product
// types can be used as Product Tags").
function keeps(option, offer, asked) {
  if (option === 'productTags') {
    const products = Array.isArray(offer?.products) ? offer.products.filter(Boolean) : [];
    return products.some((p) => asked.includes(p.type) || asList(p.productTags).some((tag) => asked.includes(tag)));
  }
  const given = VALUES_OF[option](offer);
  // A reservation or ancillary sold with an admission belongs to that sale
  // (a mandatory reservation, an IRT): asking for admissions keeps it.
  if (option === 'requestedOfferParts' && asked.includes('ADMISSION') && given.includes('ADMISSION')) {
    return given.every((v) => asked.includes(v) || v === 'RESERVATION' || v === 'ANCILLARY');
  }
  return given.every((v) => asked.includes(v));
}

const offerName = (offer, i) => (offer?.offerId ? `offer ${offer.offerId}` : `offer ${i + 1}`);

/**
 * The checks of an offer answer against the criteria asked.
 * @param {object} criteria  the request's offerSearchCriteria
 * @param {object} response  the OfferCollectionResponse
 * @param {string[]} ignored the members the answer says were ignored, lower-cased
 * @returns {Array<{name, ok, level: 'warn'|'info', message}>}
 */
function checkOfferCriteria(criteria, response, ignored = []) {
  const offers = Array.isArray(response?.offers) ? response.offers.filter(Boolean) : [];
  if (offers.length === 0) return [];
  const asked = askedOptions(criteria);
  const checks = [];
  for (const option of Object.keys(LABEL)) {
    const values = asked[option];
    if (!values.length) continue;
    const name = `Offer request: the offers keep to the ${LABEL[option]} asked (${values.join(', ')})`;
    const parameter = `offerSearchCriteria.${option}`;
    if (ignored.includes(option.toLowerCase())) {
      checks.push({ name, parameter, said: true, ok: false, level: 'warn', message: `the provider says it ignored offerSearchCriteria.${option} (PARAMETER_NOT_SUPPORTED): not supported` });
      continue;
    }
    const off = offers.map((offer, i) => ({ offer, i })).filter(({ offer }) => !keeps(option, offer, values));
    const shown = off.slice(0, 3).map(({ offer, i }) => {
      const given = option === 'productTags' ? 'no product tagged so' : [...new Set(VALUES_OF[option](offer))].join(', ');
      return `${offerName(offer, i)}: ${given}`;
    }).join('; ');
    // None keeps to it: the option made no difference (WARNING). Some do: the
    // answer holds other offers too, which OSDM does not forbid (INFO).
    checks.push({
      name, parameter, said: false, ok: off.length === 0, level: off.length === offers.length ? 'warn' : 'info',
      message: `${off.length} of ${offers.length} offer(s) do not (${shown}${off.length > 3 ? '; …' : ''})`,
    });
  }
  return checks.concat(selectionChecks(criteria, offers, ignored));
}

// #780 PR A: one productSelections entry as text, null when it names nothing.
function selectionOf(s) {
  const code = typeof s?.productCode === 'string' ? s.productCode.trim() : '';
  if (code) return { code, text: `product code ${code}` };
  const tag = typeof s?.productTag === 'string' ? s.productTag.trim() : '';
  return tag ? { tag, text: `product tag ${tag}` } : null;
}

const holdsSelection = (offer, sel) => (Array.isArray(offer?.products) ? offer.products.filter(Boolean) : []).some((p) => (sel.code
  ? p.code === sel.code
  : p.type === sel.tag || asList(p.productTags).includes(sel.tag)));

/**
 * #780 PR A: productSelections asks for products to be offered. One check per
 * selection: some offer holds the product (by its code, or a product of the
 * tag). None is a WARNING, as for the other options; the member said ignored
 * is a WARNING too.
 */
function selectionChecks(criteria, offers, ignored) {
  const list = Array.isArray(criteria?.productSelections) ? criteria.productSelections : [];
  const selections = list.map(selectionOf).filter(Boolean);
  return selections.map((sel) => {
    const name = `Offer request: an offer holds the product selected (${sel.text})`;
    const parameter = 'offerSearchCriteria.productSelections';
    if (ignored.includes('productselections')) {
      return { name, parameter, said: true, ok: false, level: 'warn', message: 'the provider says it ignored offerSearchCriteria.productSelections (PARAMETER_NOT_SUPPORTED): not supported' };
    }
    const ok = offers.some((offer) => holdsSelection(offer, sel));
    return { name, parameter, said: false, ok, level: 'warn', message: ok ? '' : `none of the ${offers.length} offer(s) holds it` };
  });
}

/**
 * #1035: the parameters no offer kept to that the answer does not name as not
 * taken. A provider that does not take a parameter says so (OSDM: a
 * PARAMETER_NOT_SUPPORTED warning naming it); one WARNING lists them all,
 * besides the warning of each. Null when there are none.
 */
function unsaidCheck(checks) {
  const unsaid = (Array.isArray(checks) ? checks : [])
    .filter((c) => c && !c.ok && c.level === 'warn' && c.said === false && typeof c.parameter === 'string');
  if (unsaid.length === 0) return null;
  return {
    name: 'Offer request: the answer names the parameters it did not take (PARAMETER_NOT_SUPPORTED)',
    ok: false,
    level: 'warn',
    message: `kept by no offer or trip, and not named in the answer: ${[...new Set(unsaid.map((c) => c.parameter))].join(', ')}`,
  };
}

module.exports = { PART_LISTS, askedOptions, admissionProducts, checkOfferCriteria, unsaidCheck };
