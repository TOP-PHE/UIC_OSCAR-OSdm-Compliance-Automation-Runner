/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * specifiedCarriers.js — the carrier a trip specification asks for, against
 * the one the provider's answer names (#1021). Pure.
 *
 * OSDM requires a specified leg's carrier (DatedJourney.carriers) but does not
 * say the answer repeats it. A provider answering another carrier may be
 * offering another train than the one asked: a WARNING, never a failure.
 * Nothing is said when either side names no carrier. References are compared
 * without case.
 */

const arr = (v) => (Array.isArray(v) ? v : []);
const refsOf = (service) => arr(service?.carriers)
  .map((c) => (typeof c?.ref === 'string' ? c.ref.trim() : ''))
  .filter(Boolean);
const timedLegs = (legs) => arr(legs).filter((leg) => leg?.timedLeg);

/**
 * The trip of the answer a specification is compared with: the one the chosen
 * offer covers, else the first with as many timed legs; null when none.
 */
function answeredTrip(trips, legCount, coveredTripId) {
  const list = arr(trips);
  return (coveredTripId && list.find((t) => t?.id === coveredTripId))
    || list.find((t) => timedLegs(t?.legs).length === legCount)
    || null;
}

/**
 * The legs whose carriers differ, [{ leg, asked, offered }]: the first trip
 * specification asked against the trip answered, leg by leg; a leg differs
 * when both sides name carriers and none is the same.
 */
function carrierDifferences(specs, trips, coveredTripId) {
  const asked = timedLegs(arr(specs)[0]?.legs);
  if (!asked.length) return [];
  const trip = answeredTrip(trips, asked.length, coveredTripId);
  if (!trip) return [];
  const offered = timedLegs(trip.legs);
  const out = [];
  asked.forEach((leg, i) => {
    const want = refsOf(leg.timedLeg.service);
    const got = refsOf(offered[i]?.timedLeg?.service);
    const same = want.some((w) => got.some((g) => g.toLowerCase() === w.toLowerCase()));
    if (want.length && got.length && !same) out.push({ leg: i + 1, asked: want, offered: got });
  });
  return out;
}

/** The warning for one leg whose carriers differ. */
function carrierWarning(d) {
  return `Leg ${d.leg}: the trip specification asks for a train of ${d.asked.join(', ')}, the provider's answer names ${d.offered.join(', ')}. `
    + 'It may be offering another train than the one asked.';
}

module.exports = { answeredTrip, carrierDifferences, carrierWarning };
