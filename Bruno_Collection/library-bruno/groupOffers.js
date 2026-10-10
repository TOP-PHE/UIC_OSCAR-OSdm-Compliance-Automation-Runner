/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * groupOffers.js — group tariffs (#599).
 *
 * A scenario asks for a group tariff with the COLLECTIVE offer mode of its
 * offer search criteria, and names the group product with `expectedProduct`
 * (#598). OSDM prices a COLLECTIVE offer for the group: the chosen offer must
 * hold, for each trip it covers, one COLLECTIVE admission for the whole
 * group, naming the passenger type it applied to each passenger. Its price is
 * then compared with the same search in the INDIVIDUAL mode (step 01d): a
 * group dearer than the same passengers alone fails.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-group-offers.test.js.
 */

const listOf = (value) => (Array.isArray(value) ? value : []);

/** Whether an offer request asks for the COLLECTIVE offer mode. */
const collectiveAsked = (request) => request?.offerSearchCriteria?.offerMode === 'COLLECTIVE';

/** The same offer request in the INDIVIDUAL mode (step 01d). */
function individualRequest(request) {
  const out = { ...request };
  out.offerSearchCriteria = { ...request?.offerSearchCriteria, offerMode: 'INDIVIDUAL' };
  return out;
}

const sameRefs = (a, b) => a.length === b.length && a.every((ref) => b.includes(ref));
const refsText = (refs) => `[${refs.join(', ')}]`;

// The admissions of an offer by the trip they cover, in the order met.
function admissionsByTrip(offer) {
  const byTrip = new Map();
  for (const part of listOf(offer?.admissionOfferParts)) {
    const tripId = part?.tripCoverage?.coveredTripId || '(no trip)';
    if (!byTrip.has(tripId)) byTrip.set(tripId, []);
    byTrip.get(tripId).push(part);
  }
  return byTrip;
}

// The check that one trip's admissions are one COLLECTIVE part for the group.
function wholeGroupCheck(tripId, parts, passengerRefs) {
  const collective = parts.filter((p) => p?.offerMode === 'COLLECTIVE');
  const name = `Group offer: one COLLECTIVE admission for the whole group on trip ${tripId}`;
  if (collective.length === 1 && sameRefs(listOf(collective[0].passengerRefs), passengerRefs)) return { name, ok: true };
  const found = parts.map((p) => `${p?.offerMode || 'no offerMode'} ${refsText(listOf(p?.passengerRefs))}`).join('; ');
  return { name, ok: false, message: `expected one COLLECTIVE admission for ${refsText(passengerRefs)}; found: ${found || 'none'}` };
}

/**
 * The checks on the offer chosen for a COLLECTIVE request: for each trip it
 * covers, one COLLECTIVE admission for the whole group; and the passenger
 * type applied to each passenger. OSDM does not require
 * `appliedPassengerTypes`: when no collective admission gives it, that is a
 * warning (`level: 'warn'`); when one gives it, every passenger must be in it.
 * @returns {Array<{name: string, ok: boolean, message?: string, level?: string}>}
 */
function checkCollectiveOffer(offer, passengerRefs) {
  const byTrip = admissionsByTrip(offer);
  if (byTrip.size === 0) {
    return [{ name: 'Group offer: the chosen offer holds an admission', ok: false, message: 'no admissionOfferParts' }];
  }
  const checks = [...byTrip].map(([tripId, parts]) => wholeGroupCheck(tripId, parts, passengerRefs));
  const collective = [...byTrip.values()].flat().filter((p) => p?.offerMode === 'COLLECTIVE');
  const typed = collective.filter((p) => listOf(p.appliedPassengerTypes).length > 0);
  if (collective.length > 0 && typed.length === 0) {
    checks.push({ name: 'Group offer: the passenger types applied to the group are given', ok: false, level: 'warn', message: 'no COLLECTIVE admission gives appliedPassengerTypes' });
  }
  for (const part of typed) {
    const named = part.appliedPassengerTypes.map((t) => t?.passengerRef);
    const missing = listOf(part.passengerRefs).filter((ref) => !named.includes(ref));
    const types = part.appliedPassengerTypes.map((t) => `${t?.passengerRef}: ${t?.type}`).join(', ');
    checks.push({
      name: `Group offer: admission ${part.id} names the passenger type of each passenger — ${types}`,
      ok: missing.length === 0,
      message: missing.length === 0 ? undefined : `no applied passenger type for ${refsText(missing)}`,
    });
  }
  return checks;
}

// The price of an offer: its minimal price, else the sum of its admissions.
function priceOf(offer) {
  const minimal = offer?.offerSummary?.minimalPrice;
  if (Number.isFinite(minimal?.amount)) return { amount: minimal.amount, currency: minimal.currency };
  const parts = listOf(offer?.admissionOfferParts).map((p) => p?.price).filter((p) => Number.isFinite(p?.amount));
  if (parts.length === 0) return null;
  return { amount: parts.reduce((sum, p) => sum + p.amount, 0), currency: parts[0].currency };
}

const travelClassOf = (offer) => offer?.offerSummary?.overallTravelClass;
const flexibilityOf = (offer) => offer?.offerSummary?.overallFlexibility;

/**
 * Step 01d: the group offer against the cheapest offer of the same travel
 * class (and the same flexibility, when there is one) in the answer of the
 * INDIVIDUAL search, which prices the same passengers alone. Dearer fails; the
 * same price is a warning; an answer that cannot be compared is a warning.
 */
function compareGroupWithIndividual(groupOffer, body) {
  const name = 'Group offer: the group pays less than the same passengers alone';
  const warn = (message) => [{ name, ok: false, level: 'warn', message }];
  const group = priceOf(groupOffer);
  if (!group) return warn('the group offer has no price; not compared');
  const sameClass = listOf(body?.offers).filter((o) => travelClassOf(o) === travelClassOf(groupOffer) && priceOf(o)?.currency === group.currency);
  const sameFlexibility = sameClass.filter((o) => flexibilityOf(o) === flexibilityOf(groupOffer));
  const candidates = sameFlexibility.length > 0 ? sameFlexibility : sameClass;
  if (candidates.length === 0) return warn(`the INDIVIDUAL search gave no offer in ${travelClassOf(groupOffer) || 'the same class'} and ${group.currency}; not compared`);
  const cheapest = candidates.reduce((best, o) => (priceOf(o).amount < priceOf(best).amount ? o : best));
  const alone = priceOf(cheapest).amount;
  const what = `group ${group.amount} ${group.currency}, alone ${alone} (offer ${cheapest.offerId}${sameFlexibility.length > 0 ? '' : ', another flexibility'})`;
  if (group.amount > alone) return [{ name: `${name} — ${what}`, ok: false, message: 'the group offer costs more than the same passengers alone' }];
  if (group.amount === alone) return [{ name: `${name} — ${what}`, ok: false, level: 'warn', message: 'the group offer costs the same as the same passengers alone' }];
  return [{ name: `${name} — ${what}`, ok: true }];
}

module.exports = { collectiveAsked, individualRequest, checkCollectiveOffer, compareGroupWithIndividual };
