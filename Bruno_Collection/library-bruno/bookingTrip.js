/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * bookingTrip.js — the trip of the booking against the trip of the offer
 * booked (#1299).
 *
 * Some providers give a booking with no trip, though the offer booked covers
 * one. OSDM requires none of `Booking.trips`, `BookedOffer.tripCoverage` and
 * a booked part's `tripCoverage` (a `TripCoverage` requires `coveredTripId`),
 * but `GET /bookings/{bookingId}` embeds everything by default (`embed`,
 * "Default value: ALL", value `BOOKING_TRIPS`). Booked resources may carry
 * other ids than the offer's (osdm.io, Processes, "Handling Partial Success
 * of Pre-Booking"), so a trip is compared by what it is: its first and last
 * stop places, its start and end, its number of legs. Every finding is a
 * WARNING line, never a test. A sale without a trip (#1258) is exempt.
 *
 * At 01 `keepOfferTrips()` keeps what the trips the chosen offer covers are
 * (`__offerTrips`); every booking step calls `checkBookingTrip()`.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { sameStopPlace } = require('./returnJourney.js');

function list(v) { return Array.isArray(v) ? v.filter((x) => x != null) : []; }

const PART_LISTS_OFFER = ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'];
const PART_LISTS_BOOKED = ['admissions', 'reservations', 'ancillaries', 'fees', 'fares'];

const idOf = (coverage) => (typeof coverage?.coveredTripId === 'string' && coverage.coveredTripId !== '' ? coverage.coveredTripId : null);

/** The trip ids an offer or a booked offer covers: its own coverage, its inbound one, its parts'. */
function coveredTripIds(holder, partLists) {
  const ids = [idOf(holder?.tripCoverage), idOf(holder?.inboundTripCoverage)];
  for (const key of partLists) {
    list(holder?.[key]).forEach((part) => ids.push(idOf(part?.tripCoverage), idOf(part?.inboundTripCoverage)));
  }
  return [...new Set(ids.filter(Boolean))];
}

// A stop place as text: a StopPlaceRef object, or the text itself.
function stopOf(place) {
  if (typeof place === 'string') return place;
  if (place && typeof place === 'object') return typeof place.stopPlaceRef === 'string' ? place.stopPlaceRef : stopOf(place.stopPlaceRef);
  return null;
}

function instant(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** What a trip is, without its ids: { id, origin, destination, start, end, legs }. */
function shapeOf(trip) {
  const legs = list(trip?.legs);
  const timed = legs.map((leg) => leg?.timedLeg).filter(Boolean);
  const first = timed[0];
  const last = timed.at(-1);
  return {
    id: typeof trip?.id === 'string' ? trip.id : null,
    origin: stopOf(trip?.origin) || stopOf(first?.start?.stopPlaceRef),
    destination: stopOf(trip?.destination) || stopOf(last?.end?.stopPlaceRef),
    start: trip?.startTime || first?.start?.serviceDeparture?.timetabledTime || null,
    end: trip?.endTime || last?.end?.serviceArrival?.timetabledTime || null,
    legs: legs.length,
  };
}

/** The shapes of the trips the chosen offer covers, from the offer answer's trips. */
function offerTripShapes(offer, trips) {
  const covered = coveredTripIds(offer, PART_LISTS_OFFER);
  return list(trips).filter((trip) => covered.includes(trip?.id)).map(shapeOf);
}

/** What differs between two trip shapes, as words; [] when it is the same trip. */
function differences(sold, booked) {
  const out = [];
  if (sold.origin && booked.origin && !sameStopPlace(sold.origin, booked.origin)) out.push(`origin ${booked.origin}, not ${sold.origin}`);
  if (sold.destination && booked.destination && !sameStopPlace(sold.destination, booked.destination)) out.push(`destination ${booked.destination}, not ${sold.destination}`);
  const at = (a, b) => instant(a) !== null && instant(b) !== null && instant(a) !== instant(b);
  if (at(sold.start, booked.start)) out.push(`start ${booked.start}, not ${sold.start}`);
  if (at(sold.end, booked.end)) out.push(`end ${booked.end}, not ${sold.end}`);
  if (sold.legs > 0 && booked.legs > 0 && sold.legs !== booked.legs) out.push(`${booked.legs} leg(s), not ${sold.legs}`);
  return out;
}

const describe = (s) => `${s.origin || '?'} → ${s.destination || '?'} at ${s.start || '?'}`;

/**
 * The booking against the trips sold: the WARNING texts, [] when all is well
 * or there is nothing to compare.
 *
 * @param {object}   booking     the Booking
 * @param {object[]} soldTrips   offerTripShapes() of the chosen offer
 * @param {string[]} soldIds     the trip ids the chosen offer covers
 */
function bookingTripFindings(booking, soldTrips, soldIds) {
  const sold = list(soldTrips);
  if (sold.length === 0 && list(soldIds).length === 0) return [];
  const trips = list(booking?.trips);
  const bookedOffers = list(booking?.bookedOffers);
  const coveredIds = [...new Set(bookedOffers.flatMap((bo) => coveredTripIds(bo, PART_LISTS_BOOKED)))];
  if (trips.length === 0 && coveredIds.length === 0) {
    const what = sold.length > 0 ? sold.map(describe).join('; ') : list(soldIds).join(', ');
    return [`The booking names no trip (no Booking.trips, no trip coverage on its booked offers or parts), though the offer booked covers ${what}. `
      + 'OSDM requires neither, but GET /bookings/{id} embeds the trips by default (embed ALL)'];
  }
  const out = [];
  const shapes = trips.map(shapeOf);
  for (const s of sold) {
    if (shapes.length === 0) break;
    if (shapes.some((b) => differences(s, b).length === 0)) continue;
    const closest = shapes.find((b) => b.id === s.id) || shapes[0];
    out.push(`No trip of the booking is the trip sold (${describe(s)}): the closest, ${closest.id || 'without id'}, has ${differences(s, closest).join(', ')}`);
  }
  if (trips.length > 0) {
    const known = new Set(shapes.map((b) => b.id).filter(Boolean));
    const unknown = coveredIds.filter((id) => !known.has(id));
    if (unknown.length > 0) out.push(`The booked offers or parts cover trip ${unknown.join(', ')}, which is not a trip of the booking (Booking.trips holds ${[...known].join(', ') || 'none with an id'})`);
  }
  return out;
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readJson(name, fallback) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

/** Step 01 (product sale): keep what the trips the chosen offer covers are. */
function keepOfferTrips(offer, trips) {
  bru.setEnvVar('__offerTrips', JSON.stringify({ ids: coveredTripIds(offer, PART_LISTS_OFFER), shapes: offerTripShapes(offer, trips) }));
}

/** Every booking step: one WARNING per finding; a sale without a trip is exempt. */
function checkBookingTrip(booking) {
  if (require('./nonTrip.js').isNonTripSale()) return;
  const kept = readJson('__offerTrips', null);
  if (!kept || typeof kept !== 'object') return;
  const { validationLogger } = require('./displays.js');
  bookingTripFindings(booking, kept.shapes, kept.ids).forEach((text) => validationLogger(`[WARNING] Trip of the booking: ${text}.`));
}

module.exports = {
  coveredTripIds, shapeOf, offerTripShapes, differences, bookingTripFindings,
  keepOfferTrips, checkBookingTrip, PART_LISTS_OFFER, PART_LISTS_BOOKED,
};
