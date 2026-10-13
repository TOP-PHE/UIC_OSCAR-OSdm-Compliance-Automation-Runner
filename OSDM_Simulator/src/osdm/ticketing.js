// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ticketing.js — how a booking is divided into tickets (#697).
 *
 * By default a booking has one ticket (fulfillment) per direction, holding
 * every passenger, and an admission covers the whole trip. Real providers
 * divide it otherwise, and a partial refund by passenger or by leg can only
 * be shown on such a booking. On a provider whose profile sets `ticketing`,
 * a trip from one of its stop places is sold so:
 *
 *   perPassengerFrom   one ticket per passenger
 *   perLegFrom         one admission per passenger and leg, one ticket per leg
 *
 * On those bookings a refund scoped by passenger or booking part
 * (refundSpecifications) is accepted, within the ticket it names.
 */

const MODE = Symbol('ticketing');

/** 'per-passenger', 'per-leg' or null: how the trips' tickets are made. */
function modeOf(trips, provider) {
  const rules = provider.ticketing;
  if (!rules) return null;
  const from = (ref) => ref && trips.some((t) => t.origin?.stopPlaceRef === ref);
  if (from(rules.perPassengerFrom)) return 'per-passenger';
  if (from(rules.perLegFrom)) return 'per-leg';
  return null;
}

function keep(booking, mode) {
  Object.defineProperty(booking, MODE, { value: mode });
}

const of = (booking) => booking[MODE] || null;

const legMs = (leg) => Date.parse(leg.timedLeg.end.serviceArrival.timetabledTime) - Date.parse(leg.timedLeg.start.serviceDeparture.timetabledTime);

/**
 * The admissions of a direction sold per leg: each admission covering the
 * whole trip becomes one per leg, priced by the leg's share of the travel
 * time; the last leg takes what rounding leaves.
 */
function splitByLeg(trip, admissions) {
  if (trip.legs.length < 2) return admissions;
  const total = trip.legs.reduce((sum, leg) => sum + legMs(leg), 0);
  return admissions.flatMap((part) => {
    let left = part.amount;
    return trip.legs.map((leg, i) => {
      const amount = i === trip.legs.length - 1 ? left : Math.round(part.amount * legMs(leg) / total);
      left -= amount;
      return { ...part, amount, legIds: [leg.id] };
    });
  });
}

/** The parts of each ticket: by passenger, or by the legs they cover. */
function groupsOf(parts, mode) {
  const keyOf = mode === 'per-leg'
    ? (part) => (part.tripCoverage?.coveredLegIds || []).join('+')
    : (part) => (part.passengerIds || []).join('+');
  const groups = new Map();
  for (const part of parts) {
    const key = keyOf(part);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  return [...groups.values()];
}

module.exports = { modeOf, keep, of, splitByLeg, groupsOf };
