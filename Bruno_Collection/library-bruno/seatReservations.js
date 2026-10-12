/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * seatReservations.js — mandatory and optional seat reservations (#601).
 *
 * OSDM states what an admission needs in its `reservations` relations: each
 * relation names a group of reservation offer parts and how many of them must
 * be booked (`minGroupItemsToBeBooked`). More than 0 is a mandatory
 * reservation, 0 an optional one. OSCAR books every mandatory reservation by
 * itself; a scenario's `reservationBookingForm` also books the optional ones,
 * in one of three forms:
 *   RESERVATION_SELECTION  optionalReservationSelections in the booking;
 *   PLACE_SELECTION        placeSelections in the booking, naming the trip
 *                          and the leg the reservation covers;
 *   ADD_LATER              POST …/booked-offers/{id}/offer-parts once the
 *                          booking is made (a mandatory one still goes with
 *                          the booking).
 * Some providers (ČD) also sell a reservation for all passengers or none, on
 * one leg at most. OSDM does not ask that of everyone: these are warnings.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-seat-reservations.test.js.
 */

const FORMS = ['RESERVATION_SELECTION', 'PLACE_SELECTION', 'ADD_LATER'];
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * A value read back from the environment: Bruno gives a stored JSON text back
 * as text or, for some variables, already as an object. Either way the value;
 * the fallback when it cannot be read.
 */
function fromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** The scenario's form, upper case, or null when it names none of the three. */
function normaliseForm(value) {
  const form = String(value ?? '').trim().toUpperCase();
  return FORMS.includes(form) ? form : null;
}

/** Every relation of the offer's admissions, with the ids of its group. */
function relationsOf(offer) {
  return listOf(offer?.admissionOfferParts).flatMap((admission) => listOf(admission?.reservations).map((relation, i) => ({
    admissionId: admission.id,
    index: i,
    relation,
    refs: listOf(relation?.reservationGroup?.reservationRefs).map((ref) => ref?.id).filter(Boolean),
  })));
}

const ids = (list) => [...new Set(list)];
// A relation asks for a reservation when its minimum is above 0; a missing
// minimum asks for none.
const isMandatory = (relation) => relation?.minGroupItemsToBeBooked > 0;

/**
 * The reservations to book: the first `minGroupItemsToBeBooked` of each
 * mandatory group, and, when asked, the first of each optional group. An
 * offer whose reservation parts no relation names (some providers leave the
 * relation out) gives its parts as optional ones.
 * @returns {{ mandatory: string[], optional: string[] }}
 */
function reservationsToBook(offer, { bookOptional }) {
  const known = new Set(listOf(offer?.reservationOfferParts).map((p) => p?.id));
  const relations = relationsOf(offer);
  const mandatory = ids(relations.flatMap(({ relation, refs }) => (isMandatory(relation) ? refs.slice(0, relation.minGroupItemsToBeBooked) : [])))
    .filter((id) => known.has(id));
  let optional = [];
  if (bookOptional) {
    const linked = relations.length > 0;
    const candidates = linked
      ? relations.filter(({ relation }) => !isMandatory(relation)).flatMap(({ refs }) => refs.slice(0, 1))
      : [...known];
    optional = ids(candidates).filter((id) => known.has(id) && !mandatory.includes(id));
  }
  return { mandatory, optional };
}

/** The placeSelections that name reservations, with the trip and leg each covers. */
function placeSelectionsFor(offer, reservationIds) {
  const parts = listOf(offer?.reservationOfferParts);
  return reservationIds.map((id) => {
    const coverage = parts.find((p) => p?.id === id)?.tripCoverage || {};
    return { reservationId: id, tripLegCoverage: { tripId: coverage.coveredTripId, legId: listOf(coverage.coveredLegIds)[0] } };
  });
}

/**
 * The checks of an offer's relations: each names reservation parts of the
 * offer, and asks for no more than its group holds. A failed check is a
 * failure: an admission pointing at a reservation that is not there cannot be
 * booked as OSDM says.
 * @returns {Array<{name: string, ok: boolean, message?: string}>}
 */
function checkRelations(offer) {
  const known = new Set(listOf(offer?.reservationOfferParts).map((p) => p?.id));
  return relationsOf(offer).flatMap(({ admissionId, index, relation, refs }) => {
    const label = `Admission ${admissionId} reservation relation ${index + 1}`;
    const min = relation?.minGroupItemsToBeBooked;
    const max = relation?.maxGroupItemsToBeBooked;
    const missing = refs.filter((id) => !known.has(id));
    const mandatory = min > 0;
    return [
      { name: `${label}: names reservation parts of the offer — ${refs.length} named, ${mandatory ? 'mandatory' : 'optional'}`, ok: refs.length > 0 && missing.length === 0, message: refs.length === 0 ? 'its reservationGroup names no reservation' : `not in reservationOfferParts: [${missing.join(', ')}]` },
      { name: `${label}: minGroupItemsToBeBooked ${min} is a whole number no larger than the group (${refs.length})${max == null ? '' : ', and no larger than maxGroupItemsToBeBooked ' + max}`, ok: Number.isInteger(min) && min >= 0 && min <= refs.length && (max == null || (Number.isInteger(max) && max >= min)), message: 'minGroupItemsToBeBooked / maxGroupItemsToBeBooked do not fit the group' },
    ];
  });
}

/**
 * The ČD rules on each reservation part of the offer: one for all passengers
 * (collective), on one leg at most. Warnings only (`level: 'warn'`).
 */
function checkProviderRules(offer, passengerRefs) {
  return listOf(offer?.reservationOfferParts).flatMap((part) => {
    const refs = listOf(part?.passengerRefs);
    const legs = listOf(part?.tripCoverage?.coveredLegIds);
    const everyone = passengerRefs.length > 0 && passengerRefs.every((r) => refs.includes(r)) && refs.length === passengerRefs.length;
    return [
      { name: `Reservation ${part?.id}: one reservation for all passengers`, ok: everyone, level: 'warn', message: `it holds [${refs.join(', ')}] of [${passengerRefs.join(', ')}]` },
      { name: `Reservation ${part?.id}: on one leg at most`, ok: legs.length <= 1, level: 'warn', message: `it covers ${legs.length} legs` },
    ];
  });
}

/**
 * The checks of a booking against the reservations booked: for each, a
 * reservation of the booking on the same trip and leg (the booking may give
 * it another id), and the place it was given. No place allocation is a
 * warning: OSDM does not require it. A reservation part the offer gives
 * without a trip coverage is matched by any booked reservation not already
 * taken. `places: false` leaves out the place check (a pre-booking may not
 * have allocated one yet).
 */
function checkBookedReservations(booking, offer, reservationIds, { places = true } = {}) {
  const parts = listOf(offer?.reservationOfferParts).filter((p) => reservationIds.includes(p?.id));
  const booked = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.reservations));
  const keyOf = (coverage) => `${coverage?.coveredTripId}|${listOf(coverage?.coveredLegIds).join(',')}`;
  const taken = new Set();
  return parts.flatMap((part) => {
    const covered = !!part.tripCoverage;
    const match = booked.find((r) => !taken.has(r) && (!covered || keyOf(r?.tripCoverage) === keyOf(part.tripCoverage)));
    if (match) taken.add(match);
    const legs = listOf(part.tripCoverage?.coveredLegIds).join(', ');
    const what = legs ? `on leg ${legs}` : `${part.summary || part.id} (the offer gives it no leg)`;
    const checks = [{
      name: `Booking: holds the reservation ${what}`,
      ok: !!match,
      message: match ? undefined : `the booking holds ${booked.length} reservation(s), none for the reservation ${part.id} ${what}`,
    }];
    if (match && places) {
      const reserved = listOf(match.placeAllocation?.reservedPlaces);
      const where = reserved.map((p) => `coach ${p?.coachNumber}, places ${listOf(p?.placeNumbers).join(', ') || p?.placeDescription || '?'}`).join('; ');
      checks.push({ name: `Booking: reservation ${match.id} gives a place — ${where || 'none'}`, ok: reserved.length > 0, level: 'warn', message: 'no placeAllocation.reservedPlaces' });
    }
    return checks;
  });
}

/**
 * Whether a booking request already asked for the reservation (#652), in the
 * placeSelections or the optionalReservationSelections of any of its offers.
 * The post-booking add-reservation step must not add it a second time.
 */
function reservationInBookingRequest(request, reservationId) {
  if (!reservationId) return false;
  const offers = Array.isArray(request?.offers) ? request.offers : [];
  return offers.some((offer) => [...(Array.isArray(offer?.placeSelections) ? offer.placeSelections : []),
    ...(Array.isArray(offer?.optionalReservationSelections) ? offer.optionalReservationSelections : [])]
    .some((selection) => selection?.reservationId === reservationId));
}

/**
 * #669: one PlaceSelection per reservation part. Some providers give one
 * ReservationOfferPart per passenger on a leg; the seats of a passenger then
 * go under that passenger's part, not all under the first one (refused as
 * "Seat not available"). The selection is split when the parts on its leg
 * each hold some of its passengers and together hold all of them; otherwise
 * it is returned as it is (one part for everyone is the usual case).
 *
 * @param {object} selection the PlaceSelection built for the booking
 * @param {object} offer     the selected offer
 * @returns {object[]}       the selections to send
 */
function splitByReservation(selection, offer) {
  if (!selection || typeof selection !== 'object') return [];
  const legId = selection.tripLegCoverage?.legId;
  const parts = (Array.isArray(offer?.reservationOfferParts) ? offer.reservationOfferParts : [])
    .filter((part) => part?.id && Array.isArray(part.passengerRefs) && part.passengerRefs.length > 0)
    .filter((part) => {
      const legs = part.tripCoverage?.coveredLegIds;
      return !legId || !Array.isArray(legs) || legs.length === 0 || legs.includes(legId);
    });
  if (parts.length < 2) return [selection];
  const places = Array.isArray(selection.places) ? selection.places : [];
  const accommodations = Array.isArray(selection.accommodations) ? selection.accommodations : [];
  const wanted = new Set([
    ...places.map((place) => place?.passengerRef),
    ...accommodations.flatMap((acc) => (Array.isArray(acc?.passengerRefs) ? acc.passengerRefs : [])),
  ].filter(Boolean));
  if (wanted.size === 0) return [selection];
  const holding = parts.filter((part) => part.passengerRefs.some((ref) => wanted.has(ref)));
  const held = new Set(holding.flatMap((part) => part.passengerRefs));
  if (holding.length < 2 || [...wanted].some((ref) => !held.has(ref))) return [selection];
  return holding.map((part) => {
    const mine = new Set(part.passengerRefs);
    const out = { reservationId: part.id };
    if (selection.tripLegCoverage) out.tripLegCoverage = selection.tripLegCoverage;
    const accs = accommodations
      .map((acc) => ({ ...acc, passengerRefs: (acc.passengerRefs || []).filter((ref) => mine.has(ref)) }))
      .filter((acc) => acc.passengerRefs.length > 0);
    if (accs.length > 0) out.accommodations = accs;
    const own = places.filter((place) => mine.has(place?.passengerRef));
    if (own.length > 0) out.places = own;
    return out;
  });
}

module.exports = { FORMS, fromEnv, normaliseForm, relationsOf, reservationsToBook, placeSelectionsFor, checkRelations, checkProviderRules, checkBookedReservations, reservationInBookingRequest, splitByReservation };
