// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reservations.js — seat reservations (#601).
 *
 * A provider whose profile lists `reservations` sells a seat reservation on
 * the trains of the categories it names: MANDATORY or OPTIONAL. On such a leg
 * an offer holds one reservation offer part for all its passengers together
 * (a collective reservation, on that leg only), and each admission of the
 * trip points to it with a relation whose `minGroupItemsToBeBooked` is 1 when
 * the reservation is mandatory, 0 when it is optional.
 *
 * A booking takes every mandatory reservation of its offers, and those the
 * request names, in `optionalReservationSelections` or in `placeSelections`.
 * A reservation can also be added to a pre-booked booking with
 * POST .../booked-offers/{bookedOfferId}/offer-parts. A booked reservation
 * carries the coach and seats it was given.
 *
 * On a trip from `placePreferences.from` (#766), a reservation part offers
 * the profile's place preferences (`availablePlacePreferences`, and the same
 * codes in `availablePlaces`) and takes the PREFERENCES flow too. A booking
 * that asks for some in `placeSelections[].accommodations[].placeProperties`
 * gets those it offers and has left (not `soldOut`), shown on its places.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const placeMap = require('./placeMap');

// The price of a reservation per passenger, in hundredths, before the
// provider's price factor.
const PRICE_PER_PASSENGER = 300;
const MAX_SELECTIONS = 12;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', detail);
const randomId = () => crypto.randomBytes(8).toString('hex');
const listOf = (value) => (Array.isArray(value) ? value : []);
// A SelectedAccommodation member that is text (#766).
const textOf = (value) => typeof value === 'string' && value.length > 0 && value.length <= 80;
const SEAT_AVAILABILITY = 40;

/** The place preferences of a trip's reservations, or null when it has none (#766). */
function preferencesOfTrip(trip, provider) {
  const prefs = provider.placePreferences;
  return prefs && trip.origin?.stopPlaceRef === prefs.from ? prefs : null;
}

/** Every place property a provider's preferences name. */
const preferenceCodes = (prefs) => prefs.groups.flatMap((g) => g.preferences);

/** The places still available for a reservation part: one SEAT / ANY_SEAT entry. */
function availablePlacesOf(part, prefs, { asked = false } = {}) {
  const codes = preferenceCodes(prefs).filter((code) => !asked || !prefs.soldOut.includes(code));
  return [{
    accommodationType: 'SEAT',
    accommodationSubType: 'ANY_SEAT',
    placeProperties: codes,
    numericAvailability: SEAT_AVAILABILITY,
    tripLegCoverage: { tripId: part.tripCoverage.coveredTripId, legId: part.tripCoverage.coveredLegIds[0] },
  }];
}

/** The reservation of a leg: MANDATORY, OPTIONAL, or null when its train has none. */
function reservationKind(leg, provider) {
  return provider.reservations?.[leg.timedLeg.service.productCategory?.shortName] || null;
}

/** The reservation product of a tariff's flexibility. */
function reservationProductOf(tariff, provider) {
  return {
    id: `${provider.idPrefix}-PRD-RES-${tariff.key}`,
    code: `${provider.idPrefix}_SEAT_RESERVATION_${tariff.key}`,
    summary: 'Seat reservation',
    type: 'RESERVATION',
    owner: provider.carrier.ref,
    flexibility: tariff.key,
    isTrainBound: true,
  };
}

/**
 * The reservations of one direction of an offer: for each leg whose train has
 * one, the reservation offer part, its product, and the relation an
 * admission of the trip carries to it.
 */
function reservationsOfDirection(trip, { passengers, tariff, provider, createdOn, price, fulfillmentOptions }) {
  const product = reservationProductOf(tariff, provider);
  return trip.legs.filter((leg) => reservationKind(leg, provider)).map((leg) => {
    const mandatory = reservationKind(leg, provider) === 'MANDATORY';
    const id = `${provider.idPrefix}-RES-${randomId()}`;
    const part = {
      objectType: 'ReservationOfferPart',
      id,
      summary: `Seat reservation, train ${leg.timedLeg.service.vehicleNumbers[0]}`,
      createdOn,
      validFrom: leg.timedLeg.start.serviceDeparture.timetabledTime,
      validUntil: leg.timedLeg.end.serviceArrival.timetabledTime,
      price: price(Math.round(PRICE_PER_PASSENGER * provider.priceFactor) * passengers.length),
      tripCoverage: { coveredTripId: trip.id, coveredLegIds: [leg.id] },
      offerMode: 'COLLECTIVE',
      isReusable: false,
      passengerRefs: passengers.map((p) => p.externalRef),
      refundable: tariff.refundable,
      exchangeable: tariff.exchangeable,
      summaryProductId: product.id,
      products: [{ productId: product.id, legIds: [leg.id] }],
      availableFulfillmentOptions: fulfillmentOptions,
      isReservationRequired: false,
      supportedPlaceSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'],
    };
    // #766 PR 3: a reservation on a trip with a place map takes the manual flows.
    if (placeMap.placeMapOfTrip(trip, provider)) part.supportedPlaceSelectionFlows.push('MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'MANUAL_PLACE_SELECTION_WITH_FEE');
    const prefs = preferencesOfTrip(trip, provider);
    if (prefs) {
      part.supportedPlaceSelectionFlows.push('AUTOMATIC_PLACE_SELECTION_PREFERENCES');
      part.availablePlacePreferences = [{ preferenceGroups: prefs.groups.map((g) => ({ preferenceGroup: g.preferenceGroup, preferences: [...g.preferences] })) }];
      part.availablePlaces = availablePlacesOf(part, prefs);
    }
    const relation = {
      isIncluded: false,
      minGroupItemsToBeBooked: mandatory ? 1 : 0,
      maxGroupItemsToBeBooked: 1,
      reservationGroup: { id: `${id}-GRP`, name: `Seat reservation on leg ${leg.id}`, reservationRefs: [{ id }] },
    };
    return { part, product, relation, mandatory };
  });
}

// The reservation ids a booking request names for one offer.
function namedReservations(selection) {
  const id = (value, where) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 120) throw bad(`${where}.reservationId is missing or not valid`);
    return value;
  };
  const chosen = listOf(selection?.optionalReservationSelections);
  const placed = listOf(selection?.placeSelections);
  if (chosen.length + placed.length > MAX_SELECTIONS) throw bad(`at most ${MAX_SELECTIONS} reservation and place selections per offer`);
  placed.forEach((s, i) => checkAccommodations(s?.accommodations, `placeSelections[${i}]`));
  return [
    ...chosen.map((s, i) => ({ id: id(s?.reservationId, `optionalReservationSelections[${i}]`) })),
    ...placed.map((s, i) => ({ id: id(s?.reservationId, `placeSelections[${i}]`), coverage: s.tripLegCoverage, where: `placeSelections[${i}]` })),
  ];
}

// #766: a SelectedAccommodation names its passengers, its accommodation type
// and sub-type (all three required by OSDM), and place properties as text.
function checkAccommodations(accommodations, where) {
  if (accommodations === undefined) return;
  if (!Array.isArray(accommodations) || accommodations.length > MAX_SELECTIONS) throw bad(`${where}.accommodations must be a list`);
  accommodations.forEach((a, j) => {
    const at = `${where}.accommodations[${j}]`;
    const refs = a?.passengerRefs;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every(textOf)) throw bad(`${at}.passengerRefs is missing or not valid`);
    if (!textOf(a.accommodationType) || !textOf(a.accommodationSubType)) throw bad(`${at} must name accommodationType and accommodationSubType`);
    const props = a.placeProperties;
    if (props != null && (!Array.isArray(props) || props.length > 20 || !props.every(textOf))) throw bad(`${at}.placeProperties is not valid`);
  });
}

/**
 * The place properties a booking request asks for a reservation (#766):
 * those of the accommodations of its placeSelections, each once.
 */
function propertiesAsked(selection, reservationId) {
  const asked = listOf(selection?.placeSelections)
    .filter((s) => s?.reservationId === reservationId)
    .flatMap((s) => listOf(s.accommodations))
    .flatMap((a) => listOf(a?.placeProperties));
  return [...new Set(asked)];
}

/**
 * The place properties a reservation is given (#766): those asked that its
 * trip's preferences offer and are not sold out; none when `ignore` (the
 * ignores-place-preferences variant) or the trip has no preferences.
 */
function propertiesGiven(asked, trip, provider, { ignore = false } = {}) {
  const prefs = trip ? preferencesOfTrip(trip, provider) : null;
  if (!prefs || ignore) return [];
  const codes = preferenceCodes(prefs);
  return asked.filter((code) => codes.includes(code) && !prefs.soldOut.includes(code));
}

/**
 * GET /availabilities/preferences (#766): the places still available for a
 * reservation part of a remembered offer. `found` is what was remembered of
 * the offer (or undefined).
 */
function preferenceAvailability(query, found, provider) {
  const contextId = query.get('contextId');
  const contextType = query.get('contextType');
  const resourceId = query.get('resourceId');
  const resourceType = query.get('resourceType');
  if (!contextId || !contextType || !resourceId || !resourceType) throw bad('contextId, contextType, resourceId and resourceType are required');
  if (contextType === 'BOOKING') throw new HttpError(501, 'NOT_IMPLEMENTED', 'Not implemented', 'This simulator gives the preferences of an offer only.');
  if (contextType !== 'OFFER') throw bad('contextType must be OFFER or BOOKING');
  if (resourceType !== 'RESERVATION') throw bad('resourceType must be RESERVATION');
  if (!found) throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found', 'The offer does not exist, has expired, or belongs to another client.');
  const part = listOf(found.offer.reservationOfferParts).find((p) => p.id === resourceId);
  if (!part) throw new HttpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found', `"${resourceId}" is not a reservation of offer ${contextId}.`);
  const trip = listOf(found.trips).find((t) => t.id === part.tripCoverage.coveredTripId);
  const prefs = trip ? preferencesOfTrip(trip, provider) : null;
  return { availablePlaces: prefs ? availablePlacesOf(part, prefs, { asked: true }) : [] };
}

// The reservation ids an offer's admissions make mandatory.
function mandatoryIds(offer) {
  return new Set(listOf(offer.admissionOfferParts)
    .flatMap((admission) => listOf(admission.reservations))
    .filter((relation) => relation.minGroupItemsToBeBooked > 0)
    .flatMap((relation) => relation.reservationGroup.reservationRefs.map((ref) => ref.id)));
}

/**
 * The reservation offer parts a booking takes from an offer: every mandatory
 * one, and those the request names. A name that is not one of the offer's
 * reservations, or a place selection whose trip and leg are not those of the
 * reservation, is refused.
 */
function reservationsToBook(offer, selection) {
  const parts = listOf(offer.reservationOfferParts);
  const named = namedReservations(selection);
  for (const { id, coverage, where } of named) {
    const part = parts.find((p) => p.id === id);
    if (!part) throw bad(`reservation "${id}" is not one of offer ${offer.offerId}`);
    const covered = part.tripCoverage;
    if (coverage && (coverage.tripId !== covered.coveredTripId || coverage.legId !== covered.coveredLegIds[0])) {
      throw bad(`${where}.tripLegCoverage is not the trip and leg of reservation "${id}"`);
    }
  }
  const mandatory = mandatoryIds(offer);
  const wanted = new Set(named.map((n) => n.id));
  return parts.filter((p) => mandatory.has(p.id) || wanted.has(p.id));
}

// The coach and seats a reservation is given: the same for the same part.
function placesOf(partId, count) {
  const seed = crypto.createHash('sha256').update(partId, 'utf8').digest();
  const coach = String(1 + (seed[0] % 9));
  const first = 11 + (seed[1] % 60);
  return { coachNumber: coach, placeNumbers: Array.from({ length: count }, (_, i) => String(first + i)) };
}

/** The booked reservation made from a reservation offer part. */
function reservationFrom(part, passengerIdOf, trips, createdOn, confirmableUntil, { placeProperties = [], named = null, fee = 0, otherPlace = false } = {}) {
  const tripId = part.tripCoverage.coveredTripId;
  const legId = part.tripCoverage.coveredLegIds[0];
  const leg = listOf(trips.find((t) => t.id === tripId)?.legs).find((l) => l.id === legId);
  const passengerIds = part.passengerRefs.map(passengerIdOf);
  // #766 PR 3: the places a booking named on the place map, else any.
  const given = named
    ? { coachNumber: placeMap.COACH, placeNumbers: named.places.map((n) => (otherPlace ? placeMap.otherPlace(n) : n)) }
    : placesOf(part.id, passengerIds.length);
  const { coachNumber, placeNumbers } = given;
  const charged = named ? { ...part.price, amount: part.price.amount + named.fees * fee } : part.price;
  return {
    objectType: 'Reservation',
    id: part.id,
    summary: part.summary,
    createdOn,
    confirmableUntil,
    validFrom: part.validFrom,
    validUntil: part.validUntil,
    price: charged,
    tripCoverage: part.tripCoverage,
    summaryProductId: part.summaryProductId,
    products: part.products,
    status: 'PREBOOKED',
    offerMode: part.offerMode,
    passengerIds,
    availableFulfillmentOptions: part.availableFulfillmentOptions,
    refundable: part.refundable,
    exchangeable: part.exchangeable,
    isReservationRequired: false,
    placeAllocation: {
      accommodationType: 'SEAT',
      accommodationSubType: named?.compartment ? 'COMPARTMENT' : 'ANY_SEAT',
      reservedPlaces: [{
        id: `${part.id}-PLACES`,
        passengerIds,
        vehicleNumber: leg?.timedLeg.service.vehicleNumbers[0] || '0',
        coachNumber,
        ...(named?.compartment ? { compartmentNumber: named.compartment } : {}),
        placeNumbers,
        ...(placeProperties.length > 0 ? { placeProperties: [...placeProperties] } : {}),
      }],
      tripLegCoverage: { tripId, legId },
    },
  };
}

/** Each admission of a booked offer points to the booked reservations of its trip. */
function linkReservations(bookedOffer) {
  for (const admission of bookedOffer.admissions) {
    const refs = bookedOffer.reservations
      .filter((r) => r.tripCoverage.coveredTripId === admission.tripCoverage?.coveredTripId)
      .map((r) => ({ id: r.id, summary: r.summary }));
    if (refs.length > 0) admission.reservationRefs = refs;
  }
}

module.exports = {
  reservationKind, reservationProductOf, reservationsOfDirection, reservationsToBook, reservationFrom, linkReservations,
  propertiesAsked, propertiesGiven, preferenceAvailability, PRICE_PER_PASSENGER,
};
