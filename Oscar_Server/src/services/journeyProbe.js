// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * journeyProbe.js — does the provider offer a Test Data journey? (#813). Pure.
 *
 * A JOURNEY resource chains train services of Test Data. The route
 * (company-test-resources.js) searches the provider's trips from its first
 * stop place to its last, at its first departure, on the next days its
 * trains all run, and compares each answer with the journey here:
 *
 *   found        a trip with the same legs: same stop places (leading zeros
 *                and the URN form aside), same train numbers, same times
 *                (to the minute, on the clock as written)
 *   differences  the trip closest to the journey, and what differs
 *   notFound     no trip has the journey's legs; what was offered instead
 */

const { journeyToTripLegs, resourceData, normalizeTrainData } = require('../../public/js/trip-apply.js');
const { stopKey, commonDays } = require('../../public/js/journey-planner.js');
const { tripLegRecords, dayOfWeekCode } = require('./timetable-discovery');

const DAYS_TO_PROBE = 3;
const HORIZON_DAYS = 14;
const TRIPS_SHOWN = 5;

// "HH:MM" of "HH:MM[:SS][offset]" or of an ISO date-time; '' when none.
function clock(value) {
  const text = String(value || '');
  const m = /(?:^|T)(\d{2}):(\d{2})/.exec(text);
  return m ? `${m[1]}:${m[2]}` : '';
}

// A train number as compared: letters and digits only, upper case.
const bareNumber = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

// Train numbers of a leg ("1061" or "1061/1062" when the provider lists several).
const numbersOf = (v) => String(v || '').split('/').map(bareNumber).filter(Boolean);

/**
 * The journey's legs as the probe reads them, from Test Data:
 * [{ origin, destination, departure, arrival, vehicleNumber }], and the days
 * all its trains run (null = every day). `resources` holds the TRAIN entries.
 */
function journeyPlan(journey, resources) {
  const legs = journeyToTripLegs(journey, resources).map((l) => ({
    origin: l.origin || '',
    destination: l.destination || '',
    departure: clock(l.startDatetime),
    arrival: clock(l.endDatetime),
    vehicleNumber: l.vehicleNumber || '',
  }));
  const wanted = Array.isArray(resourceData(journey).legs) ? resourceData(journey).legs.length : 0;
  let days = null;
  for (const leg of Array.isArray(resourceData(journey).legs) ? resourceData(journey).legs : []) {
    const train = (resources || []).find((r) => r && String(r.id) === String(leg?.trainResourceId));
    if (!train) continue;
    const d = normalizeTrainData(structuredClone(resourceData(train)));
    const own = Array.isArray(d.daysOfWeek) && d.daysOfWeek.length ? d.daysOfWeek : null;
    days = commonDays(days, own);
  }
  return { legs, missingLegs: wanted - legs.length, days };
}

/**
 * The next `count` dates (YYYY-MM-DD, from `from`, within HORIZON_DAYS) on
 * which `days` (null = every day) has the weekday.
 */
function probeDates(days, from, count = DAYS_TO_PROBE) {
  const base = from instanceof Date ? from : new Date(from);
  const out = [];
  for (let i = 0; i < HORIZON_DAYS && out.length < count; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    const date = d.toISOString().slice(0, 10);
    if (days === null || days.includes(dayOfWeekCode(date))) out.push(date);
  }
  return out;
}

// What differs between journey leg `want` and trip leg `got`, as sentences.
function legDifferences(n, want, got) {
  const out = [];
  if (stopKey(want.origin) !== stopKey(got.originURN)) out.push(`leg ${n} leaves from ${short(got.originURN)}, not ${short(want.origin)}`);
  if (stopKey(want.destination) !== stopKey(got.destinationURN)) out.push(`leg ${n} goes to ${short(got.destinationURN)}, not ${short(want.destination)}`);
  const numbers = numbersOf(got.vehicleNumber);
  if (want.vehicleNumber && numbers.length && !numbers.includes(bareNumber(want.vehicleNumber))) {
    out.push(`leg ${n} is train ${got.vehicleNumber}, not ${want.vehicleNumber}`);
  }
  if (want.departure && clock(got.departureTime) && want.departure !== clock(got.departureTime)) {
    out.push(`leg ${n} leaves at ${clock(got.departureTime)}, not ${want.departure}`);
  }
  if (want.arrival && clock(got.arrivalTime) && want.arrival !== clock(got.arrivalTime)) {
    out.push(`leg ${n} arrives at ${clock(got.arrivalTime)}, not ${want.arrival}`);
  }
  return out;
}

// The stop place's code, for a sentence.
function short(urn) { return String(urn || '?').split(':').pop(); }

// The differences of a trip (leg records) from the journey's legs.
function tripDifferences(legs, trip) {
  if (trip.length !== legs.length) {
    return [`${trip.length} leg(s) instead of ${legs.length}`];
  }
  return legs.flatMap((want, i) => legDifferences(i + 1, want, trip[i]));
}

// One trip in words: "5454212 → 5454300 (1061, 04:05–04:38) · 5454300 → …".
function describeTrip(trip) {
  return trip.map((l) => `${short(l.originURN)} → ${short(l.destinationURN)} (${[l.vehicleNumber, `${clock(l.departureTime)}–${clock(l.arrivalTime)}`].filter(Boolean).join(', ')})`).join(' · ');
}

/**
 * Compare a trip search answer (`answer`, with `trips[]`) with the journey's
 * legs. { outcome: 'found' | 'differences' | 'notFound', differences, offered }.
 * The searched origin and destination stand for the first and last stop
 * places a provider may name with its own references.
 */
function compareAnswer(legs, answer) {
  const opts = { searchedOrigin: legs[0]?.origin, searchedDestination: legs.at(-1)?.destination };
  const trips = (Array.isArray(answer?.trips) ? answer.trips : []).map((t) => tripLegRecords(t, opts)).filter((t) => t.length);
  const offered = trips.slice(0, TRIPS_SHOWN).map(describeTrip);
  if (trips.length === 0) return { outcome: 'notFound', differences: [], offered, trips: 0 };
  let best = null;
  for (const trip of trips) {
    const differences = tripDifferences(legs, trip);
    if (differences.length === 0) return { outcome: 'found', differences: [], offered: [describeTrip(trip)], trips: trips.length };
    const sameShape = trip.length === legs.length;
    const score = (sameShape ? 0 : 100) + differences.length;
    if (!best || score < best.score) best = { score, differences, trip };
  }
  if (best.trip.length !== legs.length) return { outcome: 'notFound', differences: [], offered, trips: trips.length };
  return { outcome: 'differences', differences: best.differences, offered: [describeTrip(best.trip), ...offered.filter((o) => o !== describeTrip(best.trip))].slice(0, TRIPS_SHOWN), trips: trips.length };
}

/** One line for the whole probe, from its days. */
function probeSummary(days) {
  const answered = days.filter((d) => d.outcome);
  if (answered.length === 0) return 'The provider answered no search: see each day.';
  const found = answered.filter((d) => d.outcome === 'found').length;
  if (found === answered.length) return `Offered on every day searched (${found}).`;
  if (found) return `Offered on ${found} of ${answered.length} day(s) searched.`;
  return answered.some((d) => d.outcome === 'differences')
    ? 'Not offered as defined: a close trip differs (see each day).'
    : 'Not offered: no trip with these legs (see what the provider offers instead).';
}

module.exports = { journeyPlan, probeDates, compareAnswer, probeSummary, clock, DAYS_TO_PROBE };
