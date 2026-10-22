// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * refunds.js — refund offers, one per fulfillment (#595).
 *
 * The provider this follows refunds per fulfillment: a request names the
 * fulfillments, and gets one refund offer for each, holding all its booking
 * parts and passengers. Confirming one refunds that fulfillment only; to
 * cancel the whole booking every offer is confirmed. A refund scoped by
 * booking part or passenger is refused. A confirmed refund cannot be undone.
 *
 * The amounts follow the flexibility of the parts: a flexible part is refunded
 * in full, a semi-flexible one with a fee of a quarter of its price, a saver
 * one not at all (the fee is its price). An overrule code waives the fee: the
 * whole price is refunded, and the offer says which code it applied. A
 * provider that lists its overrule codes refuses any other (#596).
 *
 * A booked fare (#907) is refunded by its own after-sales conditions: the fee
 * of its REFUND condition valid at the time (none valid: nothing back). For
 * fares combined by CLUSTERING whose fee is the provider's (isProviderFee),
 * the client may state the fee in RefundSpecification.refundFee (osdm.io,
 * constructing products from fares), and that is the fee taken.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { noteRefund } = require('./documents');
const { lifetimeOf, currencyOf, partsOf, priceOf } = require('./bookings');
const variants = require('./variants');
const ticketing = require('./ticketing');

const REFUND_OFFER_LIFETIME_MS = 30 * 60 * 1000;
const MAX_FULFILLMENT_IDS = 20;
const SEMI_FLEXIBLE_FEE_SHARE = 0.25;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The refund request is not valid', detail);
const conflict = (detail) => new HttpError(409, 'CONFLICT', 'Conflict', detail);
const notFound = () => new HttpError(404, 'RESOURCE_NOT_FOUND', 'Refund offer not found');
const randomId = () => crypto.randomBytes(8).toString('hex');

// Every part of a booking, reservations (#601) and fares (#907) included.
const admissionsOf = partsOf;
const price = (amount, currency) => ({ amount, currency, scale: 2 });
const isFare = (part) => Array.isArray(part.prices);
const modelsOf = (fare) => (fare.combinationConstraint || []).map((c) => c.model);

// #907: a fare's own refund fee, from its REFUND condition valid at `nowMs`;
// none valid, the fee is its price. The wrong variant takes another window's.
function fareFee(fare, booking, nowMs) {
  const amount = priceOf(fare).amount;
  const windows = (fare.afterSalesCondition?.conditions || []).filter((c) => c.condition === 'REFUND');
  const valid = (c) => (!c.validFrom || Date.parse(c.validFrom) <= nowMs) && (!c.validUntil || nowMs <= Date.parse(c.validUntil));
  let chosen = windows.find(valid);
  if (modelsOf(fare).includes('COMBINING') && variants.has(booking, 'fare-wrong-combining-fee')) chosen = windows.find((c) => c !== chosen) || chosen;
  return chosen ? Math.min(chosen.afterSaleFee.amount, amount) : amount;
}

// What a part gives back: its fee and what is left of its price.
function refundOfPart(part, overruled, booking, nowMs) {
  const amount = priceOf(part).amount;
  let fee = 0;
  if (overruled) return { fee, refundable: amount };
  if (isFare(part)) fee = fareFee(part, booking, nowMs);
  else if (part.refundable === 'NO') fee = amount;
  else if (part.refundable === 'WITH_CONDITION') fee = Math.round(amount * SEMI_FLEXIBLE_FEE_SHARE);
  return { fee, refundable: amount - fee };
}

// #907: the fee a client states (RefundSpecification.refundFee), checked: a
// CurrencyAmount in the booking's currency. null when none is stated.
function statedFeeOf(spec, booking, provider) {
  const fee = spec?.refundFee;
  if (fee == null) return null;
  const ok = typeof fee === 'object' && Number.isInteger(fee.amount) && fee.amount >= 0 && fee.amount <= 1e9
    && fee.currency === currencyOf(booking, provider) && (fee.scale == null || fee.scale === 2);
  if (!ok) throw bad(`refundFee of fulfillment ${String(spec.fulfillmentId).slice(0, 80)} must be an amount in cents in ${currencyOf(booking, provider)}`);
  return fee.amount;
}

// #907: the fee stated applies to fares combined by CLUSTERING whose fee is the
// provider's, unless the wrong variant ignores it.
const takesStatedFee = (parts, booking) => parts.length > 0 && !variants.has(booking, 'fare-ignores-refund-fee')
  && parts.every((p) => isFare(p) && modelsOf(p).includes('CLUSTERING') && p.afterSalesCondition?.isProviderFee !== false);

// The fee stated, shared over the parts in their order, no part keeping more than its price.
function withStatedFee(items, fee) {
  let left = fee;
  return items.map((item) => {
    const amount = priceOf(item.part).amount;
    const kept = Math.min(left, amount);
    left -= kept;
    return { ...item, fee: kept, refundable: amount - kept };
  });
}

// The ids a request names, checked against the booking's fulfillments.
function requestedFulfillments(booking, body) {
  const ids = body.fulfillmentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_FULFILLMENT_IDS) {
    throw bad(`fulfillmentIds must hold 1 to ${MAX_FULFILLMENT_IDS} fulfillment ids`);
  }
  if (new Set(ids).size !== ids.length) throw bad('fulfillmentIds names a fulfillment twice');
  return ids.map((id, i) => {
    if (typeof id !== 'string') throw bad(`fulfillmentIds[${i}] is not text`);
    const fulfillment = booking.fulfillments.find((f) => f.id === id);
    if (!fulfillment) throw bad(`fulfillmentIds[${i}]: "${id.slice(0, 80)}" is not a fulfillment of this booking`);
    if (fulfillment.status === 'REFUNDED') throw conflict(`fulfillment ${fulfillment.id} is already refunded`);
    return fulfillment;
  });
}

// A refund by booking part or passenger is not offered: one refund offer
// always holds every part and passenger of its fulfillment.
function refuseScopedRefund(body, booking) {
  const specs = body.refundSpecifications;
  if (specs == null) return;
  if (!Array.isArray(specs)) throw bad('refundSpecifications is not a list');
  // #611: the per-passenger variant offers a refund scoped within a fulfillment.
  if (variants.has(booking, 'per-passenger')) return;
  // #697: so does a booking sold with tickets per passenger or per leg.
  if (ticketing.of(booking)) return;
  const scoped = specs.some((s) => (Array.isArray(s?.bookingPartIds) && s.bookingPartIds.length > 0)
    || (Array.isArray(s?.passengerIds) && s.passengerIds.length > 0));
  if (scoped) {
    throw new HttpError(400, 'PARTIAL_REFUND_NOT_SUPPORTED', 'Partial refund not supported',
      'A refund covers whole fulfillments: refund by booking part or by passenger is not offered. Name the fulfillments in fulfillmentIds.');
  }
}

function buildRefundOffer(booking, fulfillment, overruleCode, provider, nowMs, scoped = null, statedFee = null) {
  const partIds = new Set(scoped || fulfillment.bookingParts.map((p) => p.id));
  const parts = admissionsOf(booking).filter((a) => partIds.has(a.id));
  let items = parts.map((part) => ({ part, ...refundOfPart(part, !!overruleCode, booking, nowMs) }));
  if (statedFee !== null && !overruleCode && takesStatedFee(parts, booking)) items = withStatedFee(items, statedFee);
  const sum = (key) => items.reduce((total, item) => total + item[key], 0);
  return {
    id: `${provider.idPrefix}-RFO-${randomId()}`,
    summary: `Refund of ${fulfillment.summary || fulfillment.id}`,
    createdOn: new Date(nowMs).toISOString(),
    validFrom: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + lifetimeOf(booking, REFUND_OFFER_LIFETIME_MS)).toISOString(),
    status: 'PROPOSED',
    fulfillments: [{ id: fulfillment.id, status: fulfillment.status, bookingRef: booking.id, createdOn: fulfillment.createdOn, bookingParts: fulfillment.bookingParts }],
    refundFee: price(sum('fee'), currencyOf(booking, provider)),
    // #611: one cent off its breakdown in the wrong-refund-amount variant.
    refundableAmount: price(sum('refundable') + (variants.has(booking, 'wrong-refund-amount') ? 1 : 0), currencyOf(booking, provider)),
    refundOfferBreakdown: items.map((item) => ({
      refundFee: price(item.fee, currencyOf(booking, provider)),
      refundableAmount: price(item.refundable, currencyOf(booking, provider)),
      bookingParts: [{ id: item.part.id, summary: item.part.summary }],
    })),
    ...(overruleCode ? { appliedOverruleCode: overruleCode } : {}),
  };
}

// An overrule code is text the request gave; it is only ever sent back in JSON.
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

/**
 * POST /bookings/{id}/refund-offers: one refund offer per fulfillment named.
 * Only a confirmed booking has fulfillments to refund.
 */
function createRefundOffers(booking, body, provider, nowMs) {
  if (booking.fulfillments.length === 0) throw conflict('the booking is not confirmed: it has no fulfillment to refund');
  // #883: a provider seen refunding one fulfillment per request.
  if (variants.has(booking, 'one-fulfillment-per-refund-request') && Array.isArray(body.fulfillmentIds) && body.fulfillmentIds.length > 1) {
    throw new HttpError(501, 'VALUE_NOT_SUPPORTED', "Only one value is expected for the 'fulfillmentIds' parameter",
      'Ask one refund offer per fulfillment.');
  }
  refuseScopedRefund(body, booking);
  const overruleCode = overruleCodeOf(body, provider);
  const specs = Array.isArray(body.refundSpecifications) ? body.refundSpecifications : [];
  const offers = requestedFulfillments(booking, body).map((f) => {
    const spec = specs.find((s) => s?.fulfillmentId === f.id) || (specs.length === 1 && !specs[0]?.fulfillmentId ? specs[0] : null);
    const scoped = spec ? variants.scopedPartIds(booking, f, spec, admissionsOf(booking)) : null;
    if (scoped?.length === 0) throw bad(`the refund specification names no part of fulfillment ${f.id}`);
    return buildRefundOffer(booking, f, overruleCode, provider, nowMs, scoped, statedFeeOf(spec, booking, provider));
  });
  booking.refundOffers = [...(booking.refundOffers || []), ...offers];
  return offers;
}

function findRefundOffer(booking, refundOfferId) {
  const offer = (booking.refundOffers || []).find((o) => o.id === refundOfferId);
  if (!offer) throw notFound();
  return offer;
}

/**
 * PATCH .../refund-offers/{id} with { status: CONFIRMED }: refunds the
 * fulfillment the offer holds, its parts, and takes the amount off the
 * booking's confirmed price. Asked again, it answers the confirmed offer.
 */
function confirmRefundOffer(booking, refundOfferId, body, provider, nowMs) {
  const offer = findRefundOffer(booking, refundOfferId);
  if (body.status !== 'CONFIRMED') {
    throw bad(body.status === 'PROPOSED'
      ? 'a refund offer cannot be set back to PROPOSED'
      : 'status must be CONFIRMED');
  }
  if (offer.status === 'CONFIRMED') return offer;
  if (Date.parse(offer.validUntil) <= nowMs) throw conflict('the refund offer has expired');
  const confirmedOn = new Date(nowMs).toISOString();
  for (const held of offer.fulfillments) {
    const fulfillment = booking.fulfillments.find((f) => f.id === held.id);
    if (fulfillment.status === 'REFUNDED') throw conflict(`fulfillment ${fulfillment.id} is already refunded`);
  }
  // The parts the offer refunds: all of its fulfillment, or those a scoped
  // refund named (#611); the fulfillment is refunded once all its parts are.
  const refunded = new Set(offer.refundOfferBreakdown.flatMap((b) => b.bookingParts.map((p) => p.id)));
  for (const part of admissionsOf(booking)) {
    if (refunded.has(part.id)) part.status = 'REFUNDED';
  }
  for (const held of offer.fulfillments) {
    const fulfillment = booking.fulfillments.find((f) => f.id === held.id);
    const statusOf = new Map(admissionsOf(booking).map((p) => [p.id, p.status]));
    if (fulfillment.bookingParts.every((p) => statusOf.get(p.id) === 'REFUNDED')) fulfillment.status = 'REFUNDED';
    held.status = fulfillment.status;
  }
  offer.status = 'CONFIRMED';
  offer.confirmedOn = confirmedOn;
  // #603: the refund receipt appears in the booking some time later.
  noteRefund(booking, provider, nowMs);
  if (booking.confirmedPrice) {
    booking.confirmedPrice = price(booking.confirmedPrice.amount - offer.refundableAmount.amount, currencyOf(booking, provider));
  }
  return offer;
}

/** DELETE .../refund-offers/{id}: a proposed offer only; a confirmed refund stays. */
function deleteRefundOffer(booking, refundOfferId) {
  const offer = findRefundOffer(booking, refundOfferId);
  if (offer.status === 'CONFIRMED') throw conflict('a confirmed refund cannot be withdrawn');
  booking.refundOffers = booking.refundOffers.filter((o) => o !== offer);
}

module.exports = { createRefundOffers, findRefundOffer, confirmRefundOffer, deleteRefundOffer, REFUND_OFFER_LIFETIME_MS };
