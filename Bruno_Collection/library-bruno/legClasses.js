/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * legClasses.js — the travel class of each leg (#600).
 *
 * A scenario may name the class it expects on each leg of its trip with
 * `legTravelClasses` (in the order of the legs), for a train that has a first
 * class and one that has not. The offer request then asks for every class
 * named; the offer chosen is one that gives each leg its class, and the
 * booking must give the same.
 *
 * A leg's class is the highest class of the products that cover it, through
 * the admissions of the offer or booking. A provider may sell first class on
 * a leg in two ways, both accepted: an admission of its own in first class,
 * or a second-class admission for the whole trip and a separate supplement
 * (an upgrade product) on that leg. The form found is reported.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-leg-classes.test.js.
 */

const listOf = (value) => (Array.isArray(value) ? value : []);
const RANK = { SECOND: 1, FIRST: 2 };
const rankOf = (travelClass) => RANK[travelClass] || 0;

/**
 * The scenario's classes, one per leg: a list, or a text such as
 * "FIRST, SECOND". Upper case, without blanks; null when none is named.
 */
function normaliseLegClasses(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const classes = items.map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean);
  return classes.length > 0 ? classes : null;
}

/** The classes the offer request asks for: each class named, once, in order. */
const requestedClasses = (legClasses) => [...new Set(listOf(legClasses))];

// The leg ids of the trip an offer or booked offer covers first, in order.
function legIdsOf(holder, trips) {
  const tripId = holder?.tripCoverage?.coveredTripId || listOf(holder?.admissionOfferParts || holder?.admissions)[0]?.tripCoverage?.coveredTripId;
  const trip = listOf(trips).find((t) => t?.id === tripId);
  return listOf(trip?.legs).map((leg) => leg?.id).filter(Boolean);
}

// For each product a part names: the product and the legs it covers there.
function coverageOfPart(part, productById) {
  const refs = listOf(part?.products).filter((r) => r?.productId);
  const named = refs.length > 0 ? refs : [{ productId: part?.summaryProductId }];
  return named.map((r) => ({
    product: productById.get(r.productId),
    legIds: listOf(r.legIds).length > 0 ? r.legIds : listOf(part?.tripCoverage?.coveredLegIds),
  }));
}

/**
 * The class each leg gets: `{ legId, travelClass, form, partIds }`, where
 * `form` is "upgrade" when the leg's highest class comes from an upgrade
 * product (type UPGRADE_*) or from a part that covers fewer legs than another
 * part on it, "admission" otherwise, and null when no part covers the leg.
 */
function classesByLeg(parts, products, legIds) {
  const productById = new Map(listOf(products).filter((p) => p?.id).map((p) => [p.id, p]));
  const legs = new Map(legIds.map((id) => [id, { legId: id, travelClass: null, partIds: [], span: 0, maxSpan: 0, upgradeType: false }]));
  for (const part of listOf(parts)) {
    for (const coverage of coverageOfPart(part, productById)) applyCoverage(legs, part.id, coverage);
  }
  return [...legs.values()].map((leg) => ({
    legId: leg.legId,
    travelClass: leg.travelClass,
    form: formOf(leg),
    partIds: [...new Set(leg.partIds)],
  }));
}

// One product of one part on the legs it covers: the leg keeps its highest
// class, and how wide the part giving it is.
function applyCoverage(legs, partId, { product, legIds: covered }) {
  const travelClass = product?.travelClass ?? null;
  for (const leg of covered.map((id) => legs.get(id)).filter(Boolean)) {
    leg.partIds.push(partId);
    leg.maxSpan = Math.max(leg.maxSpan, covered.length);
    if (rankOf(travelClass) > rankOf(leg.travelClass)) {
      leg.travelClass = travelClass;
      leg.span = covered.length;
      leg.upgradeType = String(product.type ?? '').startsWith('UPGRADE');
    }
  }
}

function formOf(leg) {
  if (!leg.travelClass) return null;
  const narrower = leg.span < leg.maxSpan;
  return leg.upgradeType || narrower ? 'upgrade' : 'admission';
}

const describe = (legs) => legs.map((l) => l.travelClass || 'none').join(', ');

/** Whether an offer gives each leg of its trip the class the scenario names. */
function offerMatches(offer, trips, expected) {
  const legs = classesByLeg(offer?.admissionOfferParts, offer?.products, legIdsOf(offer, trips));
  return legs.length === expected.length && legs.every((leg, i) => leg.travelClass === expected[i]);
}

/** Each distinct combination of classes the offers give their legs: "[FIRST, SECOND] (2 offers)". */
function offeredCombinations(offers, trips) {
  const counts = new Map();
  for (const offer of listOf(offers)) {
    const key = `[${describe(classesByLeg(offer?.admissionOfferParts, offer?.products, legIdsOf(offer, trips)))}]`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key} (${n} offer${n > 1 ? 's' : ''})`);
}

/**
 * The checks that each leg has the expected class, for an offer
 * (`admissionOfferParts`) or a booked offer (`admissions`): one per leg,
 * naming how the class was given; one failure when the leg count differs.
 * @returns {Array<{name: string, ok: boolean, message?: string}>}
 */
function checkLegClasses(label, holder, trips, expected) {
  const parts = holder?.admissionOfferParts || holder?.admissions;
  const legs = classesByLeg(parts, holder?.products, legIdsOf(holder, trips));
  if (legs.length !== expected.length) {
    return [{ name: `${label}: one class per leg`, ok: false, message: `the trip has ${legs.length} leg(s), the scenario names ${expected.length} class(es): [${expected.join(', ')}]` }];
  }
  return legs.map((leg, i) => {
    const how = leg.form === 'upgrade' ? 'with a supplement on this leg' : 'by its admission';
    const found = leg.travelClass ? leg.travelClass + ', ' + how : 'no class';
    return {
      name: `${label}: leg ${i + 1} (${leg.legId}) in ${expected[i]} class — ${found}`,
      ok: leg.travelClass === expected[i],
      message: leg.travelClass === expected[i] ? undefined : `got ${leg.travelClass || 'no part covering the leg'}`,
    };
  });
}

module.exports = { normaliseLegClasses, requestedClasses, classesByLeg, offerMatches, offeredCombinations, checkLegClasses, legIdsOf };
