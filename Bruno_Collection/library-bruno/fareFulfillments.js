/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fareFulfillments.js — which fares a fulfilment holds (#1208, #1215).
 *
 * A fulfilment links to a fare through `Fulfillment.bookingParts[].id`
 * (OSDM experts, UnionInternationalCheminsdeFer/OSDM#1699, 2026-11-13: the
 * description says so from a new version, with no backport; a fare is a
 * booking part in OSDM 4). The link is usually not needed, a fare fulfilment
 * being usually empty, so a fare fulfilment naming no fare is right too. What
 * says which fares a fulfilment holds:
 *
 *   1. the fares it names in `bookingParts` (one provider gives one
 *      fulfilment per fare, naming it);
 *   2. from OSDM 3.11, its `billingReferences`: a fare whose `accountingRef`
 *      has the same accounting company and an accounting id in common;
 *   3. the fares named by neither: those of the fare fulfilment that names no
 *      fare, or shared by several such fulfilments (which fare each one holds
 *      is then not said).
 *
 * A fare fulfilment names a fare, carries billing references, or names no
 * product booking part (OSDM processes: a fulfilment covers fares or product
 * booking parts, never both). Pure: no Bruno globals.
 */

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The ids a fulfilment names in `bookingParts`. */
const namedIdsOf = (fulfillment) => list(fulfillment?.bookingParts).map((p) => p?.id).filter((id) => typeof id === 'string' && id !== '');

const accountingIdsOf = (ref) => list(ref?.accountingIds).map(String);

/** Does a billing reference name this fare: the same accounting company and an accounting id in common? */
function billsFare(reference, fare) {
  const own = fare?.accountingRef;
  const ref = reference?.accountingRef;
  if (!isObject(own) || !isObject(ref) || !own.accountingCompany || own.accountingCompany !== ref.accountingCompany) return false;
  const ids = new Set(accountingIdsOf(own));
  return accountingIdsOf(ref).some((id) => ids.has(id));
}

/**
 * Is this a fulfilment of fares? `fareIds` are the booking's fare parts (its
 * fares and fare reservations), `productIds` its product booking parts.
 */
function isFareFulfillment(fulfillment, { fareIds = [], productIds = [] } = {}) {
  const fares = new Set(list(fareIds));
  const products = new Set(list(productIds));
  const named = namedIdsOf(fulfillment);
  if (named.some((id) => fares.has(id))) return true;
  if (list(fulfillment?.billingReferences).length > 0) return true;
  return !named.some((id) => products.has(id));
}

/**
 * Which fares each fulfilment holds. `fares` are the booked fares ({ id,
 * accountingRef }), `reservationIds` the fare reservations (booking parts,
 * named as such), `productIds` the product booking parts. Returns:
 *   fareFulfillments  the ids of the fare fulfilments, in order;
 *   byFulfillment     { fulfilment id: [fare ids] } for the fares known to be its;
 *   shared            { fulfillmentIds, fareIds } when several fare fulfilments
 *                     name no fare and share the rest, else null;
 *   unheld            the fares no fulfilment holds.
 */
// The fares the fulfilments name in `bookingParts`: each one's holder (the
// first naming it).
function namedHolders(ofFares, fareIds, holderOf) {
  for (const f of ofFares) {
    for (const id of namedIdsOf(f).filter((x) => fareIds.has(x))) {
      if (!holderOf.has(id)) holderOf.set(id, f.id);
    }
  }
}

// One billing reference names one fare: two passengers' fares of one tariff
// share an accounting id. A reference counts first for a fare its own
// fulfilment names, else takes one no fulfilment holds yet; of those, one of
// its own price first.
function billedHolders(ofFares, booked, holderOf) {
  for (const f of ofFares) {
    const counted = new Set();
    const pick = (pool, reference) => {
      const candidates = pool.filter((fare) => !counted.has(fare.id) && billsFare(reference, fare));
      return candidates.find((c) => list(c.prices)[0]?.amount === reference?.price?.amount) || candidates[0];
    };
    for (const reference of list(f.billingReferences)) {
      const fare = pick(booked.filter((x) => holderOf.get(x.id) === f.id), reference) || pick(booked.filter((x) => !holderOf.has(x.id)), reference);
      if (!fare) continue;
      counted.add(fare.id);
      holderOf.set(fare.id, f.id);
    }
  }
}

function fareHoldings({ fares = [], fulfillments = [], reservationIds = [], productIds = [] } = {}) {
  const booked = list(fares).filter((f) => typeof f?.id === 'string');
  const fareIds = new Set(booked.map((f) => f.id));
  const all = list(fulfillments).filter((f) => typeof f?.id === 'string');
  const kinds = { fareIds: [...fareIds, ...list(reservationIds)], productIds };
  const ofFares = all.filter((f) => isFareFulfillment(f, kinds));
  const holderOf = new Map();
  namedHolders(ofFares, fareIds, holderOf);
  billedHolders(ofFares, booked, holderOf);
  const byFulfillment = Object.fromEntries(ofFares.map((f) => [f.id, []]));
  for (const [fareId, holder] of holderOf) byFulfillment[holder].push(fareId);
  const rest = booked.map((f) => f.id).filter((id) => !holderOf.has(id));
  const open = ofFares.filter((f) => byFulfillment[f.id].length === 0).map((f) => f.id);
  let shared = null;
  let unheld = [];
  if (rest.length > 0 && open.length === 1) byFulfillment[open[0]].push(...rest);
  else if (rest.length > 0 && open.length > 1) shared = { fulfillmentIds: open, fareIds: rest };
  else unheld = rest;
  return { fareFulfillments: ofFares.map((f) => f.id), byFulfillment, shared, unheld };
}

/**
 * The fares a set of fulfilments holds together (`ids`): theirs, and the
 * shared ones when the set holds every fulfilment that shares them. `partly`
 * is true when the set holds only some of those: their fares cannot be told.
 */
function faresHeldBy(holdings, ids) {
  const asked = new Set(list(ids));
  const own = Object.entries(holdings.byFulfillment).filter(([id]) => asked.has(id)).flatMap(([, fareIds]) => fareIds);
  const sharers = holdings.shared ? holdings.shared.fulfillmentIds : [];
  const inSet = sharers.filter((id) => asked.has(id));
  if (inSet.length === 0) return { fareIds: own, partly: false };
  if (inSet.length === sharers.length) return { fareIds: [...own, ...holdings.shared.fareIds], partly: false };
  return { fareIds: own, partly: true };
}

module.exports = { namedIdsOf, billsFare, isFareFulfillment, fareHoldings, faresHeldBy };
