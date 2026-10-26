/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * exchangeTrip.js — the trip an exchange asks for (#959).
 *
 * A scenario's optional `exchange` block says what the booking is exchanged
 * for:
 *
 *   tripRequirementId    another trip of the data file (another route)
 *   dateOffsetDays       the day, counted from the sale's (-60 to 60)
 *   time                 "HH:MM", the departure asked (a SEARCH trip only)
 *   offerSearchCriteria  { travelClasses, serviceClassTypes, flexibilities },
 *                        over the sale's criteria
 *
 * Without it, the exchange asks for the sale's trip with the sale's criteria,
 * as it always did.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-exchange-trip.test.js.
 */

const { endsOf, startOf, vehicleNumbersOf } = require('./tripIds.js');
const { sameStopPlace } = require('./returnJourney.js');

const CRITERIA_KEYS = ['travelClasses', 'serviceClassTypes', 'flexibilities'];
const MAX_OFFSET_DAYS = 60;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PART_LISTS = ['admissions', 'reservations', 'ancillaries'];

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

function criteriaOf(raw, lines) {
  if (raw == null) return null;
  if (!isObj(raw)) {
    lines.push('[WARNING] 🔁 exchange.offerSearchCriteria is not an object: the sale\'s criteria are sent.');
    return null;
  }
  const out = {};
  for (const key of CRITERIA_KEYS) {
    const values = listOf(raw[key]).filter(isText).map((v) => v.trim());
    if (values.length > 0) out[key] = values;
  }
  const others = Object.keys(raw).filter((k) => !CRITERIA_KEYS.includes(k));
  if (others.length > 0) {
    lines.push(`[WARNING] 🔁 exchange.offerSearchCriteria: ${others.join(', ')} not taken (only ${CRITERIA_KEYS.join(', ')}).`);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function offsetOf(raw, lines) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || Math.abs(n) > MAX_OFFSET_DAYS) {
    lines.push(`[WARNING] 🔁 exchange.dateOffsetDays ${JSON.stringify(raw)} is not a whole number of days from -${MAX_OFFSET_DAYS} to ${MAX_OFFSET_DAYS}: the sale's day is kept.`);
    return 0;
  }
  return n;
}

function timeOf(raw, trip, lines) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !TIME.test(raw.trim())) {
    lines.push(`[WARNING] 🔁 exchange.time ${JSON.stringify(raw)} is not a time "HH:MM": the trip's own time is kept.`);
    return null;
  }
  if (trip?.tripType !== 'SEARCH') {
    lines.push('[WARNING] 🔁 exchange.time is for a SEARCH trip: a trip specification takes the times of its legs, so it is not used.');
    return null;
  }
  return raw.trim();
}

/**
 * What the exchange asks for, read from the scenario.
 * @param {object} scenario
 * @param {object[]} tripRequirements  the data file's
 * @param {object} saleTrip            the sale's trip requirement
 * @returns {{ plan: object|null, lines: string[], problem?: string }}
 *   `plan` is null when the scenario has no exchange block, or one that
 *   changes nothing; `problem` names a trip id the data file does not have.
 */
function exchangePlan(scenario, tripRequirements, saleTrip) {
  const block = scenario?.exchange;
  const lines = [];
  if (block == null) return { plan: null, lines };
  if (!isObj(block)) {
    lines.push('[WARNING] 🔁 exchange is not an object: the exchange asks for the sale\'s trip.');
    return { plan: null, lines };
  }
  let trip = saleTrip;
  const id = block.tripRequirementId;
  if (id != null && id !== '') {
    trip = listOf(tripRequirements).find((t) => isObj(t) && t.id === id) || null;
    if (!trip) {
      return {
        plan: null,
        lines,
        problem: `exchange.tripRequirementId ${JSON.stringify(id)} names no trip of the data file (tripRequirements[].id)`,
      };
    }
  }
  const offsetDays = offsetOf(block.dateOffsetDays, lines);
  const time = timeOf(block.time, trip, lines);
  const criteria = criteriaOf(block.offerSearchCriteria, lines);
  if (trip === saleTrip && offsetDays === 0 && !time && !criteria) {
    lines.push('[INFO] 🔁 The exchange block changes nothing: the exchange asks for the sale\'s trip with the sale\'s criteria.');
    return { plan: null, lines };
  }
  return { plan: { trip, otherTrip: trip !== saleTrip, offsetDays, time, criteria }, lines };
}

/** A date "YYYY-MM-DD" moved by n days, on the UTC calendar. */
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A SEARCH trip requirement leaving at `time` instead of its own: the
 * departure's hour and minute replaced, the arrival left out (it no longer
 * goes with the departure). A copy; the data file's is not changed.
 */
function withTime(tripRequirement, time) {
  if (!time || tripRequirement?.tripType !== 'SEARCH' || !isObj(tripRequirement.trip)) return tripRequirement;
  const start = String(tripRequirement.trip.startDatetime || '');
  // The clock after the date ("%TRIP_DATE%T08:00:00+01:00"): the "T" of the
  // placeholder is not it.
  const clock = /T\d{2}:\d{2}/;
  if (!clock.test(start)) return tripRequirement;
  const trip = { ...tripRequirement.trip, startDatetime: start.replace(clock, `T${time}`) };
  delete trip.endDatetime;
  return { ...tripRequirement, trip };
}

/**
 * The trip asked, to compare with the provider's answer.
 * @returns {{ from, to, date, departure, trains: string[], kind }}
 */
function askedTrip(tripRequirement, date) {
  const clock = (value) => {
    const m = /T(\d{2}:\d{2})/.exec(String(value || ''));
    return m ? m[1] : null;
  };
  if (tripRequirement?.tripType === 'SPECIFICATION') {
    const legs = listOf(tripRequirement.legs);
    return {
      from: legs[0]?.origin || null,
      to: legs.at(-1)?.destination || null,
      date,
      departure: clock(legs[0]?.startDatetime),
      trains: legs.map((l) => l?.vehicleNumber).filter(isText).map(String),
      kind: 'SPECIFICATION',
    };
  }
  const trip = tripRequirement?.trip || {};
  return {
    from: trip.origin || null,
    to: trip.destination || null,
    date,
    departure: clock(trip.startDatetime),
    trains: isText(trip.vehicleNumber) ? [String(trip.vehicleNumber).trim()] : [],
    kind: 'SEARCH',
  };
}

/** The asked trip in words, for a check's name. */
function describeAsked(asked) {
  const train = asked.trains.length > 0 ? `, train ${asked.trains.join('+')}` : '';
  return `${asked.from} → ${asked.to} on ${asked.date}${train}`;
}

/**
 * How an OSDM trip differs from the trip asked.
 * @returns {{ problems: string[], train: string|null }} `train` says another
 *   train runs it (graded apart: a search may be answered with another train).
 */
function tripDifferences(trip, asked) {
  const problems = [];
  const { from, to } = endsOf(trip);
  if (!sameStopPlace(from, asked.from)) problems.push(`it leaves from ${from || 'no stop place'}, not ${asked.from}`);
  if (!sameStopPlace(to, asked.to)) problems.push(`it goes to ${to || 'no stop place'}, not ${asked.to}`);
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(startOf(trip) || ''));
  if (!day) problems.push('it gives no departure time');
  else if (day[0] !== asked.date) problems.push(`it leaves on ${day[0]}, not ${asked.date}`);
  const numbers = vehicleNumbersOf(trip);
  const missing = asked.trains.filter((t) => !numbers.includes(t));
  const train = numbers.length > 0 && missing.length > 0
    ? `it runs train ${numbers.join('+')}, not ${missing.join('+')}`
    : null;
  return { problems, train };
}

// The trips an exchange offer or a booked offer covers: its own coverage, else
// its parts'.
function coveredIds(offer, partLists) {
  const own = offer?.tripCoverage?.coveredTripId;
  if (own) return [own];
  const parts = partLists.flatMap((k) => listOf(offer?.[k]));
  return [...new Set(parts.map((p) => p?.tripCoverage?.coveredTripId).filter(Boolean))];
}

// The best trip among those covered: the first that matches, else the first.
function bestTrip(ids, trips, asked) {
  const found = ids.map((id) => trips.find((t) => t?.id === id)).filter(Boolean);
  const judged = found.map((trip) => ({ trip, ...tripDifferences(trip, asked) }));
  return judged.find((j) => j.problems.length === 0) || judged[0] || null;
}

function tripChecks(subject, judged, asked) {
  const checks = [{
    name: `🔁 ${subject} the trip asked: ${describeAsked(asked)}`,
    ok: judged.problems.length === 0,
    message: `trip ${judged.trip.id}: ${judged.problems.join('; ')}`,
  }];
  if (judged.problems.length === 0 && judged.train) {
    checks.push({
      name: `🔁 ${subject} the train asked (${asked.trains.join('+')})`,
      ok: false,
      // A search is answered with the trains running then; a specification
      // names its train.
      level: asked.kind === 'SEARCH' ? 'warn' : undefined,
      message: `trip ${judged.trip.id}: ${judged.train}`,
    });
  }
  return checks;
}

/**
 * Step 10: the exchange offers against the trip asked.
 * @returns {{ checks: object[], lines: string[], offerId: string|null }}
 *   `offerId` is the offer to take when it is not the first.
 */
function checkExchangeOffers(body, asked) {
  const offers = listOf(body?.exchangeOffers);
  const trips = listOf(body?.trips);
  if (offers.length === 0) return { checks: [], lines: [], offerId: null };
  if (trips.length === 0) {
    return {
      checks: [],
      lines: ['[INFO] 🔁 The exchange offers name no trip (trips is optional in the answer): the trip of the exchange is checked in the booking once it is confirmed.'],
      offerId: null,
    };
  }
  const judged = offers.map((offer) => ({ offer, best: bestTrip(coveredIds(offer, ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts']), trips, asked) }));
  const fit = judged.find((j) => j.best && j.best.problems.length === 0);
  const lines = [];
  let offerId = null;
  if (fit && fit.offer !== offers[0]) {
    offerId = fit.offer.offerId;
    lines.push(`[INFO] 🔁 Exchange offer ${offerId} is taken: it covers the trip asked, the first offer does not.`);
  }
  const shown = fit || judged.find((j) => j.best) || null;
  if (!shown) {
    return {
      checks: [{ name: `🔁 The exchange offers cover the trip asked: ${describeAsked(asked)}`, ok: false, level: 'warn', message: 'no exchange offer names a trip of the answer in its trip coverage' }],
      lines,
      offerId,
    };
  }
  return { checks: tripChecks('The exchange offers cover', shown.best, asked), lines, offerId };
}

/**
 * Step 15: the booked offer the confirmed exchange added, against the trip
 * asked. `addedIds` are the ids of the parts the exchange added.
 */
function checkExchangedBooking(data, addedIds, asked) {
  const booking = data?.booking ? data.booking : data;
  const added = new Set(listOf(addedIds).map(String));
  const offers = listOf(booking?.bookedOffers)
    .filter((o) => PART_LISTS.some((k) => listOf(o?.[k]).some((p) => added.has(String(p?.id)))));
  const subject = 'The booked offer of the exchange covers';
  const ids = [...new Set(offers.flatMap((o) => coveredIds(o, PART_LISTS)))];
  const judged = bestTrip(ids, listOf(booking?.trips), asked);
  if (!judged) {
    return [{
      name: `🔁 ${subject} the trip asked: ${describeAsked(asked)}`,
      ok: false,
      level: 'warn',
      message: offers.length === 0
        ? 'the booking holds no booked offer made by the exchange'
        : 'the booking names no trip of the exchange (Booking.trips and the booked offer\'s trip coverage are optional)',
    }];
  }
  return tripChecks(subject, judged, asked);
}

module.exports = {
  CRITERIA_KEYS, exchangePlan, addDays, withTime, askedTrip, describeAsked, tripDifferences,
  checkExchangeOffers, checkExchangedBooking,
};
