/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * tripIds.js — offers asked for trips named by id (#602).
 *
 * OSDM gives three ways to ask for offers: search criteria, trip
 * specifications, and the ids of trips the provider returned before. For the
 * third, OSCAR first asks POST /trips-collection with the origin, destination
 * and time of the scenario's SEARCH trip, takes one trip of the answer, and
 * asks POST /offers with `tripIds` naming it:
 *   - the trip running the train the scenario names, when it names one;
 *   - otherwise the first trip leaving at the time asked or later.
 * No such trip is a failure. Only a one-way journey is asked this way.
 *
 * The negative test sends an id the provider never gave, and expects the
 * offer request to be refused.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-trip-ids.test.js.
 */

const UNKNOWN_TRIP_ID = 'OSCAR-UNKNOWN-TRIP-00000000';
const listOf = (value) => (Array.isArray(value) ? value : []);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The TripSearchCriteria of POST /trips-collection: origin, destination and
 * time of the offer search, and its vias. The train filter is left out, so
 * that the provider answers its departures and OSCAR chooses among them.
 * Null when the search has no origin or destination.
 */
function tripsCollectionRequest(criteria) {
  if (!criteria?.origin || !criteria.destination) return null;
  const out = { origin: criteria.origin, destination: criteria.destination };
  if (isText(criteria.departureTime)) out.departureTime = criteria.departureTime;
  else if (isText(criteria.arrivalTime)) out.arrivalTime = criteria.arrivalTime;
  if (listOf(criteria.vias).length > 0) out.vias = criteria.vias;
  return out;
}

/** The train numbers of a trip, across its legs. */
function vehicleNumbersOf(trip) {
  return listOf(trip?.legs).flatMap((leg) => {
    const service = leg?.timedLeg?.service || {};
    return [...listOf(service.vehicleNumbers), service.vehicleNumber].filter(isText).map(String);
  });
}

/** When a trip leaves: its startTime, else its first leg's departure. */
function startOf(trip) {
  return trip?.startTime || listOf(trip?.legs)[0]?.timedLeg?.start?.serviceDeparture?.timetabledTime || null;
}

// The local date and time of a date-time text, to the minute
// ("2026-11-20T08:00"), or null. OSDM writes a search's time in the local
// time of the stop, and a trip's times with the stop's offset: comparing the
// local clocks compares them on the same day at the same stop.
function localMinute(text) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(String(text || ''));
  return match ? match[1] : null;
}

/**
 * The trip to ask offers for: the one running `vehicleNumber` when it is
 * given, else the first leaving at `departureTime` or later, else (no time
 * asked) the first.
 * @returns {{ trip: object|null, how: string, reason?: string }}
 */
function chooseTrip(trips, { vehicleNumber, departureTime } = {}) {
  const candidates = listOf(trips).filter((t) => isText(t?.id));
  if (candidates.length === 0) return { trip: null, how: 'NONE', reason: 'the answer holds no trip with an id' };
  const train = isText(vehicleNumber) ? String(vehicleNumber).trim() : null;
  if (train) {
    const trip = candidates.find((t) => vehicleNumbersOf(t).includes(train));
    return trip
      ? { trip, how: `the trip of train ${train}` }
      : { trip: null, how: 'TRAIN', reason: `no trip of the answer runs train ${train} (trains: ${candidates.map((t) => vehicleNumbersOf(t).join('+') || '?').join(', ')})` };
  }
  const asked = localMinute(departureTime);
  if (!asked) return { trip: candidates[0], how: 'the first trip of the answer' };
  const trip = candidates.find((t) => (localMinute(startOf(t)) || '') >= asked);
  return trip
    ? { trip, how: `the first trip leaving at ${asked.slice(11)} or later` }
    : { trip: null, how: 'TIME', reason: `no trip of the answer leaves at ${asked.slice(11)} or later (departures: ${candidates.map((t) => localMinute(startOf(t))?.slice(11) || '?').join(', ')})` };
}

// Where a trip leaves from and goes to: its own origin / destination, else
// its first leg's start and last leg's end.
function endsOf(trip) {
  const legs = listOf(trip?.legs);
  const ref = (place) => place?.stopPlaceRef ?? place;
  return {
    from: ref(trip?.origin) || ref(legs[0]?.timedLeg?.start?.stopPlaceRef),
    to: ref(trip?.destination) || ref(legs.at(-1)?.timedLeg?.end?.stopPlaceRef),
  };
}

const NOT_PROVIDED = new Set([404, 405, 501]);

/**
 * The checks of a TripCollectionResponse: an id, trips with ids and legs, no
 * id twice (failures); trips from the origin to the destination asked
 * (warnings: a provider may answer from an equivalent stop).
 * @returns {Array<{name: string, ok: boolean, message?: string, level?: string}>}
 */
function checkTripsCollection(status, body, request) {
  // #772: 404, 405 and 501 say the provider does not give a trip search (the
  // #488 rule): a warning, and the scenario cannot go on by trip id.
  if (NOT_PROVIDED.has(status)) {
    return [{ name: `Trips collection: POST /trips-collection is provided — answered ${status}`, ok: false, level: 'warn', message: 'the provider does not give a trip search, so offers by trip id cannot be asked' }];
  }
  const checks = [{ name: `Trips collection: HTTP status 200 — actual ${status}`, ok: status === 200, message: `HTTP ${status}` }];
  if (status !== 200) return checks;
  const trips = listOf(body?.trips);
  const ids = trips.map((t) => t?.id);
  checks.push(
    { name: 'Trips collection: has an id (TripCollectionResponse.id is required)', ok: isText(body?.id), message: 'no id' },
    { name: `Trips collection: holds trips — ${trips.length}`, ok: trips.length > 0, message: 'no trip in the answer' },
  );
  if (trips.length === 0) return checks;
  const missing = trips.map((t, i) => (isText(t?.id) ? null : i + 1)).filter(Boolean);
  const twice = ids.filter((id, i) => isText(id) && ids.indexOf(id) !== i);
  const legless = trips.map((t, i) => (listOf(t?.legs).length > 0 ? null : i + 1)).filter(Boolean);
  checks.push(
    { name: 'Trips collection: every trip has an id, none twice', ok: missing.length === 0 && twice.length === 0, message: missing.length > 0 ? `trip(s) ${missing.join(', ')} have no id` : `id(s) given twice: ${[...new Set(twice)].join(', ')}` },
    { name: 'Trips collection: every trip has legs', ok: legless.length === 0, message: `trip(s) ${legless.join(', ')} have no leg` },
  );
  const from = request?.origin?.stopPlaceRef;
  const to = request?.destination?.stopPlaceRef;
  if (from && to) {
    const off = trips.map((t, i) => ({ i: i + 1, ...endsOf(t) })).filter((e) => e.from !== from || e.to !== to);
    checks.push({
      name: `Trips collection: every trip goes from ${from} to ${to}`,
      ok: off.length === 0,
      level: 'warn',
      message: off.map((e) => `trip ${e.i}: ${e.from} → ${e.to}`).join('; '),
    });
  }
  return checks;
}

/** The offer request asking for one trip by id instead of searching. */
/**
 * The path of the trip search (#904): `trips-collections` from OSDM 3.10,
 * where `trips-collection` is deprecated (OSDM#1487), else `trips-collection`.
 */
function tripsCollectionPath(version) {
  const [major, minor] = String(version || '').split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 10) ? 'trips-collections' : 'trips-collection';
}

function offerRequestByTripIds(request, tripId) {
  const out = { ...request, tripIds: [tripId] };
  delete out.tripSearchCriteria;
  delete out.tripSpecifications;
  return out;
}

// The trips an offer covers: its own tripCoverage, else its parts'.
function coveredTripsOf(offer) {
  const own = offer?.tripCoverage?.coveredTripId;
  if (own) return [own];
  const parts = ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'].flatMap((k) => listOf(offer?.[k]));
  return [...new Set(parts.map((p) => p?.tripCoverage?.coveredTripId).filter(Boolean))];
}

/**
 * The checks of the offers answered for a trip asked by id: every offer
 * covers that trip (failure), and the answer's trips hold it (warning: the
 * provider may leave the trips out of the answer).
 */
function checkOffersForTrip(body, tripId) {
  const offers = listOf(body?.offers);
  const other = offers.map((o) => ({ id: o?.offerId, trips: coveredTripsOf(o) }))
    .filter((o) => o.trips.some((t) => t !== tripId));
  // #906: an offer of fares only names no trip (OSDM TripCoverage: "not used
  // for fares"); the fares say what they cover. It is not counted here.
  const fareOnly = (o) => listOf(o?.fares).length > 0
    && ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'].every((k) => listOf(o?.[k]).length === 0);
  const unknown = offers.filter((o) => coveredTripsOf(o).length === 0 && !fareOnly(o)).length;
  const checks = [{
    name: `Offers by trip id: every offer covers the trip asked (${tripId})`,
    ok: other.length === 0,
    message: other.map((o) => `offer ${o.id} covers ${o.trips.join(', ')}`).join('; '),
  }];
  if (unknown > 0) {
    checks.push({ name: `Offers by trip id: ${unknown} offer(s) name no trip they cover`, ok: false, level: 'warn', message: 'no tripCoverage on the offer or its parts' });
  }
  const trips = listOf(body?.trips).map((t) => t?.id);
  checks.push({ name: 'Offers by trip id: the answer\'s trips hold the trip asked', ok: trips.includes(tripId), level: 'warn', message: `trips of the answer: [${trips.join(', ')}]` });
  return checks;
}

// What a trip search answered when it gave no trip (#729): its problems,
// else the members it has, so the run log says why. A real provider answered
// HTTP 200 with neither an id nor a trip, and the log showed nothing of it.
function describeTripsAnswer(body) {
  if (body === null || body === undefined) return ['the answer has no JSON body'];
  if (Array.isArray(body)) return ['the answer is not an object (a list)'];
  if (typeof body !== 'object') return [`the answer is not an object (${typeof body})`];
  const lines = listOf(body.problems).slice(0, 10).map((p, i) => {
    const code = isText(p?.code) ? p.code : '(no code)';
    const title = [p?.title, p?.detail].find(isText) || '(no title)';
    return `problem ${i + 1}: ${code} — ${title}`.slice(0, 300);
  });
  const keys = Object.keys(body).slice(0, 20);
  lines.push(keys.length ? `members of the answer: ${keys.join(', ')}` : 'the answer is an empty object');
  return lines;
}

// What a trip search answered when its body was not JSON (#764): its type,
// its length and its first characters as text (tags and runs of blanks
// removed), so the run log shows what the provider sent. A real provider
// answered HTTP 200 with a body that did not parse, and the log said only
// "no JSON body".
const SHOWN_CHARACTERS = 200;

// The text of an answer: tags replaced by a blank, runs of blanks by one. A
// scan, not a regular expression, so its time stays linear in the length.
function textOf(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const close = raw[i] === '<' ? raw.indexOf('>', i) : -1;
    if (raw[i] === '<' && close === -1) {
      // No '>' after this point: the rest is text (and each later '<' would
      // scan to the end again).
      out += raw.slice(i);
      break;
    }
    if (close === -1) {
      out += raw[i];
      i += 1;
    } else {
      out += ' ';
      i = close + 1;
    }
  }
  return out.split(/\s/).filter(Boolean).join(' ');
}
function describeRawAnswer(text, contentType) {
  const type = isText(contentType) ? String(contentType) : 'none';
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') return [`the answer is empty (Content-Type ${type})`];
  const plain = textOf(raw);
  const shown = plain.length > SHOWN_CHARACTERS ? `${plain.slice(0, SHOWN_CHARACTERS)}…` : plain;
  return [`the answer is not JSON (Content-Type ${type}, ${raw.length} characters): "${shown}"`];
}

module.exports = {
  UNKNOWN_TRIP_ID, tripsCollectionRequest, tripsCollectionPath, vehicleNumbersOf, chooseTrip, checkTripsCollection, offerRequestByTripIds, checkOffersForTrip,
  coveredTripsOf, describeTripsAnswer, describeRawAnswer, endsOf, startOf,
};
