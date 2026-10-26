// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * exchanges.js — the exchange of a confirmed booking (#611), on a provider
 * whose profile sets `exchange`.
 *
 *   POST /bookings/{id}/exchange-offers       new offers for the fulfillments
 *                                             named, priced against them, for
 *                                             the trip asked, with its trips
 *   POST /bookings/{id}/exchange-operations   one of them taken: PREBOOKED, the
 *                                             parts it replaces EXCHANGE_ONGOING
 *   GET, DELETE .../exchange-operations/{id}  read it; withdraw it while it is
 *                                             pre-booked (the parts go back)
 *   POST /bookings/{id}/fulfillments          confirms it: the old parts and
 *                                             fulfillments EXCHANGED, the new
 *                                             booked offer FULFILLED
 *
 * The fee follows the exchangeability of the parts given up, as a refund
 * does: none when exchangeable, a quarter of the price with conditions, the
 * whole price when not exchangeable. An overrule code waives it. What is left
 * to pay is the new price plus the fee minus what the parts given up cost.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { buildOfferCollection } = require('./offers');
const variants = require('./variants');
const { currencyOf } = require('./bookings');
const afterSales = require('./afterSales');

const MAX_FULFILLMENT_IDS = 20;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The exchange request is not valid', detail);
const conflict = (detail) => new HttpError(409, 'CONFLICT', 'Conflict', detail);
const randomId = () => crypto.randomBytes(8).toString('hex');
const price = (amount, currency) => ({ amount, currency, scale: 2 });

// What the booking keeps of its exchanges: never sent back with it.
const EXCHANGES = Symbol('exchanges');

function exchangesOf(booking) {
  if (!booking[EXCHANGES]) {
    Object.defineProperty(booking, EXCHANGES, { value: { offers: new Map(), operations: new Map() } });
  }
  return booking[EXCHANGES];
}

const partsOf = (booking) => booking.bookedOffers.flatMap((o) => [...o.admissions, ...(o.reservations || [])]);

// The fulfillments named, each still held by the booking.
function namedFulfillments(booking, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_FULFILLMENT_IDS) {
    throw bad(`fulfillmentIds must hold 1 to ${MAX_FULFILLMENT_IDS} fulfillment ids`);
  }
  if (new Set(ids).size !== ids.length) throw bad('fulfillmentIds names a fulfillment twice');
  return ids.map((id, i) => {
    if (typeof id !== 'string') throw bad(`fulfillmentIds[${i}] is not text`);
    const fulfillment = booking.fulfillments.find((f) => f.id === id);
    if (!fulfillment) throw bad(`fulfillmentIds[${i}]: "${id.slice(0, 80)}" is not a fulfillment of this booking`);
    if (!['FULFILLED', 'CONFIRMED'].includes(fulfillment.status)) {
      throw conflict(`fulfillment ${fulfillment.id} is ${fulfillment.status}: only a valid ticket can be exchanged`);
    }
    return fulfillment;
  });
}

// The parts a set of fulfillments holds.
function partsHeldBy(booking, fulfillments) {
  const ids = new Set(fulfillments.flatMap((f) => f.bookingParts.map((p) => p.id)));
  return partsOf(booking).filter((part) => ids.has(part.id));
}

function feeOf(parts, overruled) {
  if (overruled) return 0;
  return parts.reduce((total, part) => {
    if (part.exchangeable === 'NO') return total + part.price.amount;
    if (part.exchangeable === 'WITH_CONDITION') return total + afterSales.feeOf(part.price.amount);
    return total;
  }, 0);
}

function overruleCodeOf(body, provider) {
  const code = body.overruleCode;
  if (code == null) return null;
  if (typeof code !== 'string' || code.length === 0 || code.length > 60) throw bad('overruleCode is not valid');
  if (provider.overruleCodes && !provider.overruleCodes.includes(code)) {
    throw new HttpError(400, 'OVERRULE_CODE_NOT_SUPPORTED', 'Overrule code not supported',
      `overruleCode "${code}" is not accepted. Accepted: ${provider.overruleCodes.join(', ')}.`);
  }
  return code;
}

const fulfillmentRef = (booking, f) => ({ id: f.id, status: f.status, bookingRef: booking.id, createdOn: f.createdOn, bookingParts: f.bookingParts });

function exchangeOfferFrom(booking, entry, given, overruleCode, provider) {
  const { offer } = entry;
  const exchangePrice = offer.offerSummary.minimalPrice.amount;
  const exchangeFee = feeOf(given.parts, !!overruleCode);
  const balance = exchangePrice + exchangeFee - given.parts.reduce((total, p) => total + p.price.amount, 0)
    + (variants.has(booking, 'wrong-exchange-amount') ? 1 : 0);
  return {
    offerId: offer.offerId,
    summary: `Exchange: ${offer.summary}`,
    createdOn: offer.createdOn,
    preBookableUntil: offer.preBookableUntil,
    passengerRefs: offer.passengerRefs,
    products: offer.products,
    tripCoverage: offer.tripCoverage,
    offerSummary: offer.offerSummary,
    admissionOfferParts: offer.admissionOfferParts,
    ...(offer.reservationOfferParts ? { reservationOfferParts: offer.reservationOfferParts } : {}),
    // #781: the new journey's price in the currency it was offered in; the
    // fee and the balance in the booking's.
    exchangePrice: price(exchangePrice, offer.offerSummary.minimalPrice.currency),
    exchangeFee: price(exchangeFee, currencyOf(booking, provider)),
    // What is left to pay, or what comes back when the new journey costs less.
    ...(balance >= 0
      ? { amountToBePaid: price(balance, currencyOf(booking, provider)) }
      : { refundableAmount: price(-balance, currencyOf(booking, provider)) }),
    fulfillments: given.fulfillments.map((f) => fulfillmentRef(booking, f)),
    ...(overruleCode ? { appliedOverruleCode: overruleCode } : {}),
  };
}

/**
 * POST /bookings/{id}/exchange-offers. The request is an offer request (trip,
 * criteria, passengers) plus the fulfillments to give up.
 */
// #959: the variant that keeps the booking's own trip, whatever trip the
// request asks for: the offers are asked by the trip ids of the booking.
function keptTripRequest(booking, body) {
  if (!variants.has(booking, 'wrong-exchange-keeps-trip') || booking.trips.length === 0) return body;
  const out = { ...body, tripIds: booking.trips.map((t) => t.id) };
  delete out.tripSpecifications;
  delete out.tripSearchCriteria;
  return out;
}

function createExchangeOffers(booking, body, provider, nowMs, known) {
  if (booking.fulfillments.length === 0) throw conflict('the booking is not confirmed: it has nothing to exchange');
  const fulfillments = namedFulfillments(booking, body.fulfillmentIds);
  const given = { fulfillments, parts: partsHeldBy(booking, fulfillments) };
  const overruleCode = overruleCodeOf(body, provider);
  const { remembered } = buildOfferCollection(keptTripRequest(booking, body), provider, nowMs, known);
  const refs = new Set(booking.passengers.map((p) => p.externalRef));
  const unknown = remembered.flatMap((entry) => entry.offer.passengerRefs).find((ref) => !refs.has(ref));
  if (unknown !== undefined) throw bad(`anonymousPassengerSpecifications: "${unknown}" is not the externalRef of a passenger of this booking`);
  if (remembered.length === 0) {
    throw new HttpError(404, 'NO_EXCHANGE_OFFER', 'No exchange offer', 'No offer matches the request.');
  }
  const state = exchangesOf(booking);
  return remembered.map((entry) => {
    const exchangeOffer = exchangeOfferFrom(booking, entry, given, overruleCode, provider);
    state.offers.set(exchangeOffer.offerId, { exchangeOffer, entry, fulfillmentIds: fulfillments.map((f) => f.id) });
    return exchangeOffer;
  });
}

/** #959: the trips the exchange offers given cover, each once. */
function tripsOfExchangeOffers(booking, exchangeOffers) {
  const state = exchangesOf(booking);
  const trips = new Map();
  for (const offer of exchangeOffers) {
    for (const trip of state.offers.get(offer.offerId)?.entry.trips || []) trips.set(trip.id, trip);
  }
  return [...trips.values()];
}

const operationNotFound = () => new HttpError(404, 'EXCHANGE_OPERATION_NOT_FOUND', 'Exchange operation not found');

function setPartStatus(booking, fulfillmentIds, status) {
  const held = booking.fulfillments.filter((f) => fulfillmentIds.includes(f.id));
  for (const part of partsHeldBy(booking, held)) part.status = status;
}

/** POST /bookings/{id}/exchange-operations: one exchange offer, pre-booked. */
function createExchangeOperation(booking, body, provider, nowMs) {
  const asked = body.exchangeOffers;
  if (!Array.isArray(asked) || asked.length !== 1 || typeof asked[0]?.offerId !== 'string') {
    throw bad('exchangeOffers must name exactly one exchange offer');
  }
  const state = exchangesOf(booking);
  const kept = state.offers.get(asked[0].offerId);
  if (!kept) throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found', 'The exchange offer does not exist for this booking.');
  if (Date.parse(kept.exchangeOffer.preBookableUntil) <= nowMs) {
    throw new HttpError(409, 'OFFER_EXPIRED', 'Offer expired', 'This exchange offer can no longer be booked.');
  }
  if ([...state.operations.values()].some((op) => op.operation.status === 'PREBOOKED')) {
    throw conflict('an exchange of this booking is already pre-booked');
  }
  const operation = {
    id: `${provider.idPrefix}-EXO-${randomId()}`,
    status: 'PREBOOKED',
    exchangeOffers: [kept.exchangeOffer],
  };
  state.operations.set(operation.id, { operation, kept });
  setPartStatus(booking, kept.fulfillmentIds, 'EXCHANGE_ONGOING');
  return operation;
}

function findExchangeOperation(booking, operationId) {
  const found = exchangesOf(booking).operations.get(operationId);
  if (!found) throw operationNotFound();
  return found.operation;
}

/** DELETE .../exchange-operations/{id}: a pre-booked exchange only. */
function deleteExchangeOperation(booking, operationId) {
  const state = exchangesOf(booking);
  const found = state.operations.get(operationId);
  if (!found) throw operationNotFound();
  if (found.operation.status !== 'PREBOOKED') throw conflict('a confirmed exchange cannot be withdrawn');
  setPartStatus(booking, found.kept.fulfillmentIds, 'FULFILLED');
  state.operations.delete(operationId);
}

/** The exchange of this booking that waits for its confirmation, if any. */
function pendingExchange(booking) {
  if (!booking[EXCHANGES]) return null;
  return [...booking[EXCHANGES].operations.values()].find((op) => op.operation.status === 'PREBOOKED') || null;
}

/**
 * POST /bookings/{id}/fulfillments while an exchange is pre-booked: the old
 * parts and their fulfillments become EXCHANGED, the new offer is booked and
 * issued. `bookOffer(entry)` makes the booked offer of a remembered offer.
 */
function confirmExchange(booking, pending, provider, nowMs, bookOffer) {
  const { operation, kept } = pending;
  const confirmedOn = new Date(nowMs).toISOString();
  const given = booking.fulfillments.filter((f) => kept.fulfillmentIds.includes(f.id));
  const givenParts = partsHeldBy(booking, given);
  for (const part of givenParts) part.status = 'EXCHANGED';
  for (const fulfillment of given) fulfillment.status = 'EXCHANGED';
  const bookedOffer = bookOffer(kept.entry);
  const newParts = [...bookedOffer.admissions, ...(bookedOffer.reservations || [])];
  for (const part of newParts) {
    part.status = 'FULFILLED';
    part.confirmedOn = confirmedOn;
    delete part.confirmableUntil;
  }
  booking.bookedOffers.push(bookedOffer);
  const fulfillment = {
    id: `${provider.idPrefix}-FUL-${randomId()}`,
    status: 'FULFILLED',
    bookingRef: booking.id,
    summary: `${provider.name} ticket (exchange)`,
    createdOn: confirmedOn,
    controlNumber: String(crypto.randomInt(1000000000, 9999999999)),
    issuer: provider.carrier.ref,
    bookingParts: newParts.map((p) => ({ id: p.id, summary: p.summary })),
  };
  booking.fulfillments.push(fulfillment);
  const offer = operation.exchangeOffers[0];
  const kept0 = booking.confirmedPrice ? booking.confirmedPrice.amount : 0;
  const givenAmount = givenParts.reduce((total, p) => total + p.price.amount, 0);
  booking.confirmedPrice = price(kept0 - givenAmount + offer.exchangePrice.amount + offer.exchangeFee.amount, currencyOf(booking, provider));
  operation.status = 'CONFIRMED';
  return booking.fulfillments;
}

module.exports = {
  createExchangeOffers, createExchangeOperation, findExchangeOperation, deleteExchangeOperation,
  pendingExchange, confirmExchange, tripsOfExchangeOffers,
};
