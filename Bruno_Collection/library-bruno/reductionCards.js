/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * reductionCards.js — the reduction cards of a passenger (#597).
 *
 * A passenger of the data file may hold reduction card codes
 * (`passengersList[].passengers[].reductionCards`). They are sent in the offer
 * and booking requests as OSDM CardReferences, `{ type: "REDUCTION_CARD",
 * code, issuer }`, the same shape from OSDM 3.5 to 3.8. The issuer comes from
 * the provider's own list (GET /reduction-cards, step 06) when the code is in
 * it.
 *
 * Two checks prove that the provider applied a card:
 *  - the offer names it on the passenger (AppliedPassengerType
 *    .appliedReductionCardTypes or .appliedReductions);
 *  - the passenger pays less than in the same request without cards (step
 *    01c, made only when a passenger holds a card). Not less is a warning
 *    (#644): the price is the provider's commercial choice.
 *
 * When the provider declares what a card takes off (#889: `percent` on the
 * card in the Test Framework, which the run's copy writes on the passenger's
 * card in the data file), 01c checks the amount instead: the price with the
 * card is the price without it less that share, within the rounding tolerance
 * (`RATE_TOLERANCE`). A wrong amount then fails: the provider said what the
 * card is worth. Not on a group tariff (a COLLECTIVE request, #599), where a
 * provider's cards may not apply: that is told, not checked.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-reduction-cards.test.js.
 */

const REDUCTION_CARD = 'REDUCTION_CARD';
const MAX_CARDS = 5;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The CardReferences of a passenger of the data file: one per reduction card
 * code (a text, or an object with a `code`), blanks and repeats left out.
 */
function cardsOfPassenger(passenger) {
  const list = Array.isArray(passenger?.reductionCards) ? passenger.reductionCards : [];
  const cards = [];
  for (const card of list.map(cardOfEntry)) {
    if (!card || cards.some((c) => c.code === card.code)) continue;
    cards.push(card);
    if (cards.length === MAX_CARDS) break;
  }
  return cards;
}

// One entry of a passenger's list: a code, or an object with a code and
// perhaps an issuer and a number. Null when it holds no code.
function cardOfEntry(entry) {
  const isObject = entry !== null && typeof entry === 'object';
  const code = text(isObject ? entry.code : entry);
  if (!code) return null;
  const card = { type: REDUCTION_CARD, code };
  if (isObject && text(entry.issuer)) card.issuer = text(entry.issuer);
  if (isObject && text(entry.number)) card.number = text(entry.number);
  return card;
}

// A reduction rate: a number above 0 and at most 100, or null.
function rateOf(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/**
 * The declared reduction rate of each passenger of the data file holding a
 * card that names one (#889): { [reference]: percent }. The first card with a
 * rate counts, as a provider applies one card per passenger.
 */
function ratesOfPassengers(passengers) {
  const rates = {};
  for (const p of Array.isArray(passengers) ? passengers : []) {
    const ref = text(p?.reference);
    if (!ref || !Array.isArray(p.reductionCards)) continue;
    const card = p.reductionCards.find((c) => c !== null && typeof c === 'object' && text(c.code) && rateOf(c.percent) !== null);
    if (card) rates[ref] = rateOf(card.percent);
  }
  return rates;
}

/** The codes and issuers of a ReductionCardCollectionResponse, or null when it holds none. */
function knownCardTypesFrom(body) {
  const list = Array.isArray(body?.reductionCardTypes) ? body.reductionCardTypes : null;
  if (!list) return null;
  return list
    .filter((t) => text(t?.code))
    .map((t) => ({ code: text(t.code), ...(text(t.issuer) ? { issuer: text(t.issuer) } : {}) }));
}

/**
 * The passenger specifications with each reduction card's issuer filled in
 * from the provider's list, when it is missing and the code is in the list.
 * `known` is that list, or null when it could not be read. Returns the new
 * specifications and the codes the list does not hold.
 */
function withIssuers(specs, known) {
  const unknown = [];
  const out = (Array.isArray(specs) ? specs : []).map((spec) => {
    if (!Array.isArray(spec?.cards) || spec.cards.length === 0) return spec;
    const cards = spec.cards.map((card) => {
      if (card?.type !== REDUCTION_CARD || !Array.isArray(known)) return card;
      const match = known.find((k) => k.code === card.code);
      if (!match) {
        if (!unknown.includes(card.code)) unknown.push(card.code);
        return card;
      }
      return card.issuer || !match.issuer ? card : { ...card, issuer: match.issuer };
    });
    return { ...spec, cards };
  });
  return { specs: out, unknown };
}

/** The passenger specifications without their cards: the request 01c sends. */
function withoutCards(specs) {
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    if (!spec || !('cards' in spec)) return spec;
    const rest = { ...spec };
    delete rest.cards;
    return rest;
  });
}

/** The reduction card codes of each passenger that holds some: [{ ref, codes }]. */
function passengersWithCards(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map((spec) => ({
      ref: spec?.externalRef,
      codes: (Array.isArray(spec?.cards) ? spec.cards : []).filter((c) => c?.type === REDUCTION_CARD && c.code).map((c) => c.code),
    }))
    .filter((p) => p.ref && p.codes.length > 0);
}

const admissionsOf = (offer) => (Array.isArray(offer?.admissionOfferParts) ? offer.admissionOfferParts : []);
const refsOf = (part) => (Array.isArray(part?.passengerRefs) ? part.passengerRefs : []);

// The card codes an offer part says it applied to a passenger.
const listOf = (value) => (Array.isArray(value) ? value : []);

function appliedCodes(part, ref) {
  return listOf(part?.appliedPassengerTypes)
    .filter((t) => t?.passengerRef === ref)
    .flatMap((t) => [...listOf(t.appliedReductionCardTypes), ...listOf(t.appliedReductions)])
    .map((c) => c?.code)
    .filter(Boolean);
}

/**
 * The check that the chosen offer applied each passenger's card: an admission
 * of the passenger names one of its cards. `label` names the offer call.
 * @returns {Array<{name: string, ok: boolean, message?: string}>}
 */
function checkCardsApplied(offer, specs, label = 'Offer') {
  return passengersWithCards(specs).map(({ ref, codes }) => {
    const parts = admissionsOf(offer).filter((p) => refsOf(p).includes(ref));
    const named = [...new Set(parts.flatMap((p) => appliedCodes(p, ref)))];
    const ok = named.some((code) => codes.includes(code));
    let message;
    if (!ok && parts.length === 0) message = `no admission of the chosen offer is for passenger ${ref}`;
    else if (!ok) message = `no admission of passenger ${ref} names the card in appliedPassengerTypes (appliedReductionCardTypes / appliedReductions); named: [${named.join(', ')}]`;
    return { name: `${label}: the reduction card of passenger ${ref} is applied (${codes.join(', ')})`, ok, message };
  });
}

// What a passenger pays in an offer: the sum of its admissions.
function priceOf(offer, ref) {
  const parts = admissionsOf(offer).filter((p) => refsOf(p).length === 1 && refsOf(p)[0] === ref);
  if (parts.length === 0 || parts.some((p) => typeof p?.price?.amount !== 'number')) return null;
  return parts.reduce((sum, p) => sum + p.price.amount, 0);
}

// What every admission of an offer costs together, or null.
function totalOf(offer) {
  const parts = admissionsOf(offer);
  if (parts.length === 0 || parts.some((p) => typeof p?.price?.amount !== 'number')) return null;
  return parts.reduce((sum, p) => sum + p.price.amount, 0);
}

// The minor units of one unit of the offer's currency (Price.scale, 2 when absent).
function unitOf(offer) {
  const scale = admissionsOf(offer).map((p) => p?.price?.scale).find((v) => Number.isInteger(v) && v >= 0 && v <= 6);
  return 10 ** (scale ?? 2);
}

/**
 * #889: how far a price may be from the declared rate and still pass: one
 * unit of the currency per card holder (a provider rounds each price), or 1 %
 * of the price without the card, whichever is larger.
 */
const RATE_TOLERANCE = 'one currency unit per card holder, or 1 % of the price without the card';
const toleranceFor = (without, holders, unit) => Math.max(unit * holders, Math.abs(without) / 100);

/** The amount with a card of `percent`, from the amount without it. */
const expectedWith = (without, percent) => without * (100 - percent) / 100;

const sameKind = (a, b) => a?.offerSummary?.overallFlexibility === b?.offerSummary?.overallFlexibility
  && a?.offerSummary?.overallTravelClass === b?.offerSummary?.overallTravelClass;

// The check of a card holder's price against its declared rate.
function rateCheck(name, withCard, expected, tolerance, percent) {
  const ok = Math.abs(withCard - expected) <= tolerance;
  return {
    name,
    ok,
    level: 'fail',
    message: ok ? undefined : `${withCard} with the card; ${Math.round(expected)} expected (${percent} % off, within ${Math.round(tolerance)})`,
  };
}

/**
 * #889: the passengers no admission prices alone (a COLLECTIVE price): their
 * total against the declared rates, when every passenger is of one type (so
 * each pays an equal share of the price without cards). Null when it cannot
 * be compared that way.
 */
function compareTotals(chosen, counterpart, specs, rates) {
  const types = new Set((Array.isArray(specs) ? specs : []).map((s) => s?.type));
  const n = (Array.isArray(specs) ? specs : []).length;
  const holders = Object.keys(rates);
  const withCards = totalOf(chosen);
  const without = totalOf(counterpart);
  if (types.size !== 1 || n === 0 || holders.length === 0 || withCards === null || without === null) return null;
  const share = without / n;
  const expected = without - holders.reduce((sum, ref) => sum + share * rates[ref] / 100, 0);
  const percents = holders.map((ref) => `${ref} ${rates[ref]} %`).join(', ');
  return rateCheck(
    `Reduction cards: the offer costs the declared rates less (${percents}) — ${withCards} against ${without} without`,
    withCards, expected, toleranceFor(share, holders.length, unitOf(chosen)), percents,
  );
}

// One passenger's price check, or null when a declared rate cannot be
// checked on that passenger alone (no single-passenger admission): the
// offer's total is then compared (compareTotals).
function passengerCheck(chosen, counterpart, ref, carded, percent) {
  const withCard = priceOf(chosen, ref);
  const without = priceOf(counterpart, ref);
  if (withCard === null || without === null) {
    if (percent !== undefined) return null;
    return { name: `Reduction cards: the price of passenger ${ref} can be compared`, ok: false, level: 'warn', message: 'no single-passenger admission with a price on one side' };
  }
  if (percent !== undefined) {
    // #889: the provider declared the rate, so the amount is checked.
    return rateCheck(
      `Reduction cards: passenger ${ref} pays ${percent} % less with the card — ${withCard} against ${without} without`,
      withCard, expectedWith(without, percent), toleranceFor(without, 1, unitOf(chosen)), percent,
    );
  }
  if (carded) {
    // Cheaper passes. Not cheaper is a warning (#644): what a card is worth
    // on a tariff is the provider's commercial choice, which OSDM does not
    // set; whether the card was applied is checked on the offer itself.
    const cheaper = withCard < without;
    return {
      name: `Reduction cards: passenger ${ref} pays less with the card — ${withCard} against ${without} without`,
      ok: cheaper,
      level: cheaper ? 'fail' : 'warn',
      message: cheaper ? undefined : `${withCard} with the card is not below ${without} without it (a commercial choice, not an OSDM rule)`,
    };
  }
  return {
    name: `Reduction cards: passenger ${ref}, who holds no card, pays the same — ${withCard} and ${without}`,
    ok: withCard === without,
    level: 'warn',
    message: withCard === without ? undefined : `${withCard} with the other passengers' cards, ${without} without`,
  };
}

/**
 * The comparison of the chosen offer (with cards) with the offer of the same
 * flexibility and travel class in the answer without cards. A passenger with
 * a card must pay less; one without must pay the same (a warning only).
 * `rates` (#889) gives a card holder's declared reduction rate by reference:
 * the price is then checked against it, except on a group tariff (`group`).
 * @returns {Array<{name: string, ok: boolean, message?: string, level: 'fail'|'warn'|'info'}>}
 */
function comparePrices(chosen, plainResponse, specs, rates = {}, { group = false } = {}) {
  const withCards = new Set(passengersWithCards(specs).map((p) => p.ref));
  const counterpart = (Array.isArray(plainResponse?.offers) ? plainResponse.offers : []).find((o) => sameKind(o, chosen));
  if (!counterpart) {
    return [{
      name: 'Reduction cards: an offer of the same flexibility and travel class without cards to compare with',
      ok: false,
      level: 'warn',
      message: `the answer without cards has no ${chosen?.offerSummary?.overallFlexibility} / ${chosen?.offerSummary?.overallTravelClass} offer; prices not compared`,
    }];
  }
  const declared = group ? {} : Object.fromEntries(Object.entries(rates || {}).filter(([ref, v]) => withCards.has(ref) && rateOf(v) !== null));
  const out = [];
  if (group && Object.keys(rates || {}).length > 0) {
    out.push({ name: 'Reduction cards: the declared rate is not checked on a group tariff', ok: true, level: 'info' });
  }
  const refs = (Array.isArray(chosen?.passengerRefs) ? chosen.passengerRefs : []);
  const unpriced = {};
  for (const ref of refs) {
    const check = passengerCheck(chosen, counterpart, ref, withCards.has(ref), declared[ref]);
    if (check) out.push(check);
    else unpriced[ref] = declared[ref];
  }
  if (Object.keys(unpriced).length > 0) {
    out.push(compareTotals(chosen, counterpart, specs, unpriced) || {
      name: 'Reduction cards: the declared rate can be checked',
      ok: false,
      level: 'warn',
      message: `no single-passenger admission for ${Object.keys(unpriced).join(', ')}, and the passengers are not all of one type: the rate is not checked`,
    });
  }
  return out;
}

module.exports = {
  REDUCTION_CARD,
  RATE_TOLERANCE,
  cardsOfPassenger,
  ratesOfPassengers,
  rateOf,
  knownCardTypesFrom,
  withIssuers,
  withoutCards,
  passengersWithCards,
  checkCardsApplied,
  comparePrices,
};
