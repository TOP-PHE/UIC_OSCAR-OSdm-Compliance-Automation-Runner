// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * variants.js — answers that differ from the happy path (#611), so that the
 * WARNING and FAIL branches of the collection's validators run too.
 *
 * On a provider whose profile sets `variants`, a booking takes the variants
 * named by the last names of its passengers: "Simvariant-<name>", any case.
 * They hold for the life of the booking.
 *
 *   per-passenger           one fulfillment per passenger, and a refund
 *                           scoped by passenger or booking part is offered
 *   reordered               booked parts and passengers in the reverse order
 *   minimal                 optional members left out (bookingCode, summaries)
 *   main-passenger-only     a passenger other than the first cannot be
 *                           changed (400 BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE)
 *   main-names-only         only the first passenger's names are kept: no
 *                           date of birth, no contact, nothing for the others
 *   ignores-place-preferences the place properties asked are not given (#766)
 *   gives-other-place       a named place is moved to the next free seat (#766)
 *   ignores-reference-place the seats near a reference place are in another coach (#766)
 *   refuses-bare-place-selection a placeSelection asking nothing (no places,
 *                           compartments, reference place or accommodations)
 *                           is refused with 400 (#793): send none instead
 *   wrong-booking-price     provisionalPrice one cent off the sum of its parts
 *   wrong-fulfillment-status the fulfillments issued say AVAILABLE
 *   wrong-refund-amount     refundableAmount one cent off its breakdown
 *   wrong-exchange-amount   amountToBePaid one cent off its identity
 *
 * The four "wrong-" variants are deliberately wrong: each must make a check of
 * the collection fail. The offers of a trip from `variants.wrongOffersFrom`
 * are wrong too (minimalPrice one cent off), for the offer validators.
 */

const PREFIX = 'simvariant-';
const NAMES = new Set([
  'per-passenger', 'reordered', 'minimal', 'main-passenger-only', 'main-names-only', 'ignores-place-preferences', 'gives-other-place', 'ignores-reference-place', 'refuses-bare-place-selection',
  'wrong-booking-price', 'wrong-fulfillment-status', 'wrong-refund-amount', 'wrong-exchange-amount',
]);

const VARIANTS = Symbol('variants');

/** The variants a booking request names, on a provider that has them. */
function variantsOf(specs, provider) {
  const found = new Set();
  if (!provider.variants) return found;
  for (const spec of Array.isArray(specs) ? specs : []) {
    const name = typeof spec?.detail?.lastName === 'string' ? spec.detail.lastName.toLowerCase() : '';
    if (name.startsWith(PREFIX) && NAMES.has(name.slice(PREFIX.length))) found.add(name.slice(PREFIX.length));
  }
  return found;
}

function keepVariants(booking, variants) {
  Object.defineProperty(booking, VARIANTS, { value: variants });
}

const has = (booking, name) => booking[VARIANTS]?.has(name) === true;

/** What a variant changes in a booking just made. */
function shapeNewBooking(booking) {
  if (has(booking, 'reordered')) {
    for (const bookedOffer of booking.bookedOffers) bookedOffer.admissions.reverse();
    booking.passengers.reverse();
  }
  if (has(booking, 'minimal')) {
    delete booking.bookingCode;
    for (const bookedOffer of booking.bookedOffers) {
      delete bookedOffer.summary;
      for (const part of [...bookedOffer.admissions, ...(bookedOffer.reservations || [])]) delete part.summary;
    }
  }
  if (has(booking, 'wrong-booking-price')) booking.provisionalPrice.amount += 1;
  shapePassengers(booking);
}

/**
 * Some providers keep only the main passenger's first name and last name, and no date of
 * birth (main-names-only): what else a booking or an update gives is dropped.
 */
function shapePassengers(booking) {
  if (!has(booking, 'main-names-only')) return;
  booking.passengers.forEach((passenger, index) => {
    delete passenger.dateOfBirth;
    const { firstName, lastName } = passenger.detail || {};
    if (index === 0 && (firstName || lastName)) passenger.detail = { firstName, lastName };
    else delete passenger.detail;
  });
}

/** Some providers let only the main passenger be changed (main-passenger-only). */
const mayChangePassenger = (booking, passengerId) =>
  !has(booking, 'main-passenger-only') || booking.passengers[0]?.id === passengerId;

/** One group of parts per passenger, for the per-passenger variant. */
function groupsByPassenger(parts) {
  const groups = new Map();
  for (const part of parts) {
    const key = (part.passengerIds || []).join('+');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  return [...groups.values()];
}

/** The fulfillments a variant changes once issued. */
function shapeIssuedFulfillments(booking) {
  if (has(booking, 'wrong-fulfillment-status')) {
    for (const fulfillment of booking.fulfillments) fulfillment.status = 'AVAILABLE';
  }
}

/** The ids of the parts a refund specification names, within one fulfillment, or null when it names none. */
function scopedPartIds(booking, fulfillment, spec, parts) {
  const held = new Set(fulfillment.bookingParts.map((p) => p.id));
  const byPart = Array.isArray(spec?.bookingPartIds) ? spec.bookingPartIds.filter((id) => typeof id === 'string') : [];
  const byPassenger = Array.isArray(spec?.passengerIds) ? spec.passengerIds.filter((id) => typeof id === 'string') : [];
  if (byPart.length === 0 && byPassenger.length === 0) return null;
  return parts
    .filter((p) => held.has(p.id))
    .filter((p) => byPart.length === 0 || byPart.includes(p.id))
    .filter((p) => byPassenger.length === 0 || (p.passengerIds || []).some((id) => byPassenger.includes(id)))
    .map((p) => p.id);
}

module.exports = {
  variantsOf, keepVariants, has, shapeNewBooking, shapePassengers, mayChangePassenger, groupsByPassenger, shapeIssuedFulfillments, scopedPartIds,
};
