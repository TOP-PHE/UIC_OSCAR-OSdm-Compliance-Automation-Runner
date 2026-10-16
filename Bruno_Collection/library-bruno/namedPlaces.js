/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * namedPlaces.js — a named place or compartment, chosen on the place map
 * (#766 PR 3).
 *
 * In the MANUAL_PLACE_SELECTION_WITHOUT_FEE and _WITH_FEE flows the retailer
 * asks POST /availabilities/vehicle-place-map for the reservations of the
 * offer, chooses FREE places (or a compartment booked as a whole) and names
 * them in the booking's `placeSelections[].places` / `compartments`.
 *
 * What is graded:
 *   - the map answer: 2xx with a vehicle; 501/404/405 = not provided (a
 *     warning, nothing named);
 *   - nothing to choose (no FREE place, no fee seat in the fee flow) is a
 *     warning: the booking goes without a named place;
 *   - the booked reservation must hold the places named (a FAIL otherwise:
 *     they were free, and the retailer sold them to the customer);
 *   - the price: without fee, the booked reservation costs what the offer
 *     said; with fee, what the offer said plus the fees of the seats named
 *     (a FAIL otherwise).
 *
 * Pure module: no Bruno globals.
 */

const MANUAL = ['MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'MANUAL_PLACE_SELECTION_WITH_FEE'];
const KINDS = ['PLACE', 'COMPARTMENT'];

const listOf = (value) => (Array.isArray(value) ? value : []);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const upper = (value) => String(value ?? '').trim().toUpperCase();
const amountOf = (price) => (price && Number.isFinite(price.amount) ? price.amount : null);

/** Whether a flow names a place on the map. */
const isManual = (flow) => MANUAL.includes(upper(flow));

/** The scenario's kind of named place: PLACE (default) or COMPARTMENT. */
function kindOfScenario(scenario) {
  const kind = upper(scenario?.namedPlaceKind);
  return KINDS.includes(kind) ? kind : 'PLACE';
}

/** The body of POST /availabilities/vehicle-place-map for reservations of an offer. */
function placeMapRequest(offerId, reservationIds) {
  return {
    placeRestrictions: listOf(reservationIds).map((id) => ({
      reservationRef: { contextId: offerId, contextType: 'OFFER', resourceId: id, resourceType: 'RESERVATION' },
    })),
  };
}

// The reservation ids a place or compartment of the map may be booked with.
const refIds = (refs) => listOf(refs).map((r) => r?.resourceId).filter(isText);

/**
 * Every place of the map, flat: `{ coach, number, status, fee, reservationIds,
 * compartment, selectable }`; and every compartment booked as a whole:
 * `{ coach, number, status, places, reservationIds, fee }`.
 */
function readMap(vehicle) {
  const places = [];
  const compartments = [];
  for (const coach of listOf(vehicle?.coaches)) {
    for (const deck of listOf(coach?.decks)) {
      for (const c of listOf(deck?.compartments)) {
        const selectable = c?.isSelectable === true;
        const inner = listOf(c?.places).filter((p) => isText(p?.number));
        if (selectable && isText(c?.number)) {
          compartments.push({
            coach: coach.number, number: c.number, status: c.status || 'FREE',
            places: inner.map((p) => p.number), reservationIds: refIds(c.reservationRefs), fee: amountOf(c.selectionFee?.price),
          });
        }
        for (const p of inner) {
          places.push({
            coach: coach.number, number: p.number, status: p.status || 'FREE', fee: amountOf(p.selectionFee?.price),
            reservationIds: refIds(p.reservationRefs), compartment: c?.number ?? null, selectable,
          });
        }
      }
    }
  }
  return { places, compartments };
}

/**
 * The checks of the map answer, and what it holds: `{ checks, map, lines }`.
 * `map` is null when the answer gives nothing to choose from.
 */
function checkPlaceMapAnswer(status, body) {
  const label = 'POST /availabilities/vehicle-place-map';
  if ([404, 405, 501].includes(status)) {
    return { checks: [], map: null, lines: [{ level: 'WARNING', text: `${label}: answered ${status}, the provider does not give a place map; no place is named in the booking.` }] };
  }
  const ok2xx = typeof status === 'number' && status >= 200 && status < 300;
  const checks = [{ name: `${label} is answered with 2xx`, ok: ok2xx, message: `HTTP ${status}` }];
  if (!ok2xx) return { checks, map: null, lines: [] };
  const map = readMap(body?.vehicle);
  const missing = map.places.filter((p) => !['FREE', 'ALLOCATED', 'RESTRICTED'].includes(p.status) || p.reservationIds.length === 0);
  const examples = missing.slice(0, 3).map((p) => p.coach + '/' + p.number).join(', ');
  checks.push({ name: `${label}: each place gives its status and the reservations it can be booked with`, ok: missing.length === 0, message: `${missing.length} place(s) without a known status or reservationRefs, e.g. ${examples}` });
  if (map.places.length === 0) {
    return { checks, map: null, lines: [{ level: 'WARNING', text: `${label}: the answer holds no place (no coach, or no compartment); no place is named in the booking.` }] };
  }
  return { checks, map, lines: [{ level: 'INFO', text: `${label}: ${map.places.length} place(s), ${map.places.filter((p) => p.status === 'FREE').length} free, ${map.places.filter((p) => p.fee != null).length} with a selection fee, ${map.compartments.length} compartment(s) booked as a whole.` }] };
}

/**
 * The places to name for each reservation: `{ choices, fees, lines }`.
 * `choices[reservationId]` is `{ places: [{ coachNumber, placeNumber,
 * passengerRef }] }` or `{ compartments: [{ coachNumber, compartmentNumber,
 * passengerRefs }] }`; `fees[reservationId]` the fees of the seats named.
 * Without fee, only seats without one; with fee, fee seats first.
 * @param {object}   map            readMap()
 * @param {string}   flow           the manual flow
 * @param {string}   kind           PLACE or COMPARTMENT
 * @param {object[]} reservations   [{ id, passengerRefs }]
 */
function chooseNamedPlaces(map, { flow, kind, reservations }) {
  const out = { choices: {}, fees: {}, lines: [] };
  const used = new Set();
  const withFee = upper(flow) === 'MANUAL_PLACE_SELECTION_WITH_FEE';
  for (const { id, passengerRefs } of listOf(reservations)) {
    const refs = listOf(passengerRefs).filter(isText);
    if (refs.length === 0) continue;
    const choose = kind === 'COMPARTMENT' ? chooseCompartment : chooseSeats;
    choose(map, { id, refs, withFee, used }, out);
  }
  return out;
}

// Whether a place or compartment of the map may go to the reservation `id`.
const forReservation = (x, id) => x.reservationIds.length === 0 || x.reservationIds.includes(id);
const feeWords = (withFee) => (withFee ? '' : ' without fee');

// One free compartment booked as a whole, large enough, for a reservation.
function chooseCompartment(map, { id, refs, withFee, used }, out) {
  const c = listOf(map?.compartments).find((x) => x.status === 'FREE' && forReservation(x, id) && !used.has(x.coach + '#' + x.number)
    && x.places.length >= refs.length && (withFee || x.fee == null));
  if (!c) {
    out.lines.push({ level: 'WARNING', text: `Reservation ${id}: the place map has no free compartment booked as a whole${feeWords(withFee)} for ${refs.length} passenger(s); no compartment is named.` });
    return;
  }
  used.add(c.coach + '#' + c.number);
  out.choices[id] = { compartments: [{ coachNumber: c.coach, compartmentNumber: c.number, passengerRefs: refs }] };
  out.fees[id] = c.fee || 0;
}

// One free seat per passenger for a reservation: without a fee, or fee seats first.
function chooseSeats(map, { id, refs, withFee, used }, out) {
  const free = listOf(map?.places).filter((p) => p.status === 'FREE' && !p.selectable && forReservation(p, id) && !used.has(p.coach + '/' + p.number));
  const withAFee = free.filter((p) => p.fee != null);
  const pool = withFee ? [...withAFee, ...free.filter((p) => p.fee == null)] : free.filter((p) => p.fee == null);
  if (withFee && withAFee.length === 0) {
    out.lines.push({ level: 'WARNING', text: `Reservation ${id}: the place map gives no seat with a selection fee; the fee is not tested.` });
  }
  if (pool.length < refs.length) {
    out.lines.push({ level: 'WARNING', text: `Reservation ${id}: the place map has ${pool.length} free seat(s)${feeWords(withFee)} for ${refs.length} passenger(s); no place is named.` });
    return;
  }
  const picked = pool.slice(0, refs.length);
  picked.forEach((p) => used.add(p.coach + '/' + p.number));
  out.choices[id] = { places: picked.map((p, i) => ({ coachNumber: p.coach, placeNumber: p.number, passengerRef: refs[i] })) };
  out.fees[id] = picked.reduce((sum, p) => sum + (p.fee || 0), 0);
}

/** The placeSelections with the places chosen added to the selection of their reservation. */
function withNamedPlaces(selections, choices) {
  const named = choices && typeof choices === 'object' ? choices : {};
  return listOf(selections).map((s) => (named[s?.reservationId] ? { ...s, ...named[s.reservationId] } : s));
}

// The compartments a booked reservation names, for a message.
function compartmentsText(reserved) {
  const numbers = reserved.map((p) => p?.compartmentNumber).filter(Boolean);
  return numbers.length > 0 ? ', compartment ' + numbers.join(', ') : '';
}

/** Short text of a choice, for the log. */
function describeChoice(choice) {
  if (listOf(choice?.compartments).length > 0) return choice.compartments.map((c) => `compartment ${c.coachNumber}/${c.compartmentNumber}`).join(', ');
  return listOf(choice?.places).map((p) => `${p.coachNumber}/${p.placeNumber}`).join(', ');
}

/**
 * The checks of the booking against the places named: per reservation named,
 * the booked reservation of the same id (else, when only one was named, the
 * only one booked) holds them, and costs the offer's price plus the fees.
 * @param {object} booking
 * @param {object} offer    the offer chosen
 * @param {object} choices  chooseNamedPlaces().choices
 * @param {object} fees     chooseNamedPlaces().fees
 */
function checkNamedPlacesBooked(booking, offer, choices, fees) {
  const named = Object.entries(choices && typeof choices === 'object' ? choices : {});
  const booked = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.reservations));
  return named.flatMap(([id, choice]) => {
    const r = booked.find((x) => x?.id === id) || (named.length === 1 && booked.length === 1 ? booked[0] : null);
    const what = describeChoice(choice);
    if (!r) return [{ name: `Booking: holds the reservation ${id} with the places named (${what})`, ok: false, message: `no booked reservation ${id}` }];
    const reserved = listOf(r.placeAllocation?.reservedPlaces);
    const given = reserved.flatMap((p) => listOf(p?.placeNumbers).map((n) => `${p?.coachNumber}/${n}`));
    let ok;
    if (listOf(choice.compartments).length > 0) {
      const c = choice.compartments[0];
      ok = reserved.some((p) => p?.coachNumber === c.coachNumber && p?.compartmentNumber === c.compartmentNumber);
    } else {
      ok = choice.places.every((p) => given.includes(`${p.coachNumber}/${p.placeNumber}`));
    }
    const checks = [{
      name: `Booking: reservation ${r.id} gives the places named (${what})`,
      ok,
      message: 'given: ' + (given.join(', ') || 'no place') + compartmentsText(reserved),
    }];
    const part = listOf(offer?.reservationOfferParts).find((p) => p?.id === id);
    const offered = amountOf(part?.price);
    const paid = amountOf(r.price);
    if (offered != null && paid != null) {
      const fee = fees?.[id] || 0;
      checks.push({
        name: `Booking: reservation ${r.id} costs the offer's price` + (fee ? ` plus the selection fee (${offered} + ${fee})` : ` (${offered}), no selection fee`),
        ok: paid === offered + fee,
        message: `booked at ${paid}${paid > offered + fee ? ' (more than asked)' : ''}`,
      });
    }
    return checks;
  });
}

// ── #766 PR 4: a place near a reference place (AUTOMATIC_PLACE_SELECTION_NEARBY) ──

/** The scenario's reference place, `{ coachNumber, placeNumber }`, from text "7/15" (coach / place), or null. */
function referenceOfScenario(scenario) {
  const value = scenario?.referencePlace;
  if (!isText(value)) return null;
  const at = value.indexOf('/');
  const coachNumber = at > 0 ? value.slice(0, at).trim() : '';
  const placeNumber = at > 0 ? value.slice(at + 1).trim() : '';
  return coachNumber && placeNumber && !placeNumber.includes('/') ? { coachNumber, placeNumber } : null;
}

/** The query of GET /availabilities/nearby for a reservation of an offer and a reference place. */
function nearbyQuery(offerId, reservationId, ref) {
  const q = (v) => encodeURIComponent(String(v ?? ''));
  return `/availabilities/nearby?contextId=${q(offerId)}&contextType=OFFER&resourceId=${q(reservationId)}&resourceType=RESERVATION`
    + `&coachNumber=${q(ref?.coachNumber)}&placeNumber=${q(ref?.placeNumber)}`;
}

/**
 * The checks of GET /availabilities/nearby: `{ checks, lines }`. 501, 404 and
 * 405 are "not provided", a warning; the reference place is sent anyway. No
 * free place near it is a warning too: the provider decides at the booking.
 */
function checkNearbyAnswer(status, body, reservationId, ref) {
  const label = `GET /availabilities/nearby (reservation ${reservationId}, near ${ref.coachNumber}/${ref.placeNumber})`;
  if ([404, 405, 501].includes(status)) {
    return { checks: [], lines: [{ level: 'WARNING', text: `${label}: answered ${status}, the provider does not give the places near a place; the reference place is sent as it is.` }] };
  }
  const ok2xx = typeof status === 'number' && status >= 200 && status < 300;
  const checks = [{ name: `${label} is answered with 2xx`, ok: ok2xx, message: `HTTP ${status}` }];
  if (!ok2xx) return { checks, lines: [] };
  const places = body?.availablePlaces;
  checks.push({ name: `${label}: availablePlaces is a list`, ok: Array.isArray(places), message: `availablePlaces is ${places === undefined ? 'absent' : typeof places}` });
  const list = listOf(places);
  const incomplete = list.filter((p) => !isText(p?.accommodationType) || !isText(p?.accommodationSubType) || !isText(p?.tripLegCoverage?.tripId) || !isText(p?.tripLegCoverage?.legId));
  if (list.length > 0) checks.push({ name: `${label}: each available place names its accommodation type, sub-type and leg`, ok: incomplete.length === 0, message: `${incomplete.length} incomplete` });
  const free = list.reduce((sum, p) => sum + (Number.isFinite(p?.numericAvailability) ? p.numericAvailability : 0), 0);
  const counted = list.some((p) => Number.isFinite(p?.numericAvailability));
  if (counted && free === 0) {
    return { checks, lines: [{ level: 'WARNING', text: `${label}: no free place near it; the reference place is sent, and the provider decides.` }] };
  }
  let found = list.length === 1 ? '1 available place entry' : list.length + ' available place entries';
  if (counted) found = free + ' free place(s) near it';
  return { checks, lines: [{ level: 'INFO', text: `${label}: ${found}.` }] };
}

/** The placeSelections with the reference place, for each selection that names no place or compartment. */
function withReferencePlace(selections, ref) {
  if (!ref) return listOf(selections);
  return listOf(selections).map((s) => (listOf(s?.places).length > 0 || listOf(s?.compartments).length > 0 ? s : { ...s, referencePlace: { ...ref } }));
}

/**
 * Whether the booked reservations are near the reference place: in its
 * coach. A warning (level 'warn') otherwise: OSDM places them near it if it
 * can. The reference place itself given to a passenger is a failure: it is
 * another traveller's seat, not one near it.
 */
function checkNearPlaceGiven(booking, ref, reservationIds) {
  if (!ref) return [];
  const all = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.reservations));
  const own = all.filter((r) => listOf(reservationIds).includes(r?.id));
  return (own.length > 0 ? own : all).flatMap((r) => {
    const reserved = listOf(r?.placeAllocation?.reservedPlaces);
    const coaches = [...new Set(reserved.map((p) => p?.coachNumber).filter(isText))];
    const given = reserved.flatMap((p) => listOf(p?.placeNumbers).map((n) => p?.coachNumber + '/' + n));
    return [
      { name: `Booking: reservation ${r?.id} is near the reference place ${ref.coachNumber}/${ref.placeNumber} (same coach)`, ok: coaches.includes(ref.coachNumber), level: 'warn', message: `given: ${given.join(', ') || 'no place'}` },
      { name: `Booking: reservation ${r?.id} does not give the reference place ${ref.coachNumber}/${ref.placeNumber} itself`, ok: !given.includes(ref.coachNumber + '/' + ref.placeNumber), message: `given: ${given.join(', ')}` },
    ];
  });
}

module.exports = {
  MANUAL, KINDS, isManual, kindOfScenario, placeMapRequest, readMap, checkPlaceMapAnswer, chooseNamedPlaces,
  withNamedPlaces, describeChoice, checkNamedPlacesBooked,
  referenceOfScenario, nearbyQuery, checkNearbyAnswer, withReferencePlace, checkNearPlaceGiven,
};
