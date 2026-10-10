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
 *    01c, made only when a passenger holds a card).
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

const sameKind = (a, b) => a?.offerSummary?.overallFlexibility === b?.offerSummary?.overallFlexibility
  && a?.offerSummary?.overallTravelClass === b?.offerSummary?.overallTravelClass;

/**
 * The comparison of the chosen offer (with cards) with the offer of the same
 * flexibility and travel class in the answer without cards. A passenger with
 * a card must pay less; one without must pay the same (a warning only).
 * @returns {Array<{name: string, ok: boolean, message?: string, level: 'fail'|'warn'}>}
 */
function comparePrices(chosen, plainResponse, specs) {
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
  const refs = (Array.isArray(chosen?.passengerRefs) ? chosen.passengerRefs : []);
  return refs.map((ref) => {
    const withCard = priceOf(chosen, ref);
    const without = priceOf(counterpart, ref);
    const carded = withCards.has(ref);
    if (withCard === null || without === null) {
      return { name: `Reduction cards: the price of passenger ${ref} can be compared`, ok: false, level: 'warn', message: 'no single-passenger admission with a price on one side' };
    }
    if (carded) {
      return {
        name: `Reduction cards: passenger ${ref} pays less with the card — ${withCard} against ${without} without`,
        ok: withCard < without,
        level: 'fail',
        message: withCard < without ? undefined : `${withCard} with the card is not below ${without} without it`,
      };
    }
    return {
      name: `Reduction cards: passenger ${ref}, who holds no card, pays the same — ${withCard} and ${without}`,
      ok: withCard === without,
      level: 'warn',
      message: withCard === without ? undefined : `${withCard} with the other passengers' cards, ${without} without`,
    };
  });
}

module.exports = {
  REDUCTION_CARD,
  cardsOfPassenger,
  knownCardTypesFrom,
  withIssuers,
  withoutCards,
  passengersWithCards,
  checkCardsApplied,
  comparePrices,
};
