// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * placeMap.js — a named place, chosen on the vehicle's place map (#766 PR 3).
 *
 * On a trip from `placeMap.from`, a reservation part takes the two manual
 * flows too, and POST /availabilities/vehicle-place-map gives one coach of
 * the train:
 *
 *   open saloon   seats 11–30, 11 and 12 taken (ALLOCATED), 21–24 with a
 *                 selection fee
 *   compartment   C1, seats 61–64, selectable as a whole only
 *
 * A booking may name places (`placeSelections[].places`) or the compartment
 * (`placeSelections[].compartments`). A place that is not on the map, taken,
 * or named twice is refused (409 PLACE_NOT_AVAILABLE). The booked reservation
 * gives the places named, and its price carries the selection fee of each
 * fee seat. The `gives-other-place` variant gives the next seat instead.
 */

const { HttpError } = require('../http');

const COACH = '7';
const LAYOUT = 'GAMMA-L7';
const SALOON = Array.from({ length: 20 }, (_, i) => String(11 + i));
const TAKEN = new Set(['11', '12']);
const FEE_SEATS = new Set(['21', '22', '23', '24']);
const COMPARTMENT = { number: 'C1', places: ['61', '62', '63', '64'] };
const MAX_RESTRICTIONS = 12;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', detail);
const notAvailable = (detail) => new HttpError(409, 'PLACE_NOT_AVAILABLE', 'Place not available', detail);
const listOf = (value) => (Array.isArray(value) ? value : []);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;

/** The place map of a trip, or null when it has none. */
function placeMapOfTrip(trip, provider) {
  const map = provider.placeMap;
  return map && trip?.origin?.stopPlaceRef === map.from ? map : null;
}

/** The selection fee of one seat, in hundredths, before nothing else. */
const feeOf = (provider) => Math.round(provider.placeMap.fee * provider.priceFactor);

/**
 * POST /availabilities/vehicle-place-map: the coach, for the reservations
 * the restrictions name (offers of this client only). `findOffer(id)` gives
 * what was remembered of an offer.
 */
function vehiclePlaceMap(body, findOffer, provider, price) {
  const restrictions = listOf(body?.placeRestrictions);
  if (restrictions.length === 0 || restrictions.length > MAX_RESTRICTIONS) throw bad(`placeRestrictions must hold 1 to ${MAX_RESTRICTIONS} entries`);
  const refs = restrictions.map((r, i) => {
    const ref = r?.reservationRef;
    if (!ref || !text(ref.contextId) || !text(ref.resourceId)) throw bad(`placeRestrictions[${i}].reservationRef is missing or not valid`);
    if (ref.contextType === 'BOOKING') throw new HttpError(501, 'NOT_IMPLEMENTED', 'Not implemented', 'This simulator gives the place map of an offer only.');
    if (ref.contextType !== 'OFFER' || ref.resourceType !== 'RESERVATION') throw bad(`placeRestrictions[${i}].reservationRef must be an OFFER and a RESERVATION`);
    const found = findOffer(ref.contextId);
    if (!found) throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found', 'The offer does not exist, has expired, or belongs to another client.');
    const part = listOf(found.offer.reservationOfferParts).find((p) => p.id === ref.resourceId);
    if (!part) throw new HttpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found', `"${ref.resourceId}" is not a reservation of offer ${ref.contextId}.`);
    const trip = listOf(found.trips).find((t) => t.id === part.tripCoverage.coveredTripId);
    return placeMapOfTrip(trip, provider) ? { contextId: ref.contextId, contextType: 'OFFER', resourceId: ref.resourceId, resourceType: 'RESERVATION' } : null;
  }).filter(Boolean);
  if (refs.length === 0) return { vehicle: { coaches: [] } };
  const fee = { price: price(feeOf(provider)) };
  const place = (number) => ({
    number,
    status: TAKEN.has(number) ? 'ALLOCATED' : 'FREE',
    reservationRefs: refs,
    ...(FEE_SEATS.has(number) ? { selectionFee: fee } : {}),
  });
  return {
    vehicle: {
      coaches: [{
        number: COACH,
        travelDirection: 'IN_DIRECTION',
        decks: [{
          layoutId: LAYOUT,
          compartments: [
            { serviceClass: 'STANDARD', accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', isSelectable: false, places: SALOON.map(place) },
            {
              serviceClass: 'STANDARD', accommodationType: 'SEAT', accommodationSubType: 'COMPARTMENT', isSelectable: true,
              number: COMPARTMENT.number, status: 'FREE', reservationRefs: refs, places: COMPARTMENT.places.map(place),
            },
          ],
        }],
      }],
    },
  };
}

/**
 * The places a booking request names for a reservation, checked against the
 * map: `{ places: [...numbers], compartment, fees }`, or null when it names
 * none. `fees` is the number of fee seats among them.
 */
function namedPlacesOf(selection, reservationId) {
  const placed = listOf(selection?.placeSelections).filter((s) => s?.reservationId === reservationId);
  const places = placed.flatMap((s) => listOf(s.places));
  const compartments = placed.flatMap((s) => listOf(s.compartments));
  if (places.length === 0 && compartments.length === 0) return null;
  if (places.length > 0 && compartments.length > 0) throw bad('a reservation names places or a compartment, not both');
  if (compartments.length > 0) {
    if (compartments.length > 1) throw bad('one compartment per reservation');
    const c = compartments[0];
    if (!text(c?.coachNumber) || !text(c?.compartmentNumber) || listOf(c?.passengerRefs).length === 0) throw bad('compartments[] must name coachNumber, compartmentNumber and passengerRefs');
    if (c.coachNumber !== COACH || c.compartmentNumber !== COMPARTMENT.number) throw notAvailable(`compartment ${c.coachNumber}/${c.compartmentNumber} is not on the map`);
    return { places: [...COMPARTMENT.places], compartment: COMPARTMENT.number, fees: 0 };
  }
  const numbers = places.map((p, i) => {
    if (!text(p?.coachNumber) || !text(p?.placeNumber) || !text(p?.passengerRef)) throw bad(`places[${i}] must name coachNumber, placeNumber and passengerRef`);
    if (p.coachNumber !== COACH || ![...SALOON, ...COMPARTMENT.places].includes(p.placeNumber)) throw notAvailable(`place ${p.coachNumber}/${p.placeNumber} is not on the map`);
    if (COMPARTMENT.places.includes(p.placeNumber)) throw notAvailable(`place ${p.placeNumber} is in compartment ${COMPARTMENT.number}, which is booked as a whole only`);
    if (TAKEN.has(p.placeNumber)) throw notAvailable(`place ${p.coachNumber}/${p.placeNumber} is taken`);
    return p.placeNumber;
  });
  if (new Set(numbers).size !== numbers.length) throw notAvailable('a place is named twice');
  return { places: numbers, compartment: null, fees: numbers.filter((n) => FEE_SEATS.has(n)).length };
}

/** The place a variant gives instead of a named seat: the next free one. */
function otherPlace(number) {
  let n = Number(number) + 1;
  while (TAKEN.has(String(n)) || n > 30) n = n > 30 ? 13 : n + 1;
  return String(n);
}

module.exports = { placeMapOfTrip, vehiclePlaceMap, namedPlacesOf, feeOf, otherPlace, COACH, FEE_SEATS, TAKEN, COMPARTMENT };
