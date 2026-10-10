// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bookings.js — a booking, from its creation to its tickets.
 *
 * A booking is made from offers this client was given, is PREBOOKED until
 * POST .../fulfillments confirms it, and is FULFILLED afterwards. Text that
 * came with a request (names, e-mail, phone) is kept as given, within a length
 * limit, and is only ever sent back inside JSON.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { cardsOf } = require('./reductionCards');

const MAX_OFFERS_PER_BOOKING = 4;
const MAX_PASSENGERS = 19;
const MAX_TEXT = 200;
const CONFIRMATION_DELAY_MS = 30 * 60 * 1000;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', detail);
const randomId = () => crypto.randomBytes(8).toString('hex');
const text = (value) => (typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined);

// Copy only the fields named, and only when they are text within the limit.
function pick(source, fields) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const field of fields) {
    const value = text(source[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function personDetail(source) {
  const detail = pick(source, ['firstName', 'lastName', 'email', 'phoneNumber', 'preferredLanguage']);
  const contact = pick(source?.contact, ['email', 'phoneNumber']);
  if (Object.keys(contact).length > 0) detail.contact = contact;
  return detail;
}

function passengerFrom(spec, externalRef, provider) {
  const passenger = {
    id: `${provider.idPrefix}-PAX-${randomId()}`,
    externalRef,
    type: text(spec?.type) || 'PERSON',
  };
  if (typeof spec?.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec.dateOfBirth)) passenger.dateOfBirth = spec.dateOfBirth;
  const gender = text(spec?.gender);
  if (gender) passenger.gender = gender;
  const detail = personDetail(spec?.detail);
  if (Object.keys(detail).length > 0) passenger.detail = detail;
  // #597: the passenger keeps the cards the booking request gave.
  const cards = cardsOf(spec, `passengerSpecifications[${externalRef}]`);
  if (cards.length > 0) passenger.cards = cards;
  return passenger;
}

// A booking whose tickets are one for every direction (#599, a weekend group):
// a hidden property, never sent back with the booking.
const ONE_FULFILLMENT = Symbol('one fulfillment');

const sumOf = (prices, currency) => ({ amount: prices.reduce((total, p) => total + p.amount, 0), currency, scale: 2 });
const admissionsOf = (booking) => booking.bookedOffers.flatMap((bookedOffer) => bookedOffer.admissions);

// What was remembered of the offer a booking request selects. Refused when the
// offer is unknown to this client or can no longer be booked.
function bookableOffer(selection, findOffer, nowMs) {
  const found = typeof selection?.offerId === 'string' ? findOffer(selection.offerId) : undefined;
  if (!found) {
    throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found', 'The offer does not exist, has expired, or belongs to another client.');
  }
  if (Date.parse(found.offer.preBookableUntil) <= nowMs) {
    throw new HttpError(409, 'OFFER_EXPIRED', 'Offer expired', 'This offer can no longer be booked.');
  }
  return found;
}

// The booked part made from one admission part of an offer.
function admissionFrom(part, passengers, createdOn, confirmableUntil) {
  return {
    objectType: 'Admission',
    id: part.id,
    summary: part.summary,
    createdOn,
    confirmableUntil,
    validFrom: part.validFrom,
    validUntil: part.validUntil,
    price: part.price,
    tripCoverage: part.tripCoverage,
    summaryProductId: part.summaryProductId,
    products: part.products,
    status: 'PREBOOKED',
    offerMode: part.offerMode,
    passengerIds: part.passengerRefs.map((externalRef) => passengers.get(externalRef).id),
    availableFulfillmentOptions: part.availableFulfillmentOptions,
    refundable: part.refundable,
    exchangeable: part.exchangeable,
    isReservationRequired: false,
    ...(part.appliedPassengerTypes ? { appliedPassengerTypes: part.appliedPassengerTypes } : {}),
  };
}

/**
 * A new PREBOOKED booking. `findOffer(offerId)` gives what was remembered of an
 * offer of this client, or undefined.
 */
function createBooking(body, findOffer, provider, nowMs) {
  const selections = body.offers;
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > MAX_OFFERS_PER_BOOKING) {
    throw bad(`offers must hold 1 to ${MAX_OFFERS_PER_BOOKING} offers`);
  }
  const specs = Array.isArray(body.passengerSpecifications) ? body.passengerSpecifications : [];
  if (specs.length > MAX_PASSENGERS) throw bad(`at most ${MAX_PASSENGERS} passengerSpecifications`);
  const specByRef = new Map(specs.filter((s) => typeof s?.externalRef === 'string').map((s) => [s.externalRef, s]));

  const createdOn = new Date(nowMs).toISOString();
  const confirmableUntil = new Date(nowMs + CONFIRMATION_DELAY_MS).toISOString();
  const passengers = new Map();
  const trips = new Map();
  const bookedOffers = [];

  let oneFulfillment = true;
  for (const selection of selections) {
    const { offer, trips: offerTrips, oneFulfillment: single } = bookableOffer(selection, findOffer, nowMs);
    oneFulfillment = oneFulfillment && single === true;
    for (const trip of offerTrips) trips.set(trip.id, trip);
    for (const externalRef of offer.passengerRefs) {
      if (!passengers.has(externalRef)) passengers.set(externalRef, passengerFrom(specByRef.get(externalRef), externalRef, provider));
    }
    const bookedOffer = {
      offerId: offer.offerId,
      summary: offer.summary,
      tripCoverage: offer.tripCoverage,
      products: offer.products,
      admissions: offer.admissionOfferParts.map((part) => admissionFrom(part, passengers, createdOn, confirmableUntil)),
      reservations: [],
      ancillaries: [],
    };
    if (offer.inboundTripCoverage) bookedOffer.inboundTripCoverage = offer.inboundTripCoverage;
    bookedOffers.push(bookedOffer);
  }

  const booking = {
    id: `${provider.idPrefix}-BKG-${randomId()}`,
    bookingCode: `${provider.idPrefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    createdOn,
    passengers: [...passengers.values()],
    purchaser: { detail: personDetail(body.purchaser?.detail) },
    bookedOffers,
    trips: [...trips.values()],
    confirmationTimeLimit: confirmableUntil,
    fulfillments: [],
  };
  const externalRef = text(body.externalRef);
  if (externalRef) booking.externalRef = externalRef;
  booking.provisionalPrice = sumOf(admissionsOf(booking).map((a) => a.price), provider.currency);
  Object.defineProperty(booking, ONE_FULFILLMENT, { value: oneFulfillment });
  return booking;
}

// The admissions grouped by the trip they cover, in the booking's trip order:
// one ticket per direction of a return (#594), one for a single journey.
function admissionsByTrip(booking) {
  const groups = new Map(booking.trips.map((trip) => [trip.id, []]));
  for (const admission of admissionsOf(booking)) {
    const tripId = admission.tripCoverage?.coveredTripId;
    if (!groups.has(tripId)) groups.set(tripId, []);
    groups.get(tripId).push(admission);
  }
  return [...groups.values()].filter((group) => group.length > 0);
}

/**
 * Confirm the booking and issue its fulfilments, one per trip it covers, or
 * one for the whole booking when its offers are sold so (#599).
 * Asked again on a booking that is already confirmed, it gives the fulfilments
 * it issued the first time.
 */
function confirmBooking(booking, provider, nowMs) {
  if (booking.fulfillments.length > 0) return booking.fulfillments;
  if (Date.parse(booking.confirmationTimeLimit) <= nowMs) {
    throw new HttpError(409, 'BOOKING_EXPIRED', 'Booking expired', 'The time limit to confirm this booking has passed.');
  }
  const confirmedOn = new Date(nowMs).toISOString();
  const admissions = admissionsOf(booking);
  for (const admission of admissions) {
    admission.status = 'FULFILLED';
    admission.confirmedOn = confirmedOn;
    delete admission.confirmableUntil;
  }
  booking.confirmedPrice = sumOf(admissions.map((a) => a.price), provider.currency);
  booking.provisionalPrice = { amount: 0, currency: provider.currency, scale: 2 };
  delete booking.confirmationTimeLimit;
  const groups = booking[ONE_FULFILLMENT] ? [admissions] : admissionsByTrip(booking);
  booking.fulfillments = groups.map((group) => ({
    id: `${provider.idPrefix}-FUL-${randomId()}`,
    status: 'FULFILLED',
    bookingRef: booking.id,
    summary: `${provider.name} ticket`,
    createdOn: confirmedOn,
    controlNumber: String(crypto.randomInt(1000000000, 9999999999)),
    issuer: provider.carrier.ref,
    bookingParts: group.map((a) => ({ id: a.id, summary: a.summary })),
  }));
  return booking.fulfillments;
}

function findPassenger(booking, passengerId) {
  const passenger = booking.passengers.find((p) => p.id === passengerId);
  if (!passenger) throw new HttpError(404, 'PASSENGER_NOT_FOUND', 'Passenger not found');
  return passenger;
}

// PATCH of a passenger: the fields a sale changes, nothing else. The id, the
// external reference and the type stay what the booking gave them.
function patchPassenger(booking, passengerId, body) {
  const passenger = findPassenger(booking, passengerId);
  if (typeof body.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dateOfBirth)) passenger.dateOfBirth = body.dateOfBirth;
  const gender = text(body.gender);
  if (gender) passenger.gender = gender;
  if (body.detail && typeof body.detail === 'object') {
    const detail = { ...passenger.detail, ...personDetail(body.detail) };
    if (Object.keys(detail).length > 0) passenger.detail = detail;
  }
  return passenger;
}

function setPurchaser(booking, body) {
  booking.purchaser = { detail: { ...booking.purchaser?.detail, ...personDetail(body.detail) } };
  return booking.purchaser;
}

module.exports = { createBooking, confirmBooking, findPassenger, patchPassenger, setPurchaser };
