// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * replacements.js — the replacement of a lost ticket or card (#1266).
 *
 * OSDM (after-sales processes, "Replacement of lost tickets and cards"): the
 * replacement is asked as a non-trip offer whose search tags hold
 * TICKET_LOST or CARD_LOST; the provider asks for the data of the lost
 * ticket or card; the offer may include a fee; it is booked as any offer.
 * OSDM names no member for that data. The simulator asks it the way OSDM
 * asks for any data, with `requestedInformation`:
 *
 *   - TICKET_LOST: the holder's last name and date of birth. The offer holds,
 *     per passenger, an admission replacing the lost ten-ride card;
 *   - CARD_LOST: the number of the passenger's card (CardReference.number).
 *     The offer holds, per passenger, an admission replacing the card
 *     (product type REDUCTION_CARD).
 *
 * The admission is priced 0 and the offer holds one fee (`Offer.fees`). At
 * booking the data is checked against what the profile knows
 * (`nonTrip.replacements`): a holder or a card number it does not know is a
 * 400 Problem, before anything is booked.
 */

const { HttpError } = require('../http');

const KINDS = Object.freeze(['TICKET_LOST', 'CARD_LOST']);
const REQUESTED = Object.freeze({
  TICKET_LOST: 'passengerSpecifications[ANY].detail.lastName AND passengerSpecifications[ANY].dateOfBirth',
  CARD_LOST: 'passengerSpecifications[ANY].cards.number',
});

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The lost kinds a request asks (its tags, then its selections' tags), in OSDM's order; [] for none. */
function lostAsked(criteria, provider) {
  if (!provider?.nonTrip?.replacements) return [];
  const tags = Array.isArray(criteria?.productTags) ? criteria.productTags : [];
  const selections = Array.isArray(criteria?.productSelections) ? criteria.productSelections.map((s) => s?.productTag) : [];
  const asked = new Set([...tags, ...selections].map(text).filter(Boolean));
  return KINDS.filter((kind) => asked.has(kind));
}

/** The non-trip product sold to replace a lost ticket or card, as the offer builder takes it. */
function itemOf(kind, provider) {
  const r = provider.nonTrip.replacements;
  const source = kind === 'CARD_LOST' ? r.card : r.ticket;
  return {
    code: source.code,
    name: source.name,
    type: kind === 'CARD_LOST' ? 'REDUCTION_CARD' : source.type,
    flexibility: 'NON_FLEXIBLE',
    factor: 1,
    validityMinutes: source.validityMinutes,
  };
}

/** The replacement fee, in the provider's currency and price factor. */
function feeOf(provider) {
  return { amount: Math.round(provider.nonTrip.replacements.fee * provider.priceFactor), currency: provider.currency, scale: 2 };
}

/** The products of GET /products: what replaces a lost ticket and a lost card, tagged so. */
function productsOf(provider, productOf) {
  if (!provider.nonTrip?.replacements) return [];
  return KINDS.map((kind) => ({ ...productOf(itemOf(kind, provider), 'SECOND', provider), productTags: [kind] }));
}

/**
 * Turn a non-trip offer built for the replacement product into the
 * replacement offer: admissions priced 0 that ask for the lost item's data,
 * products tagged with the kind, and the fee.
 */
function asReplacement(offer, kind, provider, feeId) {
  const fee = feeOf(provider);
  for (const part of offer.admissionOfferParts) {
    part.price = { ...part.price, amount: 0 };
    part.requestedInformation = REQUESTED[kind];
  }
  offer.products = offer.products.map((p) => ({ ...p, productTags: [kind] }));
  offer.fees = [{ id: feeId, summary: `${itemOf(kind, provider).name}: replacement fee`, price: fee }];
  offer.offerSummary.minimalPrice = fee;
  return offer;
}

const refused = (code, title, detail, pointer) => new HttpError(400, code, title, detail, {}, { pointers: [{ requestPointer: pointer }] });

const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * At booking, the data of each passenger of a replacement offer: a holder of
 * a lost ticket the provider knows, or a card it knows. `specs` are the
 * booking's passenger specifications of that offer, with their index.
 */
function checkBooking(kind, specs, provider) {
  const r = provider.nonTrip.replacements;
  for (const { spec, index } of specs) {
    const at = `/passengerSpecifications/${index}`;
    if (kind === 'TICKET_LOST') {
      const lastName = spec?.detail?.lastName;
      const dateOfBirth = spec?.dateOfBirth;
      if (!text(lastName) || !text(dateOfBirth)) {
        throw refused('REQUESTED_INFORMATION_MISSING', 'Requested information missing',
          `The replacement of a lost ticket needs the holder's last name and date of birth (requestedInformation: ${REQUESTED.TICKET_LOST}).`, at);
      }
      if (!r.ticket.holders.some((h) => sameName(h.lastName, lastName) && h.dateOfBirth === dateOfBirth)) {
        throw refused('LOST_TICKET_NOT_FOUND', 'Lost ticket not found', 'No ticket of this holder is known: nothing to replace.', at);
      }
    } else {
      const numbers = (Array.isArray(spec?.cards) ? spec.cards : []).map((c) => text(c?.number)).filter(Boolean);
      if (numbers.length === 0) {
        throw refused('REQUESTED_INFORMATION_MISSING', 'Requested information missing',
          `The replacement of a lost card needs the card's number (requestedInformation: ${REQUESTED.CARD_LOST}).`, `${at}/cards`);
      }
      if (!r.card.cards.some((c) => numbers.includes(c.number))) {
        throw refused('LOST_CARD_NOT_FOUND', 'Lost card not found', 'No card of this number is known: nothing to replace.', `${at}/cards`);
      }
    }
  }
}

module.exports = { KINDS, REQUESTED, lostAsked, itemOf, feeOf, productsOf, asReplacement, checkBooking };
