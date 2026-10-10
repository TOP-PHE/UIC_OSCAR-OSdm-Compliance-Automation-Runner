// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reductionCards.js — the reduction cards of a provider (#597).
 *
 * A provider whose profile lists `reductionCards` answers GET /reduction-cards
 * with them, and prices an offer with the reduction of the card a passenger
 * carries. A card it does not know is ignored: the passenger pays the full
 * price, and the answer carries a Problem naming the card. A passenger with
 * several known cards gets the largest reduction.
 */

const { HttpError } = require('../http');

const MAX_CARDS = 5;
const MAX_TEXT = 60;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', detail);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
// The name of a card type is an OSDM Text: an object with an id and a text.
const nameOf = (card) => ({ id: `${card.code}-NAME`, text: card.name });

/** The ReductionCardCollectionResponse of a provider, or null when it has no card. */
function reductionCardCollection(provider) {
  if (!provider.reductionCards) return null;
  return {
    reductionCardTypes: provider.reductionCards.map((card) => ({
      code: card.code,
      issuer: provider.carrier.ref,
      name: nameOf(card),
      cardIdRequired: false,
      reductionsGranted: [{ carrier: provider.carrier.ref, description: `${card.percent} % off the fare` }],
    })),
  };
}

/**
 * The cards of one passenger specification, kept as the request wrote them
 * (only what is text), or [] when it carries none. `where` names the passenger
 * in a refusal.
 */
function cardsOf(spec, where) {
  const cards = spec?.cards;
  if (cards == null) return [];
  if (!Array.isArray(cards) || cards.length > MAX_CARDS) throw bad(`${where}.cards must be a list of at most ${MAX_CARDS} cards`);
  return cards.map((card, i) => {
    if (!card || typeof card !== 'object' || !text(card.type)) throw bad(`${where}.cards[${i}].type is missing or not valid`);
    const kept = { type: card.type };
    for (const field of ['code', 'number', 'issuer']) {
      if (card[field] == null) continue;
      if (!text(card[field])) throw bad(`${where}.cards[${i}].${field} is not valid`);
      kept[field] = card[field];
    }
    return kept;
  });
}

/**
 * What the provider makes of a passenger's cards: the card type it applies
 * (the largest reduction among the reduction cards it knows), and the codes of
 * the reduction cards it does not know.
 */
function applyCards(cards, provider) {
  const known = provider.reductionCards || [];
  let applied = null;
  const unknown = [];
  for (const card of cards) {
    if (card.type !== 'REDUCTION_CARD') continue;
    const match = known.find((k) => k.code === card.code);
    if (!match) unknown.push(card.code || '(no code)');
    else if (!applied || match.percent > applied.percent) applied = match;
  }
  return { applied, unknown };
}

/** The price of a passenger once the applied card's reduction is taken off. */
const reducedPrice = (amount, applied) => (applied ? Math.round(amount * (100 - applied.percent) / 100) : amount);

/** The Problem an offer answer carries for a card the provider does not know. */
function unknownCardProblem(externalRef, codes) {
  return {
    code: 'REDUCTION_CARD_NOT_APPLIED',
    title: 'Reduction card not applied',
    detail: `Passenger ${externalRef}: reduction card ${codes.map((c) => `"${c}"`).join(', ')} is not known to this provider; the full fare applies.`,
  };
}

/** The ReductionCardType an AppliedPassengerType names. */
function appliedCardType(card, provider) {
  return { code: card.code, issuer: provider.carrier.ref, name: nameOf(card) };
}

module.exports = { reductionCardCollection, cardsOf, applyCards, reducedPrice, unknownCardProblem, appliedCardType, MAX_CARDS };
