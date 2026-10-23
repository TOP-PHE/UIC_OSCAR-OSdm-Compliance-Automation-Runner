/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fareReservations.js — fare reservations, a bicycle place (#255, fares phase 4).
 *
 * A request asks for them with `FARE_RESERVATION` in its requested offer
 * parts, for an anonymous passenger of type BICYCLE. From OSDM 3.8 a fare
 * reservation is an ordinary ReservationOfferPart, then Reservation, marked
 * `distributionMode: FARE_MODE` (osdm.io, handling reservations; 4.0 uses
 * `partType` instead). It goes with the fare sale of #906: step 01 selects the
 * chosen offer's fare reservations (OSDM books only the mandatory ones without
 * being asked), and they are booked and fulfilled with the fares.
 *
 *   V1  a fare reservation is in FARE_MODE (absent = PRODUCT_MODE)  01 02 05 07  FAIL
 *   V2  no product on a fare reservation                            01           WARNING
 *   V3  each bicycle has a fare reservation; each booked one holds
 *       its passengers                                              01 02 05 07  FAIL
 *   V4  the place allocation, with or without place numbers         07           INFO
 *   V5  the fare fulfilment: no control number, no issuer (check F2
 *       of fareBooking.js, #242 D3)                                 06 06b 07    WARNING
 *   V6  fulfilment parts with a control id or security features     06 06b 07    INFO
 *   V7  the IRS 90918-1 reference (bookingPartCode, 12 digits)      07           INFO
 *   V8  no fare reservation that was not asked                      01           FAIL
 *   V9  every fare reservation selected is in the booking           02 05 07     FAIL
 *   V10 status PREBOOKED, then CONFIRMED or FULFILLED                05 07        FAIL
 *   V11 every booked fare reservation is in a fulfilment            07           FAIL
 *   V12 GET /fulfillments/{id}: an error or an empty fulfilment,
 *       which OSDM allows for a fare reservation                    06b          INFO
 *
 * Before OSDM 3.8 a fare reservation had another shape, which osdm.io does not
 * describe: it is not checked (a WARNING says so).
 *
 * Pure: no Bruno globals. The glue is in fares.js, fareBooking.js and
 * fulfillmentSteps.js.
 */

const { atLeast } = require('./osdmVersion.js');

const FARE_MODE = 'FARE_MODE';
const FROM_VERSION = '3.8';
const STATUSES_CONFIRMED = ['CONFIRMED', 'FULFILLED'];
const MAX_LISTED = 5;

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFareMode = (part) => part?.distributionMode === FARE_MODE;
const partsAsked = (request) => list(request?.offerSearchCriteria?.requestedOfferParts);
const modeText = (part) => (part?.distributionMode == null ? 'absent (= PRODUCT_MODE)' : JSON.stringify(part.distributionMode));

function check(id, level, title, broken, explain) {
  const shown = broken.slice(0, MAX_LISTED).join('; ');
  const more = broken.length > MAX_LISTED ? ` and ${broken.length - MAX_LISTED} more` : '';
  return { id, level, title, ok: broken.length === 0, message: broken.length ? `${explain}: ${shown}${more}` : '' };
}
const info = (id, message) => ({ id, level: 'INFO', title: '', ok: true, message });

/** Does the request ask for fare reservations (FARE_RESERVATION or ALL)? */
function asksFareReservations(request) {
  const parts = partsAsked(request);
  return parts.includes('FARE_RESERVATION') || parts.includes('ALL');
}

// A reservation in product mode may be asked too (RESERVATION, ALL, or no part named).
function asksProductReservations(request) {
  const parts = partsAsked(request);
  return parts.length === 0 || parts.includes('RESERVATION') || parts.includes('ALL');
}

/** The references of the request's passengers of type BICYCLE. */
function bicycleRefsOf(request) {
  return list(request?.anonymousPassengerSpecifications).filter((p) => p.type === 'BICYCLE').map((p) => p.externalRef).filter(Boolean);
}

/** An offer's fare reservations (its reservation offer parts in FARE_MODE). */
function offerFareReservations(offer) {
  return list(offer?.reservationOfferParts).filter(isFareMode);
}

/** Does an offer hold fare parts: fares, or fare reservations? */
function hasFareParts(offer) {
  return list(offer?.fares).length > 0 || offerFareReservations(offer).length > 0;
}

// Every reservation offer part of an answer, with its path.
function reservationPartsOf(response) {
  return list(response?.offers).flatMap((offer, i) => list(offer.reservationOfferParts).map((part, j) => ({
    offer, part, path: `offers[${i}].reservationOfferParts[${j}]`,
  })));
}

/** How many fare reservations an answer holds. */
function fareReservationCount(response) {
  return reservationPartsOf(response).filter(({ part }) => isFareMode(part)).length;
}

/**
 * The checks of the fare reservations of an answer to a request that asks
 * for them (step 01): V3, V1, V2. Below OSDM 3.8, one WARNING instead.
 */
function offerChecks(response, request, { osdmVersion } = {}) {
  if (!asksFareReservations(request)) return [];
  if (!atLeast(osdmVersion, FROM_VERSION)) {
    return [{ id: 'V1', level: 'WARNING', title: 'Fare reservations are checked from OSDM 3.8', ok: false,
      message: `the scenario is on ${osdmVersion || 'an unknown version'}: before 3.8 a fare reservation had another shape (osdm.io, handling reservations), so its answer is not checked` }];
  }
  const all = reservationPartsOf(response);
  const fare = all.filter(({ part }) => isFareMode(part));
  const bicycles = bicycleRefsOf(request);
  const forBicycle = (ref) => all.filter(({ part }) => list(part.passengerRefs).includes(ref));
  // A bicycle with a reservation in another mode is V1's, not V3's: one defect, one check.
  const checks = bicycles.length > 0
    ? [check('V3', 'FAIL', 'Each bicycle passenger has a reservation (a bicycle place)', bicycles.filter((ref) => forBicycle(ref).length === 0).map((ref) => `passenger ${ref}`),
      'bicycle passengers without a reservation')]
    : [check('V3', 'FAIL', 'The answer holds a fare reservation (a reservation offer part in FARE_MODE), as FARE_RESERVATION asks',
      fare.length ? [] : ['none'], 'no fare reservation offered')];
  // A bicycle's place in product mode is wrong only when no product reservation was asked.
  if (!asksProductReservations(request)) {
    checks.push(check('V1', 'FAIL', 'Each reservation of a bicycle passenger is in FARE_MODE (ReservationOfferPart.distributionMode; absent = PRODUCT_MODE)',
      bicycles.flatMap(forBicycle).filter(({ part }) => !isFareMode(part)).map(({ part, path }) => `${path}.distributionMode ${modeText(part)}`),
      'reservations of a bicycle in product mode, though only fare reservations were asked (osdm.io, handling reservations)'));
  }
  checks.push(check('V2', 'WARNING', 'A fare reservation has no product (products empty)',
    fare.filter(({ part }) => list(part.products).length > 0).map(({ part, path }) => `${path} holds ${list(part.products).length} product(s)`),
    'products on a fare reservation (in fare mode the distributor builds the product)'));
  return checks;
}

/**
 * V8: fare reservations in an answer though the request named its offer
 * parts without FARE_RESERVATION or ALL (OSDM DistributionMode: "Offers in
 * FARE_MODE must not be provided unless they are requested"). Null when the
 * request named none, or asked for them.
 */
function unaskedReservationsCheck(response, request) {
  const parts = partsAsked(request);
  if (parts.length === 0 || asksFareReservations(request)) return null;
  const count = fareReservationCount(response);
  if (count === 0) return null;
  return check('V8', 'FAIL', `No fare reservation when the request asks for ${parts.join(', ')} only`, [`${count} fare reservation(s)`],
    'fare reservations that were not asked (OSDM DistributionMode: offers in FARE_MODE only when requested)');
}

/** The selections that book an offer's fare reservations with it (optionalReservationSelections). */
function selectionsFor(offer) {
  return offerFareReservations(offer).map((part) => ({ reservationId: part.id }));
}

// ── The booking ─────────────────────────────────────────────────────────────

/** Every booked reservation, with its path. */
function bookedReservationsOf(booking) {
  return list(booking?.bookedOffers).flatMap((offer, i) => list(offer.reservations).map((reservation, j) => ({
    reservation, path: `bookedOffers[${i}].reservations[${j}]`,
  })));
}

// The offer's references of the passengers a booked part names by id.
function externalRefsOf(ids, booking) {
  const byId = new Map(list(booking?.passengers).map((p) => [p.id, p.externalRef]));
  return list(ids).map((id) => String(byId.get(id) ?? id)).sort((a, b) => a.localeCompare(b));
}

/**
 * The offer's fare reservations paired with the booked reservations, by id,
 * else by the same passengers and leg; never by position.
 */
function pairReservations(offer, booking) {
  const booked = bookedReservationsOf(booking);
  const used = new Set();
  const pairs = [];
  const missing = [];
  for (const offered of offerFareReservations(offer)) {
    const passengers = list(offered.passengerRefs).map(String).sort((a, b) => a.localeCompare(b)).join('|');
    const leg = list(offered.tripCoverage?.coveredLegIds).join('|');
    const sameId = booked.find((b) => !used.has(b) && b.reservation.id === offered.id);
    const same = sameId || booked.find((b) => !used.has(b) && externalRefsOf(b.reservation.passengerIds, booking).join('|') === passengers
      && list(b.reservation.tripCoverage?.coveredLegIds).join('|') === leg);
    if (same) {
      used.add(same);
      pairs.push({ offered, booked: same.reservation, path: same.path });
    } else {
      missing.push(offered);
    }
  }
  return { pairs, missing };
}

/** The ids of a booking's fare reservations: those in FARE_MODE, and those that stand for the offer's. */
function fareReservationIdsOf(booking, offer) {
  const ids = new Set(bookedReservationsOf(booking).filter(({ reservation }) => isFareMode(reservation)).map(({ reservation }) => reservation.id));
  for (const { booked } of pairReservations(offer, booking).pairs) ids.add(booked.id);
  return [...ids].filter(Boolean);
}

// V4 and V7, on the confirmed booking: what the places are, and the IRS reference.
function confirmedNotes(pairs) {
  return pairs.flatMap(({ booked, path }) => {
    const places = list(booked.placeAllocation?.reservedPlaces);
    const numbered = places.filter((p) => list(p.placeNumbers).length > 0).length;
    const code = booked.bookingPartCode;
    const shown = code == null ? 'absent' : JSON.stringify(code);
    const irs = /^\d{12}$/.test(String(code ?? '')) ? 'an IRS 90918-1 reference (12 digits)' : 'not an IRS 90918-1 reference';
    const allocated = places.length > 0 ? [places.length, 'place(s) allocated,', numbered, 'with place numbers'].join(' ') : 'no place allocated (allotted without numbers)';
    return [
      info('V4', `${path}: ${allocated} — both are accepted`),
      info('V7', `${path}: bookingPartCode ${shown}, ${irs} (osdm.io, handling reservations: it should be stored there when the reservation comes from an IRS 90918-1 inventory)`),
    ];
  });
}

/**
 * The checks of a booking's fare reservations against the offer booked:
 * V9, V1, V3, then V10 ('prebooked' and 'confirmed'), and V4 and V7
 * ('confirmed'). `stage` is that of fareBooking.bookingChecks().
 */
function bookingChecks(booking, offer, stage) {
  if (offerFareReservations(offer).length === 0) return [];
  const { pairs, missing } = pairReservations(offer, booking);
  const checks = [
    check('V9', 'FAIL', 'Every fare reservation of the offer is in the booking (selected in optionalReservationSelections; paired by id, else passengers and leg)',
      missing.map((part) => `offered reservation ${part.id ?? '?'}`), 'fare reservations missing from the booking'),
    check('V1', 'FAIL', 'Each booked fare reservation is in FARE_MODE (Reservation.distributionMode; absent = PRODUCT_MODE)',
      pairs.filter((p) => !isFareMode(p.booked)).map((p) => `${p.path}.distributionMode ${modeText(p.booked)}`), 'booked in product mode (osdm.io, handling reservations)'),
    check('V3', 'FAIL', 'Each booked fare reservation holds the passengers of its offer part (the bicycle)',
      pairs.filter((p) => externalRefsOf(p.booked.passengerIds, booking).join('|') !== list(p.offered.passengerRefs).map(String).sort((a, b) => a.localeCompare(b)).join('|'))
        .map((p) => `${p.path} holds [${externalRefsOf(p.booked.passengerIds, booking).join(', ')}], offered for [${list(p.offered.passengerRefs).join(', ')}]`),
      'other passengers'),
  ];
  if (stage === 'prebooked' || stage === 'confirmed') {
    const expected = stage === 'confirmed' ? STATUSES_CONFIRMED : ['PREBOOKED'];
    checks.push(check('V10', 'FAIL', `Each booked fare reservation's status is ${expected.join(' or ')}`,
      pairs.filter((p) => !expected.includes(p.booked.status)).map((p) => `${p.path}.status = ${JSON.stringify(p.booked.status)}`), 'reservations in another status'));
  }
  if (stage === 'confirmed') checks.push(...confirmedNotes(pairs));
  return checks;
}

/** The prices of a booking's fare reservations, for its provisional price (B5). */
function reservationPrices(booking, offer) {
  const ids = new Set(fareReservationIdsOf(booking, offer));
  return bookedReservationsOf(booking).filter(({ reservation }) => ids.has(reservation.id)).map(({ reservation }) => reservation.price).filter(isObject);
}

/** V11: every booked fare reservation is named by a fulfilment (07). */
function inFulfillmentCheck(booking, offer) {
  const ids = fareReservationIdsOf(booking, offer);
  if (ids.length === 0) return null;
  const named = new Set(list(booking?.fulfillments).flatMap((f) => list(f.bookingParts).map((p) => p.id)));
  return check('V11', 'FAIL', 'Every booked fare reservation is in a fulfilment (bookingParts)', ids.filter((id) => !named.has(id)).map((id) => `reservation ${id}`),
    'fare reservations in no fulfilment');
}

/** V6: fulfilment parts on fare fulfilments (control id, security features), told when present. */
function fulfillmentPartsNote(fulfillments) {
  const parts = list(fulfillments).flatMap((f) => list(f.fulfillmentParts).map((part) => ({ f, part })));
  if (parts.length === 0) return null;
  const withId = parts.filter(({ part }) => part.controlId != null && part.controlId !== '').length;
  const secure = parts.filter(({ part }) => list(part.securityFeatures).length > 0).length;
  return info('V6', `${parts.length} fulfilment part(s): ${withId} with a control id, ${secure} with security features (the control number of a fare fulfilment may be given as a control id)`);
}

/** V12: an empty fulfilment, which GET /fulfillments/{id} may give for a fare reservation. */
function isEmptyFulfillment(fulfillment) {
  return !isObject(fulfillment) || Object.keys(fulfillment).filter((k) => k !== 'id').length === 0;
}

const READ_ALLOWED = 'osdm.io, handling reservations: in fare mode the client produces the fulfilment, and GET /fulfillments/{id} "will either return an error or an empty fulfillment"';

module.exports = {
  FARE_MODE, FROM_VERSION, READ_ALLOWED, isFareMode, asksFareReservations, asksProductReservations, bicycleRefsOf, offerFareReservations, hasFareParts,
  fareReservationCount, offerChecks, unaskedReservationsCheck, selectionsFor, bookedReservationsOf, pairReservations, fareReservationIdsOf,
  bookingChecks, reservationPrices, inFulfillmentCheck, fulfillmentPartsNote, isEmptyFulfillment,
};
