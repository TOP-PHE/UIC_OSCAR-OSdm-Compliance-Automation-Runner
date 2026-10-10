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
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');

const REFUND_OFFER_LIFETIME_MS = 30 * 60 * 1000;
const MAX_FULFILLMENT_IDS = 20;
const SEMI_FLEXIBLE_FEE_SHARE = 0.25;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The refund request is not valid', detail);
const conflict = (detail) => new HttpError(409, 'CONFLICT', 'Conflict', detail);
const notFound = () => new HttpError(404, 'RESOURCE_NOT_FOUND', 'Refund offer not found');
const randomId = () => crypto.randomBytes(8).toString('hex');

const admissionsOf = (booking) => booking.bookedOffers.flatMap((bookedOffer) => bookedOffer.admissions);
const price = (amount, currency) => ({ amount, currency, scale: 2 });

// What a part gives back: its fee and what is left of its price.
function refundOfPart(part, overruled) {
  const amount = part.price.amount;
  let fee = 0;
  if (overruled) return { fee, refundable: amount };
  if (part.refundable === 'NO') fee = amount;
  else if (part.refundable === 'WITH_CONDITION') fee = Math.round(amount * SEMI_FLEXIBLE_FEE_SHARE);
  return { fee, refundable: amount - fee };
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
function refuseScopedRefund(body) {
  const specs = body.refundSpecifications;
  if (specs == null) return;
  if (!Array.isArray(specs)) throw bad('refundSpecifications is not a list');
  const scoped = specs.some((s) => (Array.isArray(s?.bookingPartIds) && s.bookingPartIds.length > 0)
    || (Array.isArray(s?.passengerIds) && s.passengerIds.length > 0));
  if (scoped) {
    throw new HttpError(400, 'PARTIAL_REFUND_NOT_SUPPORTED', 'Partial refund not supported',
      'A refund covers whole fulfillments: refund by booking part or by passenger is not offered. Name the fulfillments in fulfillmentIds.');
  }
}

function buildRefundOffer(booking, fulfillment, overruleCode, provider, nowMs) {
  const partIds = new Set(fulfillment.bookingParts.map((p) => p.id));
  const parts = admissionsOf(booking).filter((a) => partIds.has(a.id));
  const items = parts.map((part) => ({ part, ...refundOfPart(part, !!overruleCode) }));
  const sum = (key) => items.reduce((total, item) => total + item[key], 0);
  return {
    id: `${provider.idPrefix}-RFO-${randomId()}`,
    summary: `Refund of ${fulfillment.summary || fulfillment.id}`,
    createdOn: new Date(nowMs).toISOString(),
    validFrom: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + REFUND_OFFER_LIFETIME_MS).toISOString(),
    status: 'PROPOSED',
    fulfillments: [{ id: fulfillment.id, status: fulfillment.status, bookingRef: booking.id, bookingParts: fulfillment.bookingParts }],
    refundFee: price(sum('fee'), provider.currency),
    refundableAmount: price(sum('refundable'), provider.currency),
    refundOfferBreakdown: items.map((item) => ({
      refundFee: price(item.fee, provider.currency),
      refundableAmount: price(item.refundable, provider.currency),
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
  refuseScopedRefund(body);
  const overruleCode = overruleCodeOf(body, provider);
  const offers = requestedFulfillments(booking, body).map((f) => buildRefundOffer(booking, f, overruleCode, provider, nowMs));
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
  for (const held of offer.fulfillments) {
    const fulfillment = booking.fulfillments.find((f) => f.id === held.id);
    fulfillment.status = 'REFUNDED';
    held.status = 'REFUNDED';
    const partIds = new Set(fulfillment.bookingParts.map((p) => p.id));
    for (const part of admissionsOf(booking)) {
      if (partIds.has(part.id)) part.status = 'REFUNDED';
    }
  }
  offer.status = 'CONFIRMED';
  offer.confirmedOn = confirmedOn;
  if (booking.confirmedPrice) {
    booking.confirmedPrice = price(booking.confirmedPrice.amount - offer.refundableAmount.amount, provider.currency);
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
