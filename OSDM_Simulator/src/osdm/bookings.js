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
const { reservationsToBook, reservationFrom, linkReservations, propertiesAsked, propertiesGiven } = require('./reservations');
const placeMap = require('./placeMap');

/**
 * How a reservation is booked from a request (#766): the place properties it
 * is given, and on a trip with a place map the places it names, the selection
 * fee and whether the gives-other-place variant moves it.
 */
function reservationOptions(part, selection, trips, provider, chosen) {
  const trip = trips.find((t) => t.id === part.tripCoverage.coveredTripId);
  const named = placeMap.placeMapOfTrip(trip, provider) ? placeMap.namedPlacesOf(selection, part.id) : null;
  if (named && !named.compartment && named.places.length !== part.passengerRefs.length) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', `reservation "${part.id}" holds ${part.passengerRefs.length} passenger(s) and names ${named.places.length} place(s)`);
  }
  const near = placeMap.placeMapOfTrip(trip, provider) ? placeMap.referenceOf(selection, part.id) : null;
  return {
    onMap: !!placeMap.placeMapOfTrip(trip, provider),
    placeProperties: propertiesGiven(propertiesAsked(selection, part.id), trip, provider, { ignore: chosen.has('ignores-place-preferences') }),
    named,
    fee: named ? placeMap.feeOf(provider) : 0,
    otherPlace: chosen.has('gives-other-place'),
    near,
    ignoreReference: chosen.has('ignores-reference-place'),
  };
}
const { issueDocuments } = require('./documents');
const variants = require('./variants');
const persons = require('./persons');
const ticketing = require('./ticketing');

const MAX_OFFERS_PER_BOOKING = 4;
const MAX_PASSENGERS = 19;
const MAX_TEXT = 200;
const CONFIRMATION_DELAY_MS = 30 * 60 * 1000;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', detail);

const hasItems = (v) => Array.isArray(v) && v.length > 0;

// #793: a placeSelection naming only its reservation and leg asks nothing.
function refuseBarePlaceSelections(selections) {
  for (const selection of selections) {
    const placeSelections = Array.isArray(selection?.placeSelections) ? selection.placeSelections : [];
    const bare = placeSelections.find((p) => !hasItems(p?.places) && !hasItems(p?.compartments) && !hasItems(p?.accommodations)
      && !(p?.referencePlace && typeof p.referencePlace === 'object'));
    if (bare) throw bad(`placeSelections: the selection of reservation "${bare.reservationId}" names no place, compartment, reference place or accommodation; send no placeSelection to have the place given`);
  }
}
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
// #611: how long what is made from a short-deadline booking lasts, or null.
const SHORT_LIVED = Symbol('short lived');

/** The lifetime of an offer made from this booking (refund): short or the default. */
const lifetimeOf = (booking, defaultMs) => booking[SHORT_LIVED] || defaultMs;

const sumOf = (prices, currency) => ({ amount: prices.reduce((total, p) => total + p.amount, 0), currency, scale: 2 });
// #781: a booking is in the currency its offers were sold in.
const currencyOf = (booking, provider) => partsOf(booking).find((p) => p.price?.currency)?.price.currency || provider.currency;
// Every part of a booking: its admissions and, since #601, its reservations.
const partsOf = (booking) => booking.bookedOffers.flatMap((bookedOffer) => [...bookedOffer.admissions, ...bookedOffer.reservations]);

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
    // #601: as the offer said (true when a reservation is mandatory).
    isReservationRequired: part.isReservationRequired === true,
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
  // #611: a booking of short-lived offers is short-lived too.
  const shortLivedMs = selections.map((s) => (typeof s?.offerId === 'string' ? findOffer(s.offerId)?.shortLivedMs : null))
    .find((ms) => typeof ms === 'number') || null;
  const confirmableUntil = new Date(nowMs + (shortLivedMs || CONFIRMATION_DELAY_MS)).toISOString();
  const passengers = new Map();
  const trips = new Map();
  const bookedOffers = [];

  let oneFulfillment = true;
  // #766: the variants that change the places given.
  const chosenVariants = variants.variantsOf(specs, provider);
  // #793: a provider refusing a placeSelection that asks nothing.
  if (chosenVariants.has('refuses-bare-place-selection')) refuseBarePlaceSelections(selections);
  for (const selection of selections) {
    const { offer, trips: offerTrips, oneFulfillment: single } = bookableOffer(selection, findOffer, nowMs);
    const reserved = reservationsToBook(offer, selection);
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
      reservations: reserved.map((part) => reservationFrom(part, (ref) => passengers.get(ref).id, offerTrips, createdOn, confirmableUntil,
        reservationOptions(part, selection, offerTrips, provider, chosenVariants))),
      ancillaries: [],
    };
    linkReservations(bookedOffer);
    if (offer.inboundTripCoverage) bookedOffer.inboundTripCoverage = offer.inboundTripCoverage;
    bookedOffers.push(bookedOffer);
  }

  const booking = {
    id: `${provider.idPrefix}-BKG-${randomId()}`,
    bookingCode: `${provider.idPrefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    createdOn,
    passengers: [...passengers.values()],
    bookedOffers,
    trips: [...trips.values()],
    confirmationTimeLimit: confirmableUntil,
    fulfillments: [],
  };
  // #611: a booking made without its purchaser has none until one is written.
  if (body.purchaser !== undefined) booking.purchaser = { detail: personDetail(body.purchaser?.detail) };
  const externalRef = text(body.externalRef);
  if (externalRef) booking.externalRef = externalRef;
  booking.provisionalPrice = sumOf(partsOf(booking).map((a) => a.price), currencyOf(booking, provider));
  Object.defineProperty(booking, ONE_FULFILLMENT, { value: oneFulfillment });
  Object.defineProperty(booking, SHORT_LIVED, { value: shortLivedMs });
  // #611: a booking of offers that asked for information keeps asking while it is missing.
  persons.markRequestedInformation(booking, selections.some((s) => typeof s?.offerId === 'string' && findOffer(s.offerId)?.asksInfo));
  persons.showRequestedInformation(booking);
  // #611: the variants its passengers' last names name.
  variants.keepVariants(booking, variants.variantsOf(specs, provider));
  variants.shapeNewBooking(booking);
  // #697: tickets per passenger or per leg, from the trips' stop place.
  ticketing.keep(booking, ticketing.modeOf(booking.trips, provider));
  return booking;
}

// The admissions grouped by the trip they cover, in the booking's trip order:
// one ticket per direction of a return (#594), one for a single journey.
function admissionsByTrip(booking) {
  const groups = new Map(booking.trips.map((trip) => [trip.id, []]));
  for (const part of partsOf(booking)) {
    const tripId = part.tripCoverage?.coveredTripId;
    if (!groups.has(tripId)) groups.set(tripId, []);
    groups.get(tripId).push(part);
  }
  return [...groups.values()].filter((group) => group.length > 0);
}

/**
 * Confirm the booking and issue its fulfilments, one per trip it covers, or
 * one for the whole booking when its offers are sold so (#599).
 * Asked again on a booking that is already confirmed, it gives the fulfilments
 * it issued the first time.
 */
/**
 * #611: a pre-booked booking whose time limit has passed has its parts
 * RELEASED, as a read of it shows. True when it is (now) expired.
 */
function releaseIfExpired(booking, nowMs) {
  if (booking.fulfillments.length > 0 || !booking.confirmationTimeLimit) return false;
  if (Date.parse(booking.confirmationTimeLimit) > nowMs) return false;
  for (const part of partsOf(booking)) {
    if (part.status === 'PREBOOKED') part.status = 'RELEASED';
  }
  return true;
}

function confirmBooking(booking, provider, nowMs) {
  if (booking.fulfillments.length > 0) return booking.fulfillments;
  if (releaseIfExpired(booking, nowMs)) {
    throw new HttpError(409, 'BOOKING_EXPIRED', 'Booking expired', 'The time limit to confirm this booking has passed.');
  }
  const confirmedOn = new Date(nowMs).toISOString();
  const admissions = partsOf(booking);
  for (const admission of admissions) {
    admission.status = 'FULFILLED';
    admission.confirmedOn = confirmedOn;
    delete admission.confirmableUntil;
  }
  booking.confirmedPrice = sumOf(admissions.map((a) => a.price), currencyOf(booking, provider));
  booking.provisionalPrice = { amount: 0, currency: currencyOf(booking, provider), scale: 2 };
  delete booking.confirmationTimeLimit;
  let groups = booking[ONE_FULFILLMENT] ? [admissions] : admissionsByTrip(booking);
  if (variants.has(booking, 'per-passenger')) groups = variants.groupsByPassenger(admissions);
  else if (ticketing.of(booking)) groups = ticketing.groupsOf(admissions, ticketing.of(booking));
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
  // #603: the documents of the media asked for, when the provider issues them.
  if (provider.documents) issueDocuments(booking, provider);
  variants.shapeIssuedFulfillments(booking);
  return booking.fulfillments;
}

/**
 * POST .../booked-offers/{bookedOfferId}/offer-parts (#601): a reservation of
 * the booked offer, added while the booking is pre-booked. The request names
 * the offer and, in placeSelections, the reservations.
 */
function addOfferParts(booking, bookedOfferId, body, findOffer, provider) {
  const bookedOffer = booking.bookedOffers.find((o) => o.offerId === bookedOfferId);
  if (!bookedOffer) throw new HttpError(404, 'BOOKED_OFFER_NOT_FOUND', 'Booked offer not found');
  if (booking.fulfillments.length > 0) throw new HttpError(409, 'BOOKING_CONFIRMED', 'Booking confirmed', 'A part can be added to a pre-booked booking only.');
  if (body.offerId !== bookedOfferId) throw bad('offerId must be the offer of the booked offer');
  if (Array.isArray(body.ancillaryOfferIds) && body.ancillaryOfferIds.length > 0) {
    throw new HttpError(501, 'NOT_IMPLEMENTED', 'Not implemented', 'This simulator adds reservations only.');
  }
  if (!Array.isArray(body.placeSelections) || body.placeSelections.length === 0) throw bad('placeSelections must name the reservations to add');
  const found = findOffer(bookedOfferId);
  if (!found) throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found', 'The offer does not exist, has expired, or belongs to another client.');
  const already = new Set(bookedOffer.reservations.map((r) => r.id));
  const wanted = reservationsToBook({ ...found.offer, admissionOfferParts: [] }, { placeSelections: body.placeSelections });
  const added = wanted.filter((part) => !already.has(part.id));
  if (added.length === 0) throw new HttpError(409, 'ALREADY_BOOKED', 'Already booked', 'The reservations named are already in the booking.');
  const passengerIdOf = (ref) => booking.passengers.find((p) => p.externalRef === ref)?.id;
  const createdOn = new Date().toISOString();
  const kept = new Set(['ignores-place-preferences', 'gives-other-place', 'ignores-reference-place'].filter((name) => variants.has(booking, name)));
  bookedOffer.reservations.push(...added.map((part) => reservationFrom(part, passengerIdOf, found.trips, createdOn, booking.confirmationTimeLimit,
    reservationOptions(part, body, found.trips, provider, kept))));
  linkReservations(bookedOffer);
  booking.provisionalPrice = sumOf(partsOf(booking).map((a) => a.price), booking.provisionalPrice.currency);
  return { bookedOffers: [bookedOffer] };
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

/**
 * #611: the booked offer an exchange adds, made from a remembered offer for
 * the passengers the booking already has. Its mandatory reservations come
 * with it, as in a booking.
 */
function exchangedBookedOffer(booking, entry, nowMs) {
  const { offer, trips } = entry;
  const passengers = new Map(booking.passengers.map((p) => [p.externalRef, p]));
  const createdOn = new Date(nowMs).toISOString();
  for (const trip of trips) {
    if (!booking.trips.some((t) => t.id === trip.id)) booking.trips.push(trip);
  }
  const bookedOffer = {
    offerId: offer.offerId,
    summary: offer.summary,
    tripCoverage: offer.tripCoverage,
    products: offer.products,
    admissions: offer.admissionOfferParts.map((part) => admissionFrom(part, passengers, createdOn, undefined)),
    reservations: reservationsToBook(offer, {}).map((part) => reservationFrom(part, (ref) => passengers.get(ref).id, trips, createdOn, undefined)),
    ancillaries: [],
  };
  linkReservations(bookedOffer);
  return bookedOffer;
}

module.exports = { createBooking, confirmBooking, releaseIfExpired, addOfferParts, findPassenger, patchPassenger, setPurchaser, exchangedBookedOffer, lifetimeOf, currencyOf };
