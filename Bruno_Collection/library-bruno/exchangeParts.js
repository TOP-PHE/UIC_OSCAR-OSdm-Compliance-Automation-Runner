// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * exchangeParts.js — which parts of a booking an exchange gave up and which
 * it added (#649). Pure: no bru, no test.
 *
 * Once an exchange is pre-booked, a provider may show the new booked offer in
 * the booking straight away (PREBOOKED), or only once it is confirmed. Either
 * way the booking then holds two sets of parts: the ones sold first, which the
 * original offer describes, and the new ones, which the exchange offer
 * describes. They are told apart by the part ids the booking had before the
 * exchange (`partIdsOf` at step 07); OSDM gives a booked offer no link back to
 * the offer it came from that every provider fills in the same way.
 */

const PART_LISTS = ['admissions', 'reservations', 'ancillaries'];

const bookingOf = (data) => (data && data.booking) ? data.booking : data;
const bookedOffersOf = (booking) => (booking && Array.isArray(booking.bookedOffers) ? booking.bookedOffers : []);

/** Every booked part id of a booking (or a response holding one). */
function partIdsOf(data) {
  const ids = [];
  for (const bookedOffer of bookedOffersOf(bookingOf(data))) {
    for (const list of PART_LISTS) {
      for (const part of (Array.isArray(bookedOffer?.[list]) ? bookedOffer[list] : [])) {
        if (part && part.id != null) ids.push(String(part.id));
      }
    }
  }
  return ids;
}

/**
 * Split a booking into the parts it held before the exchange and the parts
 * added since.
 *
 * @param {object} data        the GET booking response (or the booking)
 * @param {string[]} idsBefore the part ids before the exchange
 * @returns {{ original: object, added: object[] }}
 *   `original` is the response with only the parts held before (booked offers
 *   left with no part are dropped), in the shape the booking checks take;
 *   `added` lists the other parts, each with `list` (admissions, …).
 */
function splitExchangeBooking(data, idsBefore) {
  const before = new Set((Array.isArray(idsBefore) ? idsBefore : []).map(String));
  const booking = bookingOf(data) || {};
  const added = [];
  const keptOffers = [];
  for (const bookedOffer of bookedOffersOf(booking)) {
    const kept = { ...bookedOffer };
    let held = 0;
    for (const list of PART_LISTS) {
      if (!Array.isArray(bookedOffer[list])) continue;
      kept[list] = bookedOffer[list].filter((part) => {
        const old = part && before.has(String(part.id));
        if (!old && part) added.push({ list, part });
        return old;
      });
      held += kept[list].length;
    }
    if (held > 0) keptOffers.push(kept);
  }
  const keptBooking = { ...booking, bookedOffers: keptOffers };
  const original = (data && data.booking) ? { ...data, booking: keptBooking } : keptBooking;
  return { original, added };
}

/**
 * The checks of the parts an exchange added.
 *
 * @param {object[]} added           from splitExchangeBooking
 * @param {string[]} expectedStatus  e.g. ['PREBOOKED'], or ['FULFILLED', 'CONFIRMED']
 * @param {object}   o
 * @param {boolean}  o.confirmed     whether the exchange is confirmed: the new
 *                                   admissions must then be in the booking;
 *                                   before, a provider may not show them yet
 * @returns {{name: string, ok: boolean, message: string, level?: string}[]}
 */
function checkAddedParts(added, expectedStatus, { confirmed }) {
  const checks = [];
  const admissions = added.filter((a) => a.list === 'admissions');
  if (confirmed) {
    checks.push({
      name: 'The booking holds the admissions the exchange sold',
      ok: admissions.length > 0,
      message: 'no admission other than the ones given up is in the booking after the exchange was confirmed',
    });
  } else if (admissions.length === 0) {
    checks.push({
      name: 'The pre-booked exchange is shown in the booking',
      ok: false,
      level: 'info',
      message: 'the booking does not show the new booked offer yet; OSDM does not say whether it should before the confirmation',
    });
  }
  added.forEach(({ list, part }) => {
    const status = part.status;
    checks.push({
      name: `New ${list.replace(/s$/, '')} ${part.id} from the exchange is ${expectedStatus.join(' or ')} - actual: ${status}`,
      ok: expectedStatus.includes(status),
      message: `status ${status}, expected ${expectedStatus.join(' or ')}`,
    });
  });
  return checks;
}

module.exports = { partIdsOf, splitExchangeBooking, checkAddedParts };
