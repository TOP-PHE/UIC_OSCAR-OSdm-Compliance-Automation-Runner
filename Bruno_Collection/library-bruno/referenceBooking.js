/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * referenceBooking.js — the reference place of the NEARBY flow taken from a
 * first booking (#776).
 *
 * A coach and place number cannot be written into a scenario: they belong to
 * one train of one provider. With `referencePlace` empty or "AUTO", the run
 * books the trip first for the first passenger alone (passenger A), on an
 * offer asked for that passenger only, with a reservation. The place A is
 * given is a real place of that train, and it is taken: the sale of the
 * scenario then asks for places near it, as a traveller joining a friend
 * would. A's booking is deleted once the scenario's booking has been
 * answered.
 *
 * Pure module: no Bruno globals.
 */

const sr = require('./seatReservations.js');
const { matchingOffer } = require('./idempotency.js');

const listOf = (value) => (Array.isArray(value) ? value : []);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** Whether the scenario takes its reference place from a first booking: the NEARBY flow, `referencePlace` empty or "AUTO". */
function isAutoReference(scenario) {
  if (String(scenario?.placeSelectionFlow ?? '').trim().toUpperCase() !== 'AUTOMATIC_PLACE_SELECTION_NEARBY') return false;
  const value = scenario?.referencePlace;
  return value === undefined || value === null || (typeof value === 'string' && ['', 'AUTO'].includes(value.trim().toUpperCase()));
}

/**
 * Step 01's offer request for the first passenger alone: `{ body, passengerRef }`,
 * or null when the request names no passenger.
 */
function referenceOfferRequest(request) {
  const key = ['anonymousPassengerSpecifications', 'passengerSpecifications'].find((k) => listOf(request?.[k]).length > 0);
  if (!key) return null;
  const first = request[key][0];
  if (!isText(first?.externalRef)) return null;
  return { body: { ...request, [key]: [first] }, passengerRef: first.externalRef };
}

/**
 * The offer to book for passenger A: among those holding a reservation part,
 * the one standing for the scenario's chosen offer (same flexibility and
 * travel class, then price). `{ offer, how }`, or null when no offer holds one.
 */
function referenceOffer(chosen, offers) {
  const withReservation = listOf(offers).filter((o) => listOf(o?.reservationOfferParts).length > 0);
  return withReservation.length > 0 ? matchingOffer(chosen, withReservation) : null;
}

/**
 * The booking request of passenger A: every reservation part of the offer, in
 * placeSelections where its leg can be told, else in
 * optionalReservationSelections. `passenger` is A's booking specification
 * (its externalRef is the offer's), `purchaser` the scenario's.
 */
function referenceBookingRequest({ offer, trips, passenger, purchaser, passengerRef }) {
  const ids = listOf(offer?.reservationOfferParts).map((p) => p?.id).filter(Boolean);
  if (!offer?.offerId || ids.length === 0 || !passenger) return null;
  const tripLegs = sr.tripLegsOf(trips);
  const placeSelections = sr.placeSelectionsFor(offer, ids, tripLegs);
  const optional = sr.reservationsWithoutLeg(offer, ids, tripLegs).map((reservationId) => ({ reservationId }));
  const booked = { offerId: offer.offerId, passengerRefs: [passengerRef] };
  if (placeSelections.length > 0) booked.placeSelections = placeSelections;
  if (optional.length > 0) booked.optionalReservationSelections = optional;
  const body = { offers: [booked], passengerSpecifications: [{ ...passenger, externalRef: passengerRef }] };
  if (purchaser) body.purchaser = purchaser;
  return body;
}

/**
 * The place passenger A was given: `{ bookingId, coachNumber, placeNumber }`,
 * or `{ bookingId, missing }` saying why there is none.
 */
function placeOfReferenceBooking(answer) {
  const booking = answer?.booking || answer;
  const bookingId = isText(booking?.id) ? booking.id : null;
  const reservations = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.reservations));
  if (reservations.length === 0) return { bookingId, missing: 'the booking holds no reservation' };
  for (const r of reservations) {
    for (const p of listOf(r?.placeAllocation?.reservedPlaces)) {
      const placeNumber = listOf(p?.placeNumbers).find(isText);
      if (isText(p?.coachNumber) && placeNumber) return { bookingId, coachNumber: p.coachNumber, placeNumber };
    }
  }
  return { bookingId, missing: 'its reservation names no coach and place number' };
}

module.exports = { isAutoReference, referenceOfferRequest, referenceOffer, referenceBookingRequest, placeOfReferenceBooking };
